// AK Tracker — Alpha.Kore team task tracker
// Express + Postgres (Supabase). DATABASE_URL must be a Postgres connection string, e.g.
//   postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres   (direct connection, not the pooler)
// Runs standalone (`npm start`) or inside the desktop app (desktop/main.js calls start()).

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PRIORITIES = ['critical', 'medium', 'low'];
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', critical: 'Critical', medium: 'Medium', low: 'Low' };
const PALETTE = ['#7c5cff', '#0c8599', '#e8590c', '#d6336c', '#3da5ff', '#a3d94a', '#f5c518', '#b46cff'];
const SESSION_DAYS = 30;
const SEED = [
  { username: 'hitarth', display_name: 'Hitarth', password: 'Hitarth@AK26' },
  { username: 'parth', display_name: 'Parth', password: 'Parth@AK26' },
  { username: 'harsh', display_name: 'Harsh', password: 'Harsh@AK26' },
  { username: 'het', display_name: 'Het', password: 'Het@AK26' },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  shift TEXT DEFAULT '',
  current_note TEXT DEFAULT '',
  current_task_id INTEGER,
  is_live INTEGER DEFAULT 0,
  live_since TEXT,
  last_seen TEXT,
  feed_seen TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'todo',
  description TEXT DEFAULT '',
  do_not_touch TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS updates (
  id SERIAL PRIMARY KEY,
  task_id INTEGER,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT DEFAULT '',
  do_not_touch TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  meta TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acks (update_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (update_id, user_id));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO meta (k, v) VALUES ('rev', 0) ON CONFLICT (k) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_updates_created ON updates(created_at);
CREATE INDEX IF NOT EXISTS idx_updates_task ON updates(task_id);
`;

const now = () => new Date().toISOString();
const str = (v, max = 2000) => (typeof v === 'string' ? v : '').trim().slice(0, max);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// '?' placeholders (kept from the original SQLite-style call sites) -> Postgres '$1','$2',...
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }
function maskUrl(u) { return u.replace(/:[^:@/]*@/, ':****@'); }

async function start(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3000);
  const host = opts.host || process.env.HOST || '127.0.0.1';
  const registerCode = opts.registerCode || process.env.REGISTER_CODE || 'alphakore';
  const url = opts.dbUrl || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to your Supabase Postgres connection string (postgresql://...)');
  const isLocal = /^postgres(ql)?:\/\/[^/@]*@?(localhost|127\.0\.0\.1)/.test(url);
  const pool = new Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });

  // ---------- tiny DB helpers ----------
  const all = async (sql, args = []) => (await pool.query(toPg(sql), args)).rows;
  const one = async (sql, args = []) => (await all(sql, args))[0];
  const run = (sql, args = []) => pool.query(toPg(sql), args);
  async function batchRun(queries) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const q of queries) await c.query(toPg(q.sql), q.args);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }

  await pool.query(SCHEMA);
  if ((await one('SELECT COUNT(*) AS c FROM users')).c === '0' || (await one('SELECT COUNT(*) AS c FROM users')).c === 0) {
    for (const [i, u] of SEED.entries()) {
      await run('INSERT INTO users (username, display_name, pass_hash, color, created_at) VALUES (?,?,?,?,?) ON CONFLICT (lower(username)) DO NOTHING',
        [u.username, u.display_name, hashPassword(u.password), PALETTE[i], now()]);
    }
    console.log('Seeded 4 team accounts (see README for passwords).');
  }

  // ---------- live sync ----------
  // Every write bumps meta.rev in the shared DB. Each running server (one per laptop) polls it
  // and pushes a Server-Sent Event to its own browser window(s) when it changes.
  const clients = new Set();
  let lastRev = (await one("SELECT v FROM meta WHERE k='rev'")).v;
  const push = () => { for (const res of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`); };
  async function changed() {
    await run("UPDATE meta SET v = v + 1 WHERE k='rev'");
    lastRev = (await one("SELECT v FROM meta WHERE k='rev'")).v;
    push();
  }
  const pollMs = Number(opts.pollMs || process.env.POLL_MS || 3000);
  const poller = setInterval(async () => {
    if (!clients.size) return;
    try {
      const r = (await one("SELECT v FROM meta WHERE k='rev'")).v;
      if (r !== lastRev) { lastRev = r; push(); }
    } catch (e) { /* offline: try again next tick */ }
  }, pollMs);
  const pinger = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

  async function logUpdate({ task_id = null, user_id, kind, note = '', do_not_touch = '', tags = [], meta = '' }) {
    await run('INSERT INTO updates (task_id, user_id, kind, note, do_not_touch, tags, meta, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [task_id, user_id, kind, note, do_not_touch, JSON.stringify(tags || []), meta, now()]);
  }
  async function cleanTags(tags, selfId) {
    if (!Array.isArray(tags)) return [];
    const valid = new Set((await all('SELECT id FROM users')).map((r) => r.id));
    return [...new Set(tags.map(Number))].filter((id) => valid.has(id) && id !== selfId);
  }
  const getTask = (id) => one('SELECT * FROM tasks WHERE id = ?', [id]);
  const userExists = async (id) => !!(await one('SELECT 1 AS x FROM users WHERE id = ?', [id]));
  async function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', [token, userId, now()]);
    res.setHeader('Set-Cookie', `ak_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
      (process.env.SECURE_COOKIE === '1' ? '; Secure' : ''));
  }

  // ---------- app ----------
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // async error → 500

  const auth = h(async (req, res, next) => {
    const token = parseCookies(req).ak_session;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const s = await one('SELECT * FROM sessions WHERE token = ?', [token]);
    if (!s || Date.now() - new Date(s.created_at).getTime() > SESSION_DAYS * 86400000) return res.status(401).json({ error: 'Session expired' });
    req.user = await one('SELECT * FROM users WHERE id = ?', [s.user_id]);
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    req.token = token;
    run('UPDATE users SET last_seen = ? WHERE id = ?', [now(), req.user.id]).catch(() => {});
    next();
  });

  app.post('/api/login', h(async (req, res) => {
    const u = await one('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [str(req.body.username, 50)]);
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (!u || !checkPassword(pw, u.pass_hash)) return res.status(401).json({ error: 'Wrong username or password' });
    await startSession(res, u.id);
    res.json({ ok: true });
  }));

  app.post('/api/register', h(async (req, res) => {
    const username = str(req.body.username, 30).toLowerCase();
    const display_name = str(req.body.display_name, 40) || username;
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (str(req.body.code, 100) !== registerCode) return res.status(403).json({ error: 'Invalid team invite code' });
    if (!/^[a-z0-9_.-]{2,30}$/.test(username)) return res.status(400).json({ error: 'Username: 2–30 chars, letters/numbers/._-' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await one('SELECT 1 AS x FROM users WHERE LOWER(username) = LOWER(?)', [username])) return res.status(409).json({ error: 'Username already taken' });
    const count = (await one('SELECT COUNT(*) AS c FROM users')).c;
    const r = await run('INSERT INTO users (username, display_name, pass_hash, color, created_at) VALUES (?,?,?,?,?) RETURNING id',
      [username, display_name, hashPassword(password), PALETTE[Number(count) % PALETTE.length], now()]);
    await startSession(res, Number(r.rows[0].id));
    await changed();
    res.json({ ok: true });
  }));

  app.post('/api/logout', auth, h(async (req, res) => {
    await run('DELETE FROM sessions WHERE token = ?', [req.token]);
    res.setHeader('Set-Cookie', 'ak_session=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  }));

  app.post('/api/password', auth, h(async (req, res) => {
    if (!checkPassword(String(req.body.current || ''), req.user.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
    const next = req.body.next;
    if (typeof next !== 'string' || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    await run('UPDATE users SET pass_hash = ? WHERE id = ?', [hashPassword(next), req.user.id]);
    res.json({ ok: true });
  }));

  app.get('/api/state', auth, h(async (req, res) => {
    const users = await all('SELECT id, username, display_name, color, shift, current_note, current_task_id, is_live, live_since, last_seen, created_at FROM users ORDER BY id');
    const tasks = await all('SELECT * FROM tasks ORDER BY updated_at DESC');
    const updates = (await all('SELECT * FROM updates ORDER BY created_at DESC, id DESC LIMIT 500')).map((u) => ({ ...u, tags: JSON.parse(u.tags || '[]') }));
    const me = users.find((u) => u.id === req.user.id);
    // "For you": heads-ups tagging me, not acknowledged, on tasks that aren't done
    const acked = new Set((await all('SELECT update_id FROM acks WHERE user_id = ?', [req.user.id])).map((r) => r.update_id));
    const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const for_me = (await all("SELECT * FROM updates WHERE do_not_touch <> '' AND user_id <> ? ORDER BY created_at DESC LIMIT 300", [req.user.id]))
      .map((u) => ({ ...u, tags: JSON.parse(u.tags || '[]') }))
      .filter((u) => u.tags.includes(req.user.id) && !acked.has(u.id) && !(u.task_id && doneIds.has(u.task_id)));
    // "What's new": what others did recently (last 14 days) that I haven't marked seen
    const forMeIds = new Set(for_me.map((u) => u.id));
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const new_for_me = (await all("SELECT * FROM updates WHERE user_id <> ? AND kind <> 'headsup' AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 200", [req.user.id, since]))
      .filter((u) => !acked.has(u.id) && !forMeIds.has(u.id)).slice(0, 60)
      .map((u) => ({ ...u, tags: JSON.parse(u.tags || '[]') }));
    res.json({ me: { ...me, feed_seen: req.user.feed_seen }, users, tasks, updates, for_me, new_for_me });
  }));

  app.get('/api/stream', auth, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // my status + LIVE toggle
  app.post('/api/me/status', auth, h(async (req, res) => {
    const me = req.user;
    const offNote = str(req.body.off_note, 500);
    const note = (!req.body.is_live && me.is_live && offNote) ? offNote : str(req.body.current_note, 500);
    const shift = req.body.shift !== undefined ? str(req.body.shift, 60) : me.shift;
    let taskId = req.body.current_task_id ? Number(req.body.current_task_id) : null;
    if (taskId && !(await getTask(taskId))) taskId = null;
    const live = req.body.is_live ? 1 : 0;
    const wasLive = !!me.is_live;
    const liveSince = live ? (wasLive ? me.live_since : now()) : null;
    await run('UPDATE users SET current_note=?, shift=?, current_task_id=?, is_live=?, live_since=? WHERE id=?',
      [note, shift, taskId, live, liveSince, me.id]);
    if (live && !wasLive) {
      await logUpdate({ task_id: taskId, user_id: me.id, kind: 'live_on', note });
      if (taskId) {
        const t = await getTask(taskId);
        if (t.status !== 'in_progress' && t.status !== 'done') await run("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?", [now(), taskId]);
      }
    } else if (!live && wasLive) {
      await logUpdate({ task_id: me.current_task_id, user_id: me.id, kind: 'live_off', note: offNote });
    } else if (note !== me.current_note || taskId !== me.current_task_id) {
      await logUpdate({ task_id: taskId, user_id: me.id, kind: 'focus', note });
    }
    await changed();
    res.json({ ok: true });
  }));

  app.post('/api/me/feed-seen', auth, h(async (req, res) => {
    await run('UPDATE users SET feed_seen = ? WHERE id = ?', [now(), req.user.id]);
    res.json({ ok: true });
  }));

  // heads-up: "don't touch / don't push" → shows in that person's "For you"
  app.post('/api/headsup', auth, h(async (req, res) => {
    const to = await one('SELECT * FROM users WHERE id = ?', [Number(req.body.to_user_id)]);
    if (!to || to.id === req.user.id) return res.status(400).json({ error: 'Pick a teammate' });
    const message = str(req.body.message, 500);
    if (!message) return res.status(400).json({ error: 'Write a message' });
    let taskId = req.body.task_id ? Number(req.body.task_id) : to.current_task_id;
    if (taskId && !(await getTask(taskId))) taskId = null;
    await logUpdate({ task_id: taskId, user_id: req.user.id, kind: 'headsup', do_not_touch: message, tags: [to.id] });
    await changed();
    res.json({ ok: true });
  }));

  app.post('/api/updates/:id/ack', auth, h(async (req, res) => {
    const u = await one('SELECT id FROM updates WHERE id = ?', [Number(req.params.id)]);
    if (!u) return res.status(404).json({ error: 'Not found' });
    await run('INSERT INTO acks (update_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT (update_id, user_id) DO NOTHING', [u.id, req.user.id, now()]);
    res.json({ ok: true });
  }));

  app.post('/api/updates/seen', auth, h(async (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 500);
    if (ids.length) await batchRun(ids.map((id) => ({ sql: 'INSERT INTO acks (update_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT (update_id, user_id) DO NOTHING', args: [id, req.user.id, now()] })));
    res.json({ ok: true });
  }));

  // tasks
  app.post('/api/tasks', auth, h(async (req, res) => {
    const title = str(req.body.title, 200);
    const project = str(req.body.project, 80);
    if (!title || !project) return res.status(400).json({ error: 'Task and project are required' });
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
    let owner = Number(req.body.owner_id) || req.user.id;
    if (!(await userExists(owner))) owner = req.user.id;
    const t = now();
    const r = await run('INSERT INTO tasks (title, project, owner_id, priority, status, description, do_not_touch, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id',
      [title, project, owner, priority, status, str(req.body.description), str(req.body.do_not_touch, 500), t, t, status === 'done' ? t : null]);
    const id = Number(r.rows[0].id);
    await logUpdate({ task_id: id, user_id: req.user.id, kind: 'created', note: str(req.body.description),
      do_not_touch: str(req.body.do_not_touch, 500), tags: await cleanTags(req.body.tags, req.user.id) });
    await changed();
    res.json({ ok: true, id });
  }));

  app.post('/api/tasks/:id/update', auth, h(async (req, res) => {
    const task = await getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const note = str(req.body.note);
    const dnt = req.body.do_not_touch !== undefined ? str(req.body.do_not_touch, 500) : task.do_not_touch;
    const status = STATUSES.includes(req.body.status) ? req.body.status : task.status;
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : task.priority;
    const changes = [];
    if (status !== task.status) changes.push(`${LABEL[task.status]} → ${LABEL[status]}`);
    if (priority !== task.priority) changes.push(`priority ${LABEL[task.priority]} → ${LABEL[priority]}`);
    if (dnt !== task.do_not_touch) changes.push(dnt ? 'heads-up updated' : 'heads-up cleared');
    if (!note && !changes.length) return res.status(400).json({ error: 'Nothing to update — write a note or change something' });
    const t = now();
    await run('UPDATE tasks SET status=?, priority=?, do_not_touch=?, updated_at=?, completed_at=? WHERE id=?',
      [status, priority, status === 'done' ? '' : dnt, t, status === 'done' ? (task.completed_at || t) : null, task.id]);
    await logUpdate({ task_id: task.id, user_id: req.user.id, kind: status !== task.status ? 'status' : 'note', note,
      do_not_touch: status === 'done' ? '' : (dnt !== task.do_not_touch ? dnt : ''),
      tags: await cleanTags(req.body.tags, req.user.id), meta: changes.join(' · ') });
    if (status === 'done' && req.user.is_live && req.user.current_task_id === task.id) {
      // finishing the task you're live on ends your live session (the "finished" entry is enough in the feed)
      await run('UPDATE users SET is_live=0, live_since=NULL, current_note=? WHERE id=?', [note || `Finished ${task.title}`, req.user.id]);
    }
    await changed();
    res.json({ ok: true });
  }));

  app.patch('/api/tasks/:id', auth, h(async (req, res) => {
    const task = await getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const title = str(req.body.title, 200) || task.title;
    const project = str(req.body.project, 80) || task.project;
    const description = req.body.description !== undefined ? str(req.body.description) : task.description;
    let owner = req.body.owner_id ? Number(req.body.owner_id) : task.owner_id;
    if (!(await userExists(owner))) owner = task.owner_id;
    const changes = [];
    if (title !== task.title) changes.push('renamed');
    if (project !== task.project) changes.push(`project → ${project}`);
    if (owner !== task.owner_id) changes.push(`reassigned → ${(await one('SELECT display_name FROM users WHERE id=?', [owner])).display_name}`);
    if (description !== task.description) changes.push('description edited');
    if (!changes.length) return res.json({ ok: true });
    await run('UPDATE tasks SET title=?, project=?, owner_id=?, description=?, updated_at=? WHERE id=?', [title, project, owner, description, now(), task.id]);
    await logUpdate({ task_id: task.id, user_id: req.user.id, kind: 'edit', meta: changes.join(' · '),
      tags: owner !== task.owner_id ? await cleanTags([owner], req.user.id) : [] });
    await changed();
    res.json({ ok: true });
  }));

  app.delete('/api/tasks/:id', auth, h(async (req, res) => {
    const task = await getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    await batchRun([
      { sql: 'UPDATE users SET current_task_id=NULL WHERE current_task_id=?', args: [task.id] },
      { sql: 'DELETE FROM acks WHERE update_id IN (SELECT id FROM updates WHERE task_id=?)', args: [task.id] },
      { sql: 'DELETE FROM updates WHERE task_id=?', args: [task.id] },
      { sql: 'DELETE FROM tasks WHERE id=?', args: [task.id] },
    ]);
    await logUpdate({ user_id: req.user.id, kind: 'deleted', meta: `${task.project} / ${task.title}` });
    await changed();
    res.json({ ok: true });
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error — is the database reachable?' }); });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  const actualPort = server.address().port;
  console.log(`AK Tracker running on http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}  (db: ${maskUrl(url)})`);
  return {
    port: actualPort,
    close: () => { clearInterval(poller); clearInterval(pinger); for (const r of clients) r.end(); server.close(); pool.end(); },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ host: process.env.HOST || '0.0.0.0' }).catch((e) => { console.error(e); process.exit(1); });
}
