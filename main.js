const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

let win;
let ptyProcess;
let ptyDataSub;
let statusWatchInterval;

// Claude Code pipes a JSON snapshot (context_window, rate_limits, workspace…)
// into the status line command on every update. We point that command at a
// per-window file via --settings, so the user's own settings stay untouched.
function prepareStatusLine() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const statusFile = path.join(dir, `status-${process.pid}.json`);
  const settingsFile = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      statusLine: { type: 'command', command: 'cat > "$CLAUDETERM_STATUS_FILE"' },
    })
  );
  try {
    fs.unlinkSync(statusFile);
  } catch {}
  return { statusFile, settingsFile };
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

function watchStatusFile(statusFile) {
  let lastMtime = 0;
  clearInterval(statusWatchInterval);
  statusWatchInterval = setInterval(() => {
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
    const payload = {
      contextTokens: contextTokensFrom(data.context_window),
      contextPct: data.context_window?.used_percentage ?? null,
      fiveHour: rl.five_hour || null,
      weekly: rl.seven_day || null,
      project: data.workspace?.project_dir || data.cwd || null,
      home: os.homedir(),
    };
    if (win && !win.isDestroyed()) win.webContents.send('status-update', payload);
  }, 1000);
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

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 650,
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

  const { statusFile, settingsFile } = prepareStatusLine();
  const shell = process.env.SHELL || '/bin/zsh';
  const home = os.homedir();

  try {
    ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: home,
      env: cleanEnv({ CLAUDETERM_STATUS_FILE: statusFile }),
    });
  } catch (err) {
    console.error('pty.spawn failed:', err);
    return;
  }

  ptyDataSub = ptyProcess.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty-data', data);
  });

  ipcMain.on('pty-input', (_evt, data) => {
    if (ptyProcess) ptyProcess.write(data);
  });

  ipcMain.on('pty-resize', (_evt, { cols, rows }) => {
    try {
      ptyProcess.resize(cols, rows);
    } catch {}
  });

  // Renderer shows a picker on load and tells us which flags to use.
  ipcMain.once('launch-command', (_evt, extraFlags) => {
    const flags = extraFlags ? ` ${extraFlags}` : '';
    setTimeout(() => {
      if (ptyProcess) ptyProcess.write(`claude --settings '${settingsFile}'${flags}\r`);
    }, 400);
    watchStatusFile(statusFile);
  });

  win.on('close', () => cleanup(statusFile));
  win.on('closed', () => {
    win = null;
  });
}

// node-pty's native thread can still call back into JS while Electron tears
// down the Node environment on quit, which aborts the process (SIGABRT in
// Napi::ThreadSafeFunction::CallJS). Detach and kill the pty before that.
function cleanup(statusFile) {
  clearInterval(statusWatchInterval);
  if (ptyDataSub) {
    ptyDataSub.dispose();
    ptyDataSub = null;
  }
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {}
    ptyProcess = null;
  }
  if (statusFile) {
    try {
      fs.unlinkSync(statusFile);
    } catch {}
  }
}

app.whenReady().then(createWindow);

app.on('before-quit', () => cleanup());

app.on('window-all-closed', () => {
  app.quit();
});
