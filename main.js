const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

let win;
let settingsFile;
let nextId = 1;
const sessions = new Map(); // id -> { pty, dataSub, statusFile, statusInterval }

// Claude Code pipes a JSON snapshot (context_window, rate_limits, workspace…)
// into the status line command on every update. We point that command at a
// per-session file via --settings, so the user's own settings stay untouched.
function writeSettingsFile() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      statusLine: { type: 'command', command: 'cat > "$CLAUDETERM_STATUS_FILE"' },
    })
  );
  return file;
}

// Drop Claude Code session markers inherited from a parent Claude Code
// process (e.g. `npm start` run from inside one), otherwise the child
// session treats itself as nested and disables transcript saving.
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function contextTokensFrom(cw) {
  const u = cw && cw.current_usage;
  if (!u) return null;
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

function watchStatusFile(id, statusFile) {
  let lastMtime = 0;
  return setInterval(() => {
    let stat;
    try {
      stat = fs.statSync(statusFile);
    } catch {
      return;
    }
    if (stat.mtimeMs === lastMtime) return;
    lastMtime = stat.mtimeMs;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch {
      return; // partially written; next tick will catch it
    }

    const rl = data.rate_limits || {};
    send('status-update', {
      id,
      sessionId: data.session_id || null,
      contextTokens: contextTokensFrom(data.context_window),
      contextPct: data.context_window?.used_percentage ?? null,
      model: data.model?.display_name || null,
      fiveHour: rl.five_hour || null,
      weekly: rl.seven_day || null,
      project: data.workspace?.project_dir || data.cwd || null,
    });
  }, 1000);
}

function createSession({ flags, resumeId, cwd }) {
  const id = nextId++;
  const statusFile = path.join(app.getPath('userData'), `status-${process.pid}-${id}.json`);
  try {
    fs.unlinkSync(statusFile);
  } catch {}

  const home = os.homedir();
  const dir = cwd && fs.existsSync(cwd) ? cwd : home;
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: dir,
    env: cleanEnv({ CLAUDETERM_STATUS_FILE: statusFile }),
  });

  const session = { pty: p, statusFile };
  // Coalesce pty output into one IPC message per ~frame instead of one per
  // chunk; heavy redraws from Claude Code otherwise flood the renderer.
  let buffer = '';
  session.dataSub = p.onData((data) => {
    buffer += data;
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      const out = buffer;
      buffer = '';
      send('pty-data', { id, data: out });
    }, 8);
  });
  session.exitSub = p.onExit(() => {
    if (sessions.has(id)) {
      closeSession(id);
      send('session-exit', { id });
    }
  });
  session.statusInterval = watchStatusFile(id, statusFile);
  sessions.set(id, session);

  const parts = ['claude', '--settings', `'${settingsFile}'`];
  if (resumeId) parts.push('--resume', resumeId);
  if (flags) parts.push(flags);
  setTimeout(() => {
    if (sessions.has(id)) p.write(parts.join(' ') + '; exit\r');
  }, 400);

  return { id, cwd: dir, home };
}

// node-pty's native thread can still call back into JS while Electron tears
// down the Node environment, which aborts the process (SIGABRT in
// Napi::ThreadSafeFunction::CallJS). Detach and kill before that happens.
// Resolves once the pty has actually exited, so quitting can wait for the
// native exit callback instead of racing it.
function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return Promise.resolve();
  sessions.delete(id);
  clearInterval(s.statusInterval);
  clearTimeout(s.flushTimer);
  s.dataSub.dispose();
  s.exitSub.dispose();
  try {
    fs.unlinkSync(s.statusFile);
  } catch {}
  return new Promise((resolve) => {
    // If the shell ignores SIGHUP, force it, then give up after another second.
    let timer = setTimeout(() => {
      try {
        s.pty.kill('SIGKILL');
      } catch {}
      timer = setTimeout(resolve, 1000);
    }, 1500);
    const sub = s.pty.onExit(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
    try {
      s.pty.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function closeAll() {
  return Promise.all([...sessions.keys()].map(closeSession));
}

// Hold the window close / app quit until every pty is gone, then retry.
let shuttingDown = false;
function holdUntilClosed(e, then) {
  if (!sessions.size) return;
  e.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  closeAll().then(() => {
    shuttingDown = false;
    then();
  });
}

// --- Past sessions from ~/.claude/projects --------------------------------

const HEAD_BYTES = 64 * 1024;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text');
    return t ? t.text : '';
  }
  return '';
}

function parseSessionHead(text) {
  let cwd = null;
  let title = null;
  let summary = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // last line may be cut off by HEAD_BYTES
    }
    if (obj.type === 'summary' && obj.summary && !summary) summary = obj.summary;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (!title && obj.type === 'user' && !obj.isMeta) {
      const p = promptText(obj.message?.content).trim();
      // skip slash-command wrappers and other injected markup
      if (p && !p.startsWith('<')) title = p.replace(/\s+/g, ' ');
    }
    if (cwd && title && summary) break;
  }
  return { cwd, title: summary || title };
}

function listHistory(limit = 40) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const d of dirs) {
    const dirPath = path.join(root, d.name);
    let names = [];
    try {
      names = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of names) {
      const full = path.join(dirPath, f);
      try {
        files.push({ full, id: f.slice(0, -6), mtime: fs.statSync(full).mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let head;
    try {
      head = readHead(f.full);
    } catch {
      continue;
    }
    const { cwd, title } = parseSessionHead(head);
    if (!title) continue; // nothing was ever asked in this session
    out.push({ id: f.id, cwd, title, mtime: f.mtime });
  }
  return out;
}

// --- Window ----------------------------------------------------------------

function createWindow() {
  settingsFile = writeSettingsFile();

  win = new BrowserWindow({
    width: 1200,
    height: 720,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile('index.html');
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.error('[renderer]', e.message);
  });

  win.on('close', (e) => holdUntilClosed(e, () => win && win.close()));
  win.on('closed', () => {
    win = null;
  });
}

ipcMain.handle('session-create', (_e, opts) => createSession(opts));
ipcMain.handle('history-list', () => ({ home: os.homedir(), items: listHistory() }));
ipcMain.on('session-close', (_e, id) => closeSession(id));
ipcMain.on('pty-input', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.pty.write(data);
});
ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.resize(cols, rows);
  } catch {}
});

app.whenReady().then(createWindow);

app.on('before-quit', (e) => holdUntilClosed(e, () => app.quit()));

app.on('window-all-closed', () => {
  app.quit();
});
