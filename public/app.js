// AK Tracker — client (vanilla JS, no build step)
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const PRIO = { critical: 'Critical', medium: 'Medium', low: 'Low' };
  const PRIO_RANK = { critical: 0, medium: 1, low: 2 };
  const STAT = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  const STAT_RANK = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
  const KIND = {
    created: '✚ Created task', status: '⇄ Status change', note: '✎ Update', edit: '✎ Edited',
    deleted: '✕ Deleted task', headsup: '⚠ Heads-up', live_on: '● Went live', live_off: '■ Stopped live', focus: '◎ Changed focus',
  };
  const STALE_HOURS = 12;

  let S = null;              // server state
  let U = new Map();         // users by id
  let T = new Map();         // tasks by id
  let view = 'dashboard';
  let drawerTaskId = null;
  let statusDirty = false;
  let tlMode = 'all';
  let seenSnapshot = null;   // feed_seen value captured when the timeline was opened
  let sort = { key: null, asc: false };

  // ---------- api ----------
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/register')) { showAuth(); throw new Error('Not logged in'); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // ---------- time ----------
  function ago(iso) {
    if (!iso) return '—';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function dur(iso) {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function abs(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

  // ---------- render helpers ----------
  const initials = (n) => (n || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  function av(u, cls = '') {
    if (!u) return `<span class="av ${cls}" style="background:#444">?</span>`;
    return `<span class="av ${cls} ${u.is_live ? 'live' : ''}" style="background:${esc(u.color)}" title="${esc(u.display_name)}">${esc(initials(u.display_name))}</span>`;
  }
  const who = (u, sub = '') => `<span class="who">${av(u)}<span><b>${esc(u ? u.display_name : 'Unknown')}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</span></span>`;
  const prio = (p) => `<span class="pill p-${p}"><span class="d"></span>${PRIO[p]}</span>`;
  function stat(t) {
    const liveOwner = [...U.values()].find((u) => u.is_live && u.current_task_id === t.id);
    if (t.status === 'in_progress' && liveOwner) return `<span class="pill live"><span class="d"></span>LIVE · ${esc(liveOwner.display_name)}</span>`;
    return `<span class="pill s-${t.status}"><span class="d"></span>${STAT[t.status]}</span>`;
  }
  const proj = (p) => `<span class="proj">${esc(p)}</span>`;
  function tagList(ids) {
    if (!ids || !ids.length) return '<span class="dim">—</span>';
    return `<div class="tags">${ids.map((id) => { const u = U.get(id); if (!u) return ''; const me = id === S.me.id;
      return `<span class="tag ${me ? 'me' : ''}" style="color:${esc(u.color)};border-color:${esc(u.color)}55">@${esc(u.display_name)}</span>`; }).join('')}</div>`;
  }
  const emptyRow = (cols, msg) => `<tr class="empty"><td colspan="${cols}">${msg}</td></tr>`;

  // ---------- state ----------
  async function load() {
    try {
      S = await api('GET', '/api/state');
    } catch (e) { return; }
    notifyNewHeadsUps(S.for_me || []);
    U = new Map(S.users.map((u) => [u.id, u]));
    T = new Map(S.tasks.map((t) => [t.id, t]));
    showApp();
    renderAll();
  }
  // desktop / browser notification when a new heads-up for me arrives
  let knownHeadsUps = null;
  function notifyNewHeadsUps(list) {
    const ids = new Set(list.map((u) => u.id));
    if (knownHeadsUps && 'Notification' in window && Notification.permission === 'granted') {
      list.filter((u) => !knownHeadsUps.has(u.id)).forEach((u) => {
        const from = S.users.find((x) => x.id === u.user_id);
        try { new Notification(`Heads-up from ${from ? from.display_name : 'a teammate'}`, { body: u.do_not_touch }); } catch (e) {}
      });
    }
    knownHeadsUps = ids;
  }
  document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, { once: true });

  function renderAll() {
    renderTop(); renderGreeting(); renderMyStatus(); renderForYou(); renderTeam(); renderNew();
    renderFilters(); renderTasks(); renderTimeline();
    if (drawerTaskId) renderDrawerLive();
  }

  const feedSeen = () => S.me.feed_seen || S.me.created_at;
  const newForMe = (since) => S.updates.filter((u) => u.user_id !== S.me.id && u.created_at > since);

  function renderTop() {
    const me = U.get(S.me.id);
    $('#meChip').innerHTML = `${av(me, 'sm')}<span class="nm">${esc(me.display_name)}</span>`;
  }

  // ---------- my status ----------
  function renderMyStatus() {
    const me = U.get(S.me.id);
    const sel = $('#myTask');
    const mine = S.tasks.filter((t) => t.status !== 'done').sort((a, b) => (a.owner_id === me.id ? 0 : 1) - (b.owner_id === me.id ? 0 : 1) || PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
    const keep = statusDirty ? sel.value : String(me.current_task_id || '');
    sel.innerHTML = '<option value="">No task</option>' + mine.map((t) =>
      `<option value="${t.id}">${t.owner_id === me.id ? '' : '(' + esc(U.get(t.owner_id)?.display_name) + ') '}${esc(t.project)} · ${esc(t.title)}</option>`).join('');
    sel.value = keep;
    if (!statusDirty) $('#myNote').value = me.is_live ? (me.current_note || '') : '';
    const btn = $('#liveBtn');
    btn.classList.toggle('on', !!me.is_live);
    btn.querySelector('.lbl').textContent = me.is_live ? `Live · ${dur(me.live_since)}` : 'Go live';
    btn.title = me.is_live ? 'Click to stop' : 'Tell the team you are working on this';
  }
  async function saveStatus(isLive, extra = {}) {
    const me = U.get(S.me.id);
    await api('POST', '/api/me/status', {
      current_note: $('#myNote').value, current_task_id: $('#myTask').value || null,
      is_live: isLive ?? !!me.is_live, ...extra,
    });
    statusDirty = false;
    await load();
  }

  // ---------- home ----------
  function renderGreeting() { /* no greeting in the minimal layout */ }

  // 1. Needs your attention — heads-ups tagging me, until "Got it"
  function renderForYou() {
    const list = S.for_me || [];
    $('#attn').classList.toggle('hidden', !list.length);
    $('#attnCount').textContent = list.length;
    $('#attnBody').innerHTML = list.map((u) => {
      const from = U.get(u.user_id); const t = u.task_id ? T.get(u.task_id) : null;
      return `<tr>
        <td class="from">${esc(from?.display_name || '?')}</td>
        <td class="msg wide">${esc(u.do_not_touch)}${u.note ? `<span class="sub">${esc(u.note)}</span>` : ''}</td>
        <td class="wide">${t ? `<a href="#" data-task="${t.id}" class="tlink">${esc(t.title)} · ${esc(t.project)}</a>` : '—'}</td>
        <td class="nowrap">${ago(u.created_at)}</td>
        <td class="right"><button class="btn-got" data-ack="${u.id}">Got it</button></td>
      </tr>`;
    }).join('');
  }

  // 3. Team — live people first, then offline, me last
  function renderTeam() {
    const meId = S.me.id;
    const rank = (u) => (u.id === meId ? 2 : u.is_live ? 0 : 1);
    const people = [...S.users].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const live = S.users.filter((u) => u.is_live).length;
    $('#liveCount').textContent = live ? `${live} working now` : 'nobody working now';
    $('#teamTable tbody').innerHTML = people.map((u) => {
      const t = u.current_task_id ? T.get(u.current_task_id) : null;
      const isMe = u.id === meId;
      const status = u.is_live
        ? (hoursSince(u.live_since) > STALE_HOURS ? `<span class="st-stale" title="Live a long time — forgot to stop?">Live ${dur(u.live_since)}?</span>` : `<span class="st-live">Live ${dur(u.live_since)}</span>`)
        : `<span class="st-off">Off · ${u.last_seen ? ago(u.last_seen).replace(' ago', '') : '—'}</span>`;
      const doing = u.current_note ? (u.is_live ? esc(u.current_note) : `“${esc(u.current_note)}”`) : '<span class="muted">—</span>';
      return `<tr class="${u.is_live ? '' : 'is-off'}">
        <td class="person">${esc(u.display_name)}${isMe ? ' <span class="you">(you)</span>' : ''}${u.shift ? `<span class="sub" style="font-weight:400">${esc(u.shift)}</span>` : ''}</td>
        <td>${status}</td>
        <td class="cell-note wide">${doing}</td>
        <td class="wide">${t ? `<a href="#" data-task="${t.id}" class="tlink">${esc(t.title)} · <span class="proj-txt">${esc(t.project)}</span></a>` : '<span class="muted">—</span>'}</td>
        <td class="right">${isMe ? '' : `<button class="row-link" data-headsup="${u.id}">Heads-up</button>`}</td>
      </tr>`;
    }).join('') || emptyRow(5, 'No members yet');
  }

  // 4. What's new — what others did, until I click Seen
  function didLabel(u) {
    const done = u.kind === 'status' && / → Done/.test(u.meta);
    switch (u.kind) {
      case 'created': return ['plain', '+ Added'];
      case 'status': return done ? ['done', '✓ Finished'] : ['plain', `→ <span class="muted">${esc((u.meta || '').split(' · ')[0])}</span>`];
      case 'note': return ['plain', '✎ Posted'];
      case 'live_on': return ['live', '● Started'];
      case 'focus': return ['live', '● Switched'];
      case 'live_off': return ['plain', '■ Stopped'];
      case 'edit': return ['plain', '✎ Edited'];
      case 'deleted': return ['plain', '✕ Deleted'];
      default: return ['plain', esc(u.kind)];
    }
  }
  function renderNew() {
    const list = S.new_for_me || [];
    $('#newCount').textContent = list.length ? ` · ${list.length}` : '';
    $('#seenAllBtn').classList.toggle('hidden', !list.length);
    $('#newList').innerHTML = list.map((u) => {
      const who = U.get(u.user_id); const t = u.task_id ? T.get(u.task_id) : null; const [cls, label] = didLabel(u);
      const task = t ? `<a href="#" data-task="${t.id}" class="tlink">${esc(t.title)} · <span class="proj-txt">${esc(t.project)}</span></a>`
        : (u.kind === 'deleted' ? `<span class="muted">${esc(u.meta)}</span>` : '<span class="muted">—</span>');
      return `<tr>
        <td class="nowrap muted" title="${abs(u.created_at)}">${ago(u.created_at).replace(' ago', '')}</td>
        <td class="person">${esc(who?.display_name || '?')}</td>
        <td><span class="did ${cls}">${label}</span></td>
        <td class="wide">${task}</td>
        <td class="cell-note muted wide ${u.note || u.kind === 'edit' ? '' : 'none'}">${u.note ? esc(u.note) : (u.kind === 'edit' ? esc(u.meta) : '—')}</td>
        <td class="right"><button class="row-link" data-seen="${u.id}" type="button">Seen</button></td>
      </tr>`;
    }).join('') || `<tr class="empty"><td colspan="6">You're all caught up.</td></tr>`;
  }
  async function markSeen(ids) {
    if (!ids.length) return;
    S.new_for_me = (S.new_for_me || []).filter((u) => !ids.includes(u.id)); renderNew();
    try { await api('POST', '/api/updates/seen', { ids }); } catch (err) { toast(err.message, true); load(); }
  }

  // ---------- tasks ----------
  function fillSelect(sel, opts, firstLabel) {
    const v = sel.value;
    sel.innerHTML = `<option value="">${firstLabel}</option>` + opts.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join('');
    sel.value = opts.some(([val]) => String(val) === v) ? v : '';
  }
  const projects = () => [...new Set(S.tasks.map((t) => t.project))].sort((a, b) => a.localeCompare(b));
  function renderFilters() {
    const ps = projects().map((p) => [p, p]);
    const us = S.users.map((u) => [u.id, u.display_name]);
    fillSelect($('#fProject'), ps, 'All projects'); fillSelect($('#tlProject'), ps, 'All projects');
    fillSelect($('#fOwner'), us, 'Everyone'); fillSelect($('#tlUser'), us, 'Everyone');
  }
  function renderTasks() {
    const q = $('#fSearch').value.trim().toLowerCase();
    const fp = $('#fProject').value, fo = $('#fOwner').value, fpr = $('#fPriority').value, fs = $('#fStatus').value;
    let list = S.tasks.filter((t) =>
      (!q || (t.title + ' ' + t.project + ' ' + t.description + ' ' + t.do_not_touch).toLowerCase().includes(q)) &&
      (!fp || t.project === fp) && (!fo || t.owner_id === Number(fo)) && (!fpr || t.priority === fpr) &&
      (fs === 'open' ? t.status !== 'done' : !fs || t.status === fs));
    const k = sort.key;
    const val = (t) => k === 'priority' ? PRIO_RANK[t.priority] : k === 'status' ? STAT_RANK[t.status]
      : k === 'owner' ? (U.get(t.owner_id)?.display_name || '') : t[k];
    list.sort(k ? (a, b) => { const x = val(a), y = val(b); const r = x < y ? -1 : x > y ? 1 : 0; return sort.asc ? r : -r; }
      : (a, b) => (a.status === 'done') - (b.status === 'done') || PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || b.updated_at.localeCompare(a.updated_at));
    $$('#tasksTable th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === k); th.classList.toggle('asc', th.dataset.sort === k && sort.asc); });
    $('#tasksTable tbody').innerHTML = list.map((t) => `<tr class="row-${t.priority} ${t.status === 'done' ? 'row-done' : ''}" data-task="${t.id}">
      <td>${prio(t.priority)}</td><td class="task-title">${esc(t.title)}</td><td>${proj(t.project)}</td>
      <td>${who(U.get(t.owner_id))}</td><td>${stat(t)}</td>
      <td class="cell-dnt">${t.do_not_touch ? '⚠ ' + esc(t.do_not_touch) : '<span class="dim">—</span>'}</td>
      <td class="mono">${abs(t.created_at)}</td><td class="mono">${ago(t.updated_at)}</td></tr>`).join('')
      || emptyRow(8, 'No tasks match these filters');
    $('#tasksCount').textContent = `${list.length} task${list.length === 1 ? '' : 's'}`;
  }

  // ---------- timeline ----------
  function updateRow(u, { showTask = true } = {}) {
    const t = u.task_id ? T.get(u.task_id) : null;
    const since = seenSnapshot || feedSeen();
    const isNew = u.user_id !== S.me.id && u.created_at > since;
    const mention = u.tags.includes(S.me.id);
    const taskCell = t ? `<a href="#" data-task="${t.id}" class="task-title" style="color:inherit">${esc(t.title)}</a><span class="meta">${esc(t.project)}</span>`
      : `<span class="dim">${u.kind === 'deleted' ? esc(u.meta) : '—'}</span>`;
    return `<tr class="${isNew ? 'is-new' : ''} ${mention && isNew ? 'is-mention' : ''}">
      <td class="mono">${ago(u.created_at)}<span class="meta">${abs(u.created_at)}</span></td>
      <td>${who(U.get(u.user_id))}</td>
      ${showTask ? `<td>${taskCell}</td>` : ''}
      <td><span class="kind">${KIND[u.kind] || u.kind}</span>${u.meta && u.kind !== 'deleted' ? `<span class="meta">${esc(u.meta)}</span>` : ''}</td>
      <td class="cell-note">${u.note ? esc(u.note) : '<span class="dim">—</span>'}</td>
      <td>${tagList(u.tags)}</td>
      <td class="cell-dnt">${u.do_not_touch ? '⚠ ' + esc(u.do_not_touch) : '<span class="dim">—</span>'}</td></tr>`;
  }
  function renderTimeline() {
    $$('#tlMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === tlMode));
    const fu = $('#tlUser').value, fp = $('#tlProject').value;
    const since = seenSnapshot || feedSeen();
    const list = S.updates.filter((u) => {
      const t = u.task_id ? T.get(u.task_id) : null;
      if (fu && u.user_id !== Number(fu)) return false;
      if (fp && (!t || t.project !== fp)) return false;
      if (tlMode === 'mentions') return u.tags.includes(S.me.id);
      if (tlMode === 'new') return u.user_id !== S.me.id && u.created_at > since;
      return true;
    });
    $('#timelineTable tbody').innerHTML = list.map((u) => updateRow(u)).join('')
      || emptyRow(7, tlMode === 'new' ? 'You are all caught up ✓' : 'No updates yet');
  }

  // ---------- drawer ----------
  function openDrawer(id) {
    const t = T.get(id); if (!t) return;
    drawerTaskId = id;
    const d = $('#drawer');
    d.innerHTML = `<button class="close" id="dClose">×</button>
      <div id="dInfo"></div>
      <section>
        <div class="sec-title">Post an update</div>
        <form id="upForm" class="form-grid">
          <label class="full">What changed? / note for the team
            <textarea name="note" rows="3" maxlength="2000" placeholder="e.g. Merged new schema. Pull before you touch models/. API response shape for /jobs changed."></textarea></label>
          <label>Status<select name="status">${Object.entries(STAT).map(([k, v]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Priority<div class="seg prio" id="upPrio">${Object.entries(PRIO).map(([k, v]) => `<button type="button" data-v="${k}" class="${k === t.priority ? 'active' : ''}">${v}</button>`).join('')}</div></label>
          <label class="full">⚠ Don't touch / heads-up (stays on the board until cleared or task is done)
            <textarea name="dnt" rows="2" maxlength="500" placeholder="e.g. Don't edit payment.js or run migrations until I push tonight">${esc(t.do_not_touch)}</textarea></label>
          <label class="full">Tag people<div class="chips" id="upTags">${tagChips()}</div></label>
          <div class="full row-actions"><button class="btn primary" type="submit">Post update</button></div>
        </form>
      </section>
      <section><div class="sec-title">Task timeline</div><ul class="tl" id="dTl"></ul></section>`;
    $('#drawer').classList.remove('hidden'); $('#drawerBg').classList.remove('hidden');
    $('#dClose').onclick = closeDrawer;
    bindSeg($('#upPrio')); bindChips($('#upTags'));
    $('#upForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', `/api/tasks/${id}/update`, {
          note: f.note.value, status: f.status.value, priority: $('#upPrio .active').dataset.v,
          do_not_touch: f.dnt.value, tags: chipVals($('#upTags')),
        });
        f.note.value = ''; $$('#upTags .chip').forEach((c) => c.classList.remove('on'));
        toast('Update posted'); await load();
        const nt = T.get(id); if (nt) { f.dnt.value = nt.do_not_touch; f.status.value = nt.status; }
      } catch (err) { toast(err.message, true); }
    };
    renderDrawerLive();
  }
  function renderDrawerLive() {
    const t = T.get(drawerTaskId);
    if (!t) { closeDrawer(); return; }
    const owner = U.get(t.owner_id);
    const created = S.updates.find((u) => u.task_id === t.id && u.kind === 'created');
    $('#dInfo').innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">${prio(t.priority)} ${stat(t)} ${proj(t.project)}</div>
      <h3>${esc(t.title)}</h3>
      ${t.description ? `<p class="muted" style="white-space:pre-wrap;margin:6px 0 0">${esc(t.description)}</p>` : ''}
      ${t.do_not_touch ? `<div class="dnt-box"><b>⚠ Heads-up — don't touch</b>${esc(t.do_not_touch)}</div>` : ''}
      <section><dl class="kv">
        <dt>Owner</dt><dd>${who(owner)}</dd>
        <dt>Created</dt><dd>${abs(t.created_at)} ${created ? `by ${esc(U.get(created.user_id)?.display_name)}` : ''}</dd>
        <dt>Last update</dt><dd>${abs(t.updated_at)} (${ago(t.updated_at)})</dd>
        ${t.completed_at ? `<dt>Completed</dt><dd>${abs(t.completed_at)}</dd>` : ''}
      </dl>
      <div class="row-actions" style="justify-content:flex-start">
        <button class="btn small" id="dEdit">Edit details</button>
        <button class="btn small danger" id="dDel">Delete</button>
      </div></section>`;
    $('#dEdit').onclick = () => editTaskModal(t);
    $('#dDel').onclick = () => confirmModal(`Delete “${t.title}”?`, 'This removes the task and its timeline. It cannot be undone.', 'Delete', async () => {
      await api('DELETE', `/api/tasks/${t.id}`); closeDrawer(); toast('Task deleted'); await load();
    });
    const ups = S.updates.filter((u) => u.task_id === t.id);
    $('#dTl').innerHTML = ups.map((u) => `<li>${av(U.get(u.user_id))}
      <div><b>${esc(U.get(u.user_id)?.display_name)}</b> · <span class="kind">${KIND[u.kind] || u.kind}</span></div>
      <div class="when">${abs(u.created_at)} · ${ago(u.created_at)}${u.meta ? ' · ' + esc(u.meta) : ''}</div>
      ${u.note ? `<div class="body">${esc(u.note)}</div>` : ''}
      ${u.do_not_touch ? `<div class="tl-dnt">⚠ ${esc(u.do_not_touch)}</div>` : ''}
      ${u.tags.length ? `<div style="margin-top:6px">${tagList(u.tags)}</div>` : ''}</li>`).join('')
      || '<li class="dim">No history</li>';
  }
  function closeDrawer() { drawerTaskId = null; $('#drawer').classList.add('hidden'); $('#drawerBg').classList.add('hidden'); }

  // ---------- small widgets ----------
  function tagChips() {
    return S.users.filter((u) => u.id !== S.me.id).map((u) =>
      `<button type="button" class="chip" data-id="${u.id}">${av(u, 'sm')}${esc(u.display_name)}</button>`).join('');
  }
  function bindChips(el) { el.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) c.classList.toggle('on'); }); }
  const chipVals = (el) => $$('.chip.on', el).map((c) => Number(c.dataset.id));
  function bindSeg(el) { el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', el).forEach((x) => x.classList.toggle('active', x === b)); }); }

  function openModal(html) { $('#modal').innerHTML = html; $('#modalBg').classList.remove('hidden'); }
  function closeModal() { $('#modalBg').classList.add('hidden'); }
  function confirmModal(title, text, okLabel, onOk) {
    openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="row-actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn danger" id="mOk">${esc(okLabel)}</button></div>`);
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = async () => { try { await onOk(); closeModal(); } catch (e) { toast(e.message, true); } };
  }

  function taskFormHtml(t = {}) {
    const ownerOpts = S.users.map((u) => `<option value="${u.id}" ${(t.owner_id || S.me.id) === u.id ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('');
    return `<datalist id="projList">${projects().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <label class="full">Task<input name="title" maxlength="200" required value="${esc(t.title || '')}" placeholder="e.g. Build resume parser endpoint" /></label>
      <label>Project<input name="project" list="projList" maxlength="80" required value="${esc(t.project || '')}" placeholder="e.g. Delta" /></label>
      <label>Owner<select name="owner_id">${ownerOpts}</select></label>
      <label class="full">Description<textarea name="description" rows="3" maxlength="2000" placeholder="What is this about? Any context the next person needs.">${esc(t.description || '')}</textarea></label>`;
  }
  function newTaskModal() {
    openModal(`<h3>New task</h3><form id="ntForm" class="form-grid">${taskFormHtml()}
      <label>Priority<div class="seg prio" id="ntPrio"><button type="button" data-v="critical">Critical</button><button type="button" data-v="medium" class="active">Medium</button><button type="button" data-v="low">Low</button></div></label>
      <label>Status<select name="status"><option value="todo">To do</option><option value="in_progress" selected>In progress</option><option value="blocked">Blocked</option></select></label>
      <label class="full">⚠ Don't touch / heads-up (optional)<textarea name="dnt" rows="2" maxlength="500" placeholder="e.g. I'm changing the DB schema — don't run migrations"></textarea></label>
      <label class="full">Tag people<div class="chips" id="ntTags">${tagChips()}</div></label>
      <div class="full row-actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" type="submit">Create task</button></div></form>`);
    bindSeg($('#ntPrio')); bindChips($('#ntTags'));
    $('#mCancel').onclick = closeModal;
    $('#ntForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try {
        const r = await api('POST', '/api/tasks', {
          title: f.title.value, project: f.project.value, owner_id: f.owner_id.value, description: f.description.value,
          priority: $('#ntPrio .active').dataset.v, status: f.status.value, do_not_touch: f.dnt.value, tags: chipVals($('#ntTags')),
        });
        closeModal(); toast('Task created'); await load(); openDrawer(r.id);
      } catch (err) { toast(err.message, true); }
    };
    $('#ntForm [name=title]').focus();
  }
  function editTaskModal(t) {
    openModal(`<h3>Edit task</h3><form id="etForm" class="form-grid">${taskFormHtml(t)}
      <div class="full row-actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#mCancel').onclick = closeModal;
    $('#etForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try {
        await api('PATCH', `/api/tasks/${t.id}`, { title: f.title.value, project: f.project.value, owner_id: f.owner_id.value, description: f.description.value });
        closeModal(); toast('Saved'); await load();
      } catch (err) { toast(err.message, true); }
    };
  }
  function stopLiveModal() {
    const me = U.get(S.me.id);
    const t = me.current_task_id ? T.get(me.current_task_id) : null;
    openModal(`<h3>Stop live</h3>
      <form id="slForm" class="stack">
        <label>Leaving a note for the others? (optional — shows next to your name)<textarea name="note" rows="3" maxlength="500" placeholder="e.g. Stopped mid-way on the auth refactor, branch feat/auth. Don't merge it yet."></textarea></label>
        <div class="row-actions">
          <button type="button" class="btn ghost" id="mCancel">Cancel</button>
          ${t && t.status !== 'done' ? `<button type="button" class="btn" id="slDone">Stop & mark “${esc(t.title.slice(0, 28))}” done</button>` : ''}
          <button class="btn primary" type="submit">Stop live (pause)</button>
        </div></form>`);
    $('#mCancel').onclick = closeModal;
    $('#slForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await saveStatus(false, { off_note: e.target.note.value }); closeModal(); toast('You are no longer live'); } catch (err) { toast(err.message, true); }
    };
    if ($('#slDone')) $('#slDone').onclick = async () => {
      try {
        const note = $('#slForm').note.value;
        await api('POST', `/api/tasks/${t.id}/update`, { status: 'done', note });
        statusDirty = false;
        closeModal(); toast('Task done'); await load();
      } catch (err) { toast(err.message, true); }
    };
  }
  const PRESETS = [
    "Don't work on this — I'm changing it",
    "If you're on it, don't push yet",
    'Pull first — I just pushed changes here',
  ];
  function headsUpModal(userId) {
    const u = U.get(userId); if (!u) return;
    const t = u.current_task_id ? T.get(u.current_task_id) : null;
    const taskOpts = S.tasks.filter((x) => x.status !== 'done').map((x) =>
      `<option value="${x.id}" ${t && t.id === x.id ? 'selected' : ''}>${esc(x.project)} · ${esc(x.title)}</option>`).join('');
    openModal(`<div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">${av(u, 'lg')}<div>
        <h3 style="margin:0">Heads-up to ${esc(u.display_name)}</h3>
        <div class="muted small">${u.is_live ? `${esc(u.display_name)} is LIVE${t ? ` on ${esc(t.project)} · ${esc(t.title)}` : ''}` : `${esc(u.display_name)} will see this next time they open the tracker`}</div></div></div>
      <form id="huForm" class="stack">
        <label>Quick message<div class="presets" id="huPresets">${PRESETS.map((p, i) => `<button type="button" class="preset ${i === 0 ? 'on' : ''}">${esc(p)}</button>`).join('')}</div></label>
        <label>What are you changing? (optional)<textarea name="detail" rows="3" maxlength="400" placeholder="e.g. I'm rewriting payments/webhook.js and the orders table schema"></textarea></label>
        <label>About task<select name="task"><option value="">— no specific task —</option>${taskOpts}</select></label>
        <div class="row-actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn primary">Send to ${esc(u.display_name)}</button></div>
      </form>`);
    $('#huPresets').addEventListener('click', (e) => {
      const b = e.target.closest('.preset'); if (!b) return;
      if (b.classList.contains('on')) b.classList.remove('on');
      else { $$('#huPresets .preset').forEach((x) => x.classList.toggle('on', x === b)); }
    });
    $('#mCancel').onclick = closeModal;
    $('#huForm').onsubmit = async (e) => {
      e.preventDefault();
      const preset = $('#huPresets .preset.on')?.textContent || '';
      const detail = e.target.detail.value.trim();
      const message = [preset, detail].filter(Boolean).join(' — ');
      if (!message) return toast('Pick a quick message or write one', true);
      try {
        await api('POST', '/api/headsup', { to_user_id: u.id, message, task_id: e.target.task.value || null });
        closeModal(); toast(`Heads-up sent to ${u.display_name}`); await load();
      } catch (err) { toast(err.message, true); }
    };
  }
  function hoursModal() {
    const me = U.get(S.me.id);
    openModal(`<h3>My working hours</h3><form id="hrForm" class="stack">
      <label>Shown next to your name so others know when you're around<input name="shift" maxlength="60" value="${esc(me.shift || '')}" placeholder="e.g. 10 PM – 5 AM" /></label>
      <div class="row-actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('#mCancel').onclick = closeModal;
    $('#hrForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/me/status', { current_note: me.current_note, current_task_id: me.current_task_id, is_live: !!me.is_live, shift: e.target.shift.value });
        closeModal(); toast('Saved'); await load();
      } catch (err) { toast(err.message, true); }
    };
  }
  function passwordModal() {
    openModal(`<h3>Change password</h3><form id="pwForm" class="stack">
      <label>Current password<input type="password" name="current" required autocomplete="current-password" /></label>
      <label>New password<input type="password" name="next" required minlength="6" autocomplete="new-password" /></label>
      <div class="row-actions"><button type="button" class="btn ghost" id="mCancel">Cancel</button><button class="btn primary">Update</button></div></form>`);
    $('#mCancel').onclick = closeModal;
    $('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/password', { current: e.target.current.value, next: e.target.next.value }); closeModal(); toast('Password updated'); }
      catch (err) { toast(err.message, true); }
    };
  }

  // ---------- navigation ----------
  function switchView(v) {
    view = v;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + v));
    if (v === 'timeline') {
      seenSnapshot = feedSeen();            // keep "new" highlighting for this visit
      renderTimeline();
      api('POST', '/api/me/feed-seen').then(() => { S.me.feed_seen = new Date().toISOString(); }).catch(() => {});
    } else { seenSnapshot = null; }
  }

  // ---------- auth ----------
  function showAuth() { $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden'); stopStream(); }
  function showApp() { if ($('#app').classList.contains('hidden')) { $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden'); startStream(); } }

  // ---------- live sync ----------
  let es = null, reloadT = null;
  function startStream() {
    if (es) return;
    es = new EventSource('/api/stream');
    es.addEventListener('change', () => { clearTimeout(reloadT); reloadT = setTimeout(load, 150); });
    es.onopen = () => $('#connDot').classList.add('on');
    es.onerror = () => $('#connDot').classList.remove('on');
  }
  function stopStream() { if (es) { es.close(); es = null; } $('#connDot').classList.remove('on'); }

  // ---------- events ----------
  function bind() {
    $$('.auth-tabs button').forEach((b) => b.onclick = () => {
      $$('.auth-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#loginForm').classList.toggle('hidden', b.dataset.auth !== 'login');
      $('#registerForm').classList.toggle('hidden', b.dataset.auth !== 'register');
      $('#authError').textContent = '';
    });
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api('POST', '/api/login', { username: f.username.value, password: f.password.value }); f.reset(); await load(); }
      catch (err) { $('#authError').textContent = err.message; }
    };
    $('#registerForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api('POST', '/api/register', { display_name: f.display_name.value, username: f.username.value, password: f.password.value, code: f.code.value }); f.reset(); await load(); }
      catch (err) { $('#authError').textContent = err.message; }
    };

    $$('.tabs button').forEach((b) => b.onclick = () => switchView(b.dataset.view));
    $('#newTaskBtn').onclick = newTaskModal;
    $('#meChip').onclick = (e) => { e.stopPropagation(); $('#meMenu').classList.toggle('hidden'); };
    document.addEventListener('click', () => $('#meMenu').classList.add('hidden'));
    $('#pwBtn').onclick = passwordModal;
    $('#hoursBtn').onclick = hoursModal;
    $('#seenAllBtn').onclick = () => markSeen((S.new_for_me || []).map((u) => u.id));
    document.addEventListener('click', async (e) => {
      const hu = e.target.closest('[data-headsup]');
      if (hu) return headsUpModal(Number(hu.dataset.headsup));
      const seen = e.target.closest('[data-seen]');
      if (seen) return markSeen([Number(seen.dataset.seen)]);
      const ack = e.target.closest('[data-ack]');
      if (ack) {
        ack.disabled = true;
        try { await api('POST', `/api/updates/${ack.dataset.ack}/ack`); S.for_me = S.for_me.filter((x) => x.id !== Number(ack.dataset.ack)); renderForYou(); }
        catch (err) { ack.disabled = false; toast(err.message, true); }
      }
    });
    $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); showAuth(); };

    ['#myNote', '#myTask'].forEach((s) => $(s).addEventListener('input', () => { statusDirty = true; }));
    $('#liveBtn').onclick = async () => {
      const me = U.get(S.me.id);
      if (me.is_live) return stopLiveModal();
      if (!$('#myNote').value.trim() && !$('#myTask').value) { toast('Write what you are working on (or pick a task) first', true); $('#myNote').focus(); return; }
      try { await saveStatus(true); toast("You're live"); } catch (err) { toast(err.message, true); }
    };
    $('#myTask').addEventListener('change', async () => { if (U.get(S.me.id).is_live) { try { await saveStatus(true); toast('Updated'); } catch (err) { toast(err.message, true); } } });
    $('#myNote').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const me = U.get(S.me.id);
      try { await saveStatus(me.is_live ? true : (($('#myNote').value.trim() || $('#myTask').value) ? true : false)); toast(me.is_live ? 'Updated' : "You're live"); } catch (err) { toast(err.message, true); }
    });

    // open task from any table row / link
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-task]');
      if (!el || el.closest('.drawer') || el.closest('.modal')) return;
      e.preventDefault(); openDrawer(Number(el.dataset.task));
    });
    $('#drawerBg').onclick = closeDrawer;
    $('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#modalBg').classList.contains('hidden')) closeModal(); else closeDrawer(); } });

    ['#fSearch', '#fProject', '#fOwner', '#fPriority', '#fStatus'].forEach((s) => $(s).addEventListener('input', renderTasks));
    $$('#tasksTable th[data-sort]').forEach((th) => th.onclick = () => {
      if (sort.key === th.dataset.sort) sort.asc = !sort.asc; else { sort.key = th.dataset.sort; sort.asc = th.dataset.sort === 'priority' || th.dataset.sort === 'status'; }
      renderTasks();
    });
    $$('#tlMode button').forEach((b) => b.onclick = () => { tlMode = b.dataset.mode; renderTimeline(); });
    ['#tlUser', '#tlProject'].forEach((s) => $(s).addEventListener('input', renderTimeline));

    setInterval(() => { if (S && !$('#app').classList.contains('hidden')) { renderGreeting(); renderTeam(); renderMyStatus(); renderForYou(); renderNew(); renderTasks(); renderTimeline(); } }, 30000);
  }

  bind();
  load().then(() => { if (!S) showAuth(); });
})();
