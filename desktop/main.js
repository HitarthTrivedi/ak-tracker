// AK Tracker desktop app (Electron).
// Starts the tracker server on localhost, connected to the shared team database,
// and opens it in a window. Starts at login, lives in the tray.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 47820;
const ICON = path.join(__dirname, 'icon.png');
let win = null, tray = null, server = null, quitting = false;

// ---------- config (shared DB connection) ----------
// Order: env vars → per-user config (written by the setup screen) → config.json bundled at build time.
const userCfgPath = () => path.join(app.getPath('userData'), 'config.json');
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function loadConfig() {
  if (process.env.DATABASE_URL) return { dbUrl: process.env.DATABASE_URL };
  return readJson(userCfgPath()) || readJson(path.join(__dirname, 'config.json'));
}

// ---------- start at login ----------
function setAutoStart(enabled) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'ak-tracker.desktop');
    if (!enabled) { try { fs.unlinkSync(file); } catch {} return; }
    const exec = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=AK Tracker\nExec="${exec}"\nIcon=${ICON}\nX-GNOME-Autostart-enabled=true\n`);
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}
function isAutoStart() {
  if (process.platform === 'linux') return fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'ak-tracker.desktop'));
  return app.getLoginItemSettings().openAtLogin;
}

// ---------- windows ----------
function createWindow(url) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 500,
    title: 'AK Tracker', icon: ICON, backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadURL(url);
  // links to other sites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  // closing the window keeps the app in the tray (so it can still notify you)
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}
function show() { if (win) { win.show(); win.focus(); } }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip('AK Tracker');
  const build = () => Menu.buildFromTemplate([
    { label: 'Open AK Tracker', click: show },
    { label: 'Start when I log in', type: 'checkbox', checked: isAutoStart(), click: (m) => { setAutoStart(m.checked); } },
    { label: 'Change database connection…', click: () => { fs.rmSync(userCfgPath(), { force: true }); app.relaunch(); quit(); } },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ]);
  tray.setContextMenu(build());
  tray.on('click', show);
}
function quit() { quitting = true; if (server) server.close(); app.quit(); }

function openSetup() {
  win = new BrowserWindow({
    width: 560, height: 420, resizable: false, title: 'AK Tracker — setup', icon: ICON, backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'setup.html'));
}
ipcMain.handle('setup:save', async (_e, cfg) => {
  const dbUrl = String(cfg.dbUrl || '').trim();
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) return { error: 'Database URL should start with postgresql://' };
  // test the connection before saving
  try {
    const { Client } = require('pg');
    const isLocal = /^postgres(ql)?:\/\/[^/@]*@?(localhost|127\.0\.0\.1)/.test(dbUrl);
    const c = new Client({ connectionString: dbUrl, ssl: isLocal ? false : { rejectUnauthorized: false } });
    await c.connect(); await c.query('SELECT 1'); await c.end();
  } catch (e) { return { error: 'Could not connect: ' + e.message }; }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userCfgPath(), JSON.stringify({ dbUrl }, null, 2));
  app.relaunch(); quit();
  return { ok: true };
});

// ---------- boot ----------
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    // first run: turn on start-at-login (user can switch it off from the tray)
    const flag = path.join(app.getPath('userData'), '.first-run-done');
    if (!fs.existsSync(flag)) {
      try { setAutoStart(true); } catch {}
      fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(flag, '1');
    }
    const cfg = loadConfig();
    if (!cfg || !cfg.dbUrl) return openSetup();
    try {
      const { start } = require('../server.js');
      try { server = await start({ port: PORT, host: '127.0.0.1', dbUrl: cfg.dbUrl, registerCode: cfg.registerCode }); }
      catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        server = await start({ port: 0, host: '127.0.0.1', dbUrl: cfg.dbUrl, registerCode: cfg.registerCode });
      }
    } catch (e) {
      const r = await dialog.showMessageBox({ type: 'error', title: 'AK Tracker', message: 'Could not connect to the team database.',
        detail: String(e.message || e), buttons: ['Retry', 'Change connection', 'Quit'] });
      if (r.response === 0) { app.relaunch(); return quit(); }
      if (r.response === 1) { fs.rmSync(userCfgPath(), { force: true }); app.relaunch(); return quit(); }
      return quit();
    }
    createWindow(`http://127.0.0.1:${server.port}`);
    createTray();
  });
  app.on('activate', show); // macOS dock click
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in tray */ });
}
