const LOCALE_MAP = { en: 'en-US', de: 'de-DE', tr: 'tr-TR', es: 'es-ES' };

let currentLang = detectLang();
let homeDir = null;
let activeId = null;
let history = [];
let pendingResume = null; // { id, cwd, title } when the modal is for resuming

// id -> { term, fit, pane, project, sessionId, contextTokens, contextPct, model }
const sessions = new Map();
// Plan limits are account-wide, so any session's feed updates them for all
// sessions of that agent. Claude and Codex plans are separate.
// Only Claude Code and Codex log their limits; the others' stay empty.
const AGENTS = ['claude', 'codex', 'gemini', 'copilot', 'antigravity'];
const AGENT_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  copilot: 'Copilot CLI',
  antigravity: 'Antigravity',
};
const AGENT_COMMANDS = { antigravity: 'agy' };
const limits = Object.fromEntries(AGENTS.map((a) => [a, { fiveHour: null, weekly: null }]));
// Agents only report limits after their first reply, so the last known ones
// are kept and shown from the start. A window that has since reset is dropped.
try {
  const saved = JSON.parse(localStorage.getItem('claudeterm-limits') || '{}');
  for (const [agent, keys] of Object.entries(saved)) {
    if (!limits[agent]) continue;
    for (const [key, v] of Object.entries(keys || {})) {
      if (v && v.resetsAt && new Date(v.resetsAt) > new Date()) {
        limits[agent][key] = { percent: v.percent, resetsAt: new Date(v.resetsAt) };
      }
    }
  }
} catch {}

function saveLimits() {
  try {
    localStorage.setItem('claudeterm-limits', JSON.stringify(limits));
  } catch {}
}
let editing = false; // sidebar re-renders are paused while a title is being edited
// Every Claude Code session running on this machine, by session id, from
// ~/.claude/sessions. Ours get their status from it; the rest are listed apart.
let live = new Map();
let detailId = null; // session id whose detail panel is open
// Sessions that finished a turn while you were looking elsewhere, by session id.
// They blink until you open them, like sessions waiting on a permission prompt.
const attention = new Set();
const lastStatus = new Map(); // session id -> status at the previous poll
const BLINK_MS = 1200;

// User-chosen titles, keyed by Claude Code session id so they survive restarts
// and follow a session from the active list into history.
let titles = {};
try {
  titles = JSON.parse(localStorage.getItem('claudeterm-titles') || '{}');
} catch {}

function saveTitle(sessionId, title) {
  if (title) titles[sessionId] = title;
  else delete titles[sessionId];
  try {
    localStorage.setItem('claudeterm-titles', JSON.stringify(titles));
  } catch {}
}

const $ = (id) => document.getElementById(id);

// --- Settings: text sizes and sidebar width --------------------------------

const DEFAULT_SETTINGS = { termFont: 14, sidebarFont: 12.5, sidebarWidth: 280 };
const SIZE_LIMITS = { term: [10, 28, 1], sidebar: [10, 18, 0.5] };
let settings = { ...DEFAULT_SETTINGS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('claudeterm-settings') || '{}'));
} catch {}

function saveSettings() {
  try {
    localStorage.setItem('claudeterm-settings', JSON.stringify(settings));
  } catch {}
}

// The sidebar's styles use fixed pixel sizes, so its text is scaled with zoom
// on its contents rather than the sidebar itself, which keeps its width exact.
function applySettings() {
  const zoom = settings.sidebarFont / DEFAULT_SETTINGS.sidebarFont;
  for (const id of ['sidebarTop', 'sessionLists']) $(id).style.zoom = zoom;
  $('sidebar').style.width = settings.sidebarWidth + 'px';
  for (const s of sessions.values()) s.term.options.fontSize = settings.termFont;
  $('termFontValue').textContent = settings.termFont + ' px';
  $('sidebarFontValue').textContent = settings.sidebarFont + ' px';
  fitActive();
}

// --- Theme -----------------------------------------------------------------

const TERM_THEMES = {
  dark: {
    background: '#141413',
    foreground: '#ecebe7',
    cursor: '#ecebe7',
    cursorAccent: '#141413',
    selectionBackground: 'rgba(217, 119, 87, 0.3)',
  },
  // Darker ANSI colours so text written for dark terminals stays readable.
  light: {
    background: '#faf9f5',
    foreground: '#1f1e1d',
    cursor: '#1f1e1d',
    cursorAccent: '#faf9f5',
    selectionBackground: 'rgba(196, 97, 63, 0.25)',
    black: '#1f1e1d',
    red: '#b5483e',
    green: '#4f7a2a',
    yellow: '#94700e',
    blue: '#2f5f9e',
    magenta: '#8a4a8f',
    cyan: '#2a7a7a',
    white: '#6f6c66',
    brightBlack: '#5f5c55',
    brightRed: '#c4613f',
    brightGreen: '#5f7a3a',
    brightYellow: '#a87a1e',
    brightBlue: '#3b6fb6',
    brightMagenta: '#9c5aa1',
    brightCyan: '#2f8a8a',
    brightWhite: '#3a3935',
  },
};
const THEMES = ['auto', 'light', 'dark'];
let themeChoice = 'auto';
try {
  const v = localStorage.getItem('claudeterm-theme');
  if (THEMES.includes(v)) themeChoice = v;
} catch {}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  if (themeChoice !== 'auto') return themeChoice;
  return darkQuery.matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  for (const s of sessions.values()) s.term.options.theme = TERM_THEMES[theme];
}

darkQuery.addEventListener('change', applyTheme);

// --- Helpers ---------------------------------------------------------------

function locale() {
  return LOCALE_MAP[currentLang] || 'en-US';
}

function projectName(dir) {
  if (!dir) return '—';
  if (homeDir && dir === homeDir) return '~';
  return dir.split('/').filter(Boolean).pop() || dir;
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function relativeTime(ms) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const diff = (ms - Date.now()) / 1000;
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, sec] of units) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return rtf.format(0, 'minute');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// --- Terminals -------------------------------------------------------------

function createTermPane(id) {
  const pane = el('div', 'termPane visible'); // must be laid out before open()
  $('terminals').appendChild(pane);
  const term = new Terminal({
    cursorBlink: true,
    fontSize: settings.termFont,
    fontFamily: 'Menlo, monospace',
    theme: TERM_THEMES[effectiveTheme()],
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  // GPU rendering; the default DOM renderer is what makes scrolling lag.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose()); // falls back to DOM renderer
    term.loadAddon(webgl);
  } catch {}
  term.onData((data) => window.claudeTerm.sendInput(id, data));
  return { term, fit, pane };
}

function fitActive() {
  const s = sessions.get(activeId);
  if (!s) return;
  s.fit.fit();
  window.claudeTerm.resize(activeId, s.term.cols, s.term.rows);
}

function setActive(id) {
  activeId = id;
  const focused = sessions.get(id);
  if (focused && focused.sessionId) attention.delete(focused.sessionId);
  for (const [sid, s] of sessions) s.pane.classList.toggle('visible', sid === id);
  $('placeholder').style.display = sessions.size ? 'none' : 'flex';
  const s = sessions.get(id);
  if (s) {
    fitActive();
    s.term.focus();
  }
  render();
}

function removeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.term.dispose();
  s.pane.remove();
  sessions.delete(id);
  saveOpenSessions();
  if (activeId === id) {
    const next = [...sessions.keys()].pop();
    setActive(next ?? null);
  } else {
    render();
  }
  refreshHistory();
}

window.addEventListener('resize', fitActive);

window.claudeTerm.onPtyData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});

window.claudeTerm.onSessionExit(({ id }) => removeSession(id));

window.claudeTerm.onStatusUpdate((msg) => {
  const s = sessions.get(msg.id);
  const agent = msg.agent || 'claude';
  if (s && msg.status) {
    // Other agents report busy/idle in their own feed, not in ~/.claude/sessions.
    if (msg.status === 'busy') attention.delete(s.sessionId);
    else if (s.agentStatus === 'busy' && msg.id !== activeId) attention.add(msg.sessionId || s.sessionId);
    s.agentStatus = msg.status;
  }
  if (s) {
    if (msg.sessionId && msg.sessionId !== s.sessionId) {
      s.sessionId = msg.sessionId;
      saveOpenSessions();
    }
    // A title typed before Claude Code reported its session id is saved now.
    if (s.customTitle !== undefined && s.sessionId) {
      saveTitle(s.sessionId, s.customTitle);
      delete s.customTitle;
    }
    s.project = msg.project || s.project;
    // "Opus 5.5 (1M context)" → "Opus 5.5"; the window size is in the detail panel.
    s.model = (msg.model && msg.model.replace(/\s*\(.*\)$/, '')) || s.model;
    s.aiTitle = msg.aiTitle || s.aiTitle;
    s.contextTokens = msg.contextTokens;
    s.contextPct = msg.contextPct;
  }
  for (const key of ['fiveHour', 'weekly']) {
    if (!msg[key]) continue;
    limits[agent][key] = {
      percent: Math.round(msg[key].used_percentage),
      resetsAt: toDate(msg[key].resets_at),
    };
    alertLimit(agent, key, limits[agent][key]);
    saveLimits();
  }
  render();
});

// One notification per limit window once it passes 90%.
const LIMIT_ALERT_PCT = 90;
const alerted = new Set();

function alertLimit(agent, key, entry) {
  if (entry.percent < LIMIT_ALERT_PCT) return;
  const tag = `${agent}:${key}:${entry.resetsAt ? entry.resetsAt.getTime() : ''}`;
  if (alerted.has(tag)) return;
  alerted.add(tag);
  try {
    new Notification(t(currentLang, 'limitAlertTitle'), {
      body: `${AGENT_NAMES[agent]} · ${t(currentLang, key)}: ${entry.percent}% ${t(currentLang, 'used')}`,
    });
  } catch {}
}

// --- Launch modal ----------------------------------------------------------

// Laid out like Claude Code's own /model picker: one row per model with what it
// is good for, the chosen one ticked. Full ids pin an exact version.
const MODELS = [
  { value: '', name: null, desc: 'modelDescDefault' },
  { value: 'claude-opus-5-5', name: 'Opus 5.5', desc: 'modelDescOpus' },
  { value: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'modelDescSonnet' },
  { value: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'modelDescHaiku' },
  { value: 'claude-fable-5-1', name: 'Fable 5.1', desc: 'modelDescFable' },
];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Codex takes its model from ~/.codex/config.toml; only the effort is offered.
// Gemini CLI and Copilot CLI start with their own defaults.
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
// How many of five dots each effort level fills; auto shows them all hollow.
const EFFORT_LEVEL = { '': 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

function effortMeter(e) {
  const meter = el('span', 'meter' + (e ? '' : ' auto'));
  for (let i = 1; i <= 5; i++) meter.appendChild(el('i', i <= EFFORT_LEVEL[e] ? 'on' : null));
  return meter;
}
// Older versions of the app saved bare aliases.
const LEGACY_MODELS = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-4-5-20251001',
};

function loadChoice(key, valid, fallback) {
  try {
    let v = localStorage.getItem(key);
    if (v !== null) v = LEGACY_MODELS[v] || v;
    if (v !== null && valid.includes(v)) return v;
  } catch {}
  return fallback;
}

// Sonnet by default: it uses up plan limits about half as fast as Opus.
let chosenModel = loadChoice('claudeterm-model', MODELS.map((m) => m.value), 'claude-sonnet-5');
let chosenEffort = loadChoice('claudeterm-effort', EFFORTS, '');
let chosenAgent = loadChoice('claudeterm-agent', AGENTS, 'claude');
let installed = null; // agent CLIs found on this machine, once known

// The agent being launched: fixed by the session when resuming one.
function launchAgent() {
  return pendingResume?.agent || chosenAgent;
}
// Where new sessions start. Not the home folder by default: Claude Code indexes
// its working folder, and in ~ that reaches Desktop, Documents and Downloads,
// each of which macOS asks about separately.
let chosenFolder = null;
try {
  chosenFolder = localStorage.getItem('claudeterm-folder');
} catch {}

function fillLaunchPickers() {
  const agent = launchAgent();
  const agents = $('agentSeg');
  agents.replaceChildren();
  agents.style.gridTemplateColumns = `repeat(${AGENTS.length}, 1fr)`;
  for (const a of AGENTS) {
    const b = el('button', 'segBtn' + (a === agent ? ' selected' : ''), AGENT_NAMES[a]);
    b.type = 'button';
    if (installed && !installed.includes(a)) {
      b.disabled = true;
      b.title = t(currentLang, 'notInstalled');
    }
    b.addEventListener('click', () => {
      chosenAgent = a;
      fillLaunchPickers();
    });
    agents.appendChild(b);
  }
  const resuming = !!pendingResume;
  $('agentLabel').style.display = resuming ? 'none' : '';
  agents.style.display = resuming ? 'none' : '';
  const codex = agent === 'codex';
  const claude = agent === 'claude';
  $('modelLabel').style.display = claude ? '' : 'none';
  $('modelList').style.display = claude ? '' : 'none';
  const hasEffort = claude || codex;
  for (const e of ['effortLabel', 'effortSeg', 'effortHint']) $(e).style.display = hasEffort ? '' : 'none';
  $('launchTitle').textContent = pendingResume?.handoffFrom
    ? t(currentLang, 'handoffTitle').replace('{agent}', AGENT_NAMES[agent])
    : resuming
    ? t(currentLang, 'resumeTitle')
    : claude
      ? t(currentLang, 'launchTitle')
      : t(currentLang, 'launchTitleAgent').replace('{agent}', AGENT_NAMES[agent]);

  const list = $('modelList');
  list.replaceChildren();
  for (const m of MODELS) {
    const row = el('button', 'opt' + (m.value === chosenModel ? ' selected' : ''));
    row.type = 'button';
    const text = el('div', 'optText');
    text.appendChild(el('div', 'optName', m.name || t(currentLang, 'modelDefault')));
    text.appendChild(el('div', 'optDesc', t(currentLang, m.desc)));
    row.appendChild(text);
    row.appendChild(el('span', 'check', '✔'));
    row.addEventListener('click', () => {
      chosenModel = m.value;
      fillLaunchPickers();
    });
    list.appendChild(row);
  }

  const efforts = codex ? CODEX_EFFORTS : EFFORTS;
  const effort = efforts.includes(chosenEffort) ? chosenEffort : '';
  const seg = $('effortSeg');
  seg.replaceChildren();
  seg.style.gridTemplateColumns = `repeat(${efforts.length}, 1fr)`;
  for (const e of efforts) {
    const b = el('button', 'segBtn' + (e === effort ? ' selected' : ''));
    b.type = 'button';
    b.appendChild(effortMeter(e));
    b.appendChild(el('span', null, t(currentLang, e ? 'effort_' + e : 'effortAuto')));
    b.addEventListener('click', () => {
      chosenEffort = e;
      fillLaunchPickers();
    });
    seg.appendChild(b);
  }
  $('effortHint').textContent = codex && !effort
    ? t(currentLang, 'effortDesc_autoCodex')
    : t(currentLang, 'effortDesc_' + (effort || 'auto'));
  renderLaunchCommands();
}

function shortDir(dir) {
  return homeDir && dir && dir.startsWith(homeDir) ? '~' + dir.slice(homeDir.length) : dir || '~';
}

const SKIP_FLAGS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  copilot: '--allow-all-tools',
  antigravity: '--dangerously-skip-permissions',
};

function launchFlags(skip) {
  const agent = launchAgent();
  const extra = skip ? SKIP_FLAGS[agent] : '';
  if (agent === 'codex') {
    const effort = CODEX_EFFORTS.includes(chosenEffort) ? chosenEffort : '';
    return [effort ? `-c model_reasoning_effort=${effort}` : '', extra].filter(Boolean).join(' ');
  }
  if (agent !== 'claude') return extra;
  return [chosenModel ? `--model ${chosenModel}` : '', chosenEffort ? `--effort ${chosenEffort}` : '', extra]
    .filter(Boolean)
    .join(' ');
}

// The buttons show the exact command each one runs.
function renderLaunchCommands() {
  const agent = launchAgent();
  const id = pendingResume?.id ? `${pendingResume.id.slice(0, 8)}…` : '';
  const resumeArg = { codex: 'resume', antigravity: '--conversation' }[agent] || '--resume';
  const fork = pendingResume?.fork ? ' --fork-session' : '';
  const handoff = pendingResume?.handoffFrom ? `"${t(currentLang, 'handoffCmd')}"` : '';
  const base = (AGENT_COMMANDS[agent] || agent) + (id ? ` ${resumeArg} ${id}${fork}` : '');
  $('cmdNormal').textContent = [base, launchFlags(false), handoff].filter(Boolean).join(' ');
  $('cmdSkip').textContent = [base, launchFlags(true), handoff].filter(Boolean).join(' ');
  $('folderPath').textContent = shortDir(pendingResume ? pendingResume.cwd : chosenFolder);
  $('btnFolder').style.display = pendingResume ? 'none' : '';
}

$('btnFolder').addEventListener('click', async () => {
  const dir = await window.claudeTerm.pickFolder(chosenFolder);
  if (!dir) return;
  chosenFolder = dir;
  try {
    localStorage.setItem('claudeterm-folder', dir);
  } catch {}
  renderLaunchCommands();
});

async function openLaunchModal(resume) {
  pendingResume = resume || null;
  if (!installed) installed = await window.claudeTerm.installedAgents();
  if (!installed.includes(chosenAgent)) chosenAgent = 'claude';
  const def = await window.claudeTerm.defaultFolder();
  homeDir = def.home;
  if (!chosenFolder) chosenFolder = def.folder;
  // Claude Code can't run one session in two processes, so a session still
  // open in another terminal continues here as a copy.
  $('launchSubtitle').textContent = resume
    ? resume.handoffFrom
      ? `${resume.title} — ${t(currentLang, 'handoffNote').replace('{agent}', AGENT_NAMES[resume.handoffFrom.agent])}`
      : resume.fork
      ? `${resume.title} — ${t(currentLang, 'forkNote')}`
      : resume.title
    : '';
  $('launchSubtitle').style.display = resume ? 'block' : 'none';
  fillLaunchPickers();
  $('launchModal').classList.add('open');
}

function closeLaunchModal() {
  $('launchModal').classList.remove('open');
  pendingResume = null;
}

async function launch(skip) {
  try {
    localStorage.setItem('claudeterm-model', chosenModel);
    localStorage.setItem('claudeterm-effort', chosenEffort);
    localStorage.setItem('claudeterm-agent', chosenAgent);
  } catch {}
  const resume = pendingResume;
  const agent = launchAgent();
  const flags = launchFlags(skip);
  if (resume?.handoffFrom) {
    // A new session of `agent`, told to read the earlier conversation first.
    const prompt = await window.claudeTerm.prepareHandoff(resume.handoffFrom);
    if (!prompt) {
      $('launchSubtitle').textContent = t(currentLang, 'handoffFailed');
      return;
    }
    closeLaunchModal();
    await startSession(flags, { title: resume.title }, resume.cwd, true, agent, prompt);
    return;
  }
  closeLaunchModal();
  await startSession(flags, resume, resume ? resume.cwd : chosenFolder, true, agent);
}

// Opens a terminal running Claude Code or Codex. `resume` is { id, title } to
// continue a past session; `flags` are kept so a restored session starts the
// same way.
async function startSession(flags, resume, folder, focus = true, agent = 'claude', prompt = null) {
  const { id, cwd, home } = await window.claudeTerm.createSession({
    agent,
    prompt,
    // Not kept in `flags`: a restored copy resumes its own id, without forking again.
    flags: [resume?.fork ? '--fork-session' : '', flags].filter(Boolean).join(' '),
    resumeId: resume?.id,
    cwd: folder,
  });
  homeDir = home;
  sessions.set(id, {
    ...createTermPane(id),
    project: cwd,
    startCwd: cwd,
    agent,
    flags,
    sessionId: resume?.fork ? null : resume?.id || null,
    aiTitle: resume?.title || null,
    contextTokens: null,
    contextPct: null,
    model: null,
  });
  saveOpenSessions();
  if (focus) setActive(id);
  else {
    sessions.get(id).pane.classList.remove('visible');
    render();
  }
}

// --- Reopen sessions after a restart --------------------------------------

// Open sessions, in sidebar order, so quitting (or installing an update) and
// starting again picks every one of them up where it was. Only sessions that
// Claude Code has given an id can be resumed.
function saveOpenSessions() {
  const list = [...sessions.values()]
    .filter((s) => s.sessionId)
    .map((s) => ({ id: s.sessionId, agent: s.agent, cwd: s.startCwd, flags: s.flags || '', title: s.aiTitle || null }));
  try {
    localStorage.setItem('claudeterm-open', JSON.stringify(list));
  } catch {}
}

async function restoreOpenSessions() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('claudeterm-open') || '[]');
  } catch {}
  list = list.filter((r) => r && r.id);
  // A session running elsewhere can't be resumed twice. Right after a restart
  // the old Claude Code process may still be exiting and look alive, so give
  // it a few seconds before counting it as taken.
  for (let i = 0; i < 5 && list.some((r) => live.has(r.id)); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await pollLive();
  }
  list = list.filter((r) => !live.has(r.id));
  for (const [i, r] of list.entries()) {
    const agent = r.agent || 'claude';
    await startSession(r.flags, { id: r.id, agent, title: r.title }, r.cwd, i === 0, agent);
  }
  return list.length;
}

$('btnNew').addEventListener('click', () => openLaunchModal(null));
$('btnNormal').addEventListener('click', () => launch(false));
$('btnSkipPerm').addEventListener('click', () => launch(true));
$('btnCancel').addEventListener('click', closeLaunchModal);

// --- Settings dialog -------------------------------------------------------

$('btnSettings').addEventListener('click', () => $('settingsModal').classList.add('open'));
$('btnSettingsDone').addEventListener('click', () => $('settingsModal').classList.remove('open'));
$('btnSettingsReset').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  applySettings();
});
for (const b of document.querySelectorAll('.stepper button')) {
  b.addEventListener('click', () => {
    const [min, max, step] = SIZE_LIMITS[b.dataset.size];
    const key = b.dataset.size === 'term' ? 'termFont' : 'sidebarFont';
    settings[key] = Math.min(max, Math.max(min, settings[key] + step * Number(b.dataset.step)));
    saveSettings();
    applySettings();
  });
}

// --- Sidebar width -----------------------------------------------------------

$('sidebarResize').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const handle = e.currentTarget;
  const startX = e.clientX;
  const startWidth = $('sidebar').offsetWidth;
  handle.classList.add('dragging');
  const move = (ev) => {
    settings.sidebarWidth = Math.round(Math.min(640, Math.max(180, startWidth + ev.clientX - startX)));
    applySettings();
  };
  const up = () => {
    handle.classList.remove('dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    saveSettings();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// --- Right-click menu --------------------------------------------------------

// Agents whose transcripts can be read, so another agent can take over.
const HANDOFF_SOURCES = ['claude', 'codex', 'gemini', 'copilot'];
// Agents that can be started with a first message.
const HANDOFF_TARGETS = ['claude', 'codex', 'gemini', 'copilot'];

function closeMenu() {
  $('ctxMenu').hidden = true;
}

function menuItem(label, onClick) {
  const b = el('button', null, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    closeMenu();
    onClick();
  });
  return b;
}

// `entry` is a past or running session: { id, agent, cwd, title, running }.
async function showSessionMenu(e, entry, extra) {
  e.preventDefault();
  if (!installed) installed = await window.claudeTerm.installedAgents();
  const menu = $('ctxMenu');
  menu.replaceChildren();
  const name = AGENT_NAMES[entry.agent];
  menu.appendChild(
    menuItem(t(currentLang, 'menuContinue').replace('{agent}', name), () =>
      openLaunchModal({ id: entry.id, agent: entry.agent, cwd: entry.cwd, title: entry.title, fork: entry.running })
    )
  );
  if (HANDOFF_SOURCES.includes(entry.agent)) {
    const targets = HANDOFF_TARGETS.filter((a) => a !== entry.agent && installed.includes(a));
    if (targets.length) menu.appendChild(el('hr'));
    for (const a of targets) {
      menu.appendChild(
        menuItem(t(currentLang, 'menuContinueWith').replace('{agent}', AGENT_NAMES[a]), () =>
          openLaunchModal({
            agent: a,
            cwd: entry.cwd,
            title: entry.title,
            handoffFrom: { agent: entry.agent, id: entry.id, cwd: entry.cwd },
          })
        )
      );
    }
  }
  if (extra.length) menu.appendChild(el('hr'));
  for (const [label, fn] of extra) menu.appendChild(menuItem(label, fn));
  menu.hidden = false;
  // Keep it on screen.
  const { innerWidth: w, innerHeight: h } = window;
  menu.style.left = Math.min(e.clientX, w - menu.offsetWidth - 4) + 'px';
  menu.style.top = Math.min(e.clientY, h - menu.offsetHeight - 4) + 'px';
}

window.addEventListener('mousedown', (e) => {
  if (!$('ctxMenu').contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);

// --- Sidebar ---------------------------------------------------------------

async function refreshHistory() {
  const res = await window.claudeTerm.listHistory();
  homeDir = res.home;
  history = res.items;
  renderSidebar();
}

function activeTitle(s) {
  if (s.customTitle) return s.customTitle;
  return (s.sessionId && titles[s.sessionId]) || s.aiTitle || t(currentLang, 'newSession');
}

function setActiveTitle(s, title) {
  if (s.sessionId) saveTitle(s.sessionId, title);
  else s.customTitle = title; // saved once the session id arrives
}

// Swap the title text for an input; Enter/blur saves, Escape cancels,
// an empty value restores the automatic title.
function startRename(nameEl, current, onSave) {
  editing = true;
  const input = el('input', 'rename');
  input.value = current;
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editing = false;
    if (save) onSave(input.value.trim().replace(/\s+/g, ' '));
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

function itemActions(item, nameEl, current, onSave, onClose, sessionId, dblRename = true) {
  const actions = el('div', 'actions');
  if (sessionId) {
    const info = el('span', 'btn', 'ⓘ');
    info.title = t(currentLang, 'details');
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetail(sessionId);
    });
    actions.appendChild(info);
  }
  if (onSave) {
    const rename = el('span', 'btn', '✎');
    rename.title = t(currentLang, 'rename');
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(nameEl, current, onSave);
    });
    actions.appendChild(rename);
    if (dblRename) {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(nameEl, current, onSave);
      });
    }
  }
  if (onClose) {
    const close = el('span', 'btn', '×');
    close.title = t(currentLang, 'close');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      onClose();
    });
    actions.appendChild(close);
  }
  item.appendChild(actions);
}

// Blinking item for a session that needs you. The phase follows the clock, so
// the sidebar re-rendering every poll doesn't restart the animation.
function markAttention(item, sessionId, status) {
  if (status !== 'waiting' && !attention.has(sessionId)) return;
  item.classList.add('attention');
  item.style.animationDelay = `-${Date.now() % BLINK_MS}ms`;
}

function statusPill(status) {
  return el('span', 'pill ' + status, t(currentLang, 'status_' + status));
}

// Title row: status dot, title, and the model in accent colour on the right.
function nameRow(item, title, status, model) {
  const row = el('div', 'nameRow');
  const name = el('div', 'name');
  if (status) name.appendChild(el('span', 'dot ' + status));
  name.appendChild(document.createTextNode(title));
  row.appendChild(name);
  if (model) row.appendChild(el('span', 'model', model));
  item.appendChild(row);
  return name;
}

function metaRow(item, text, status) {
  const meta = el('div', 'meta');
  if (status && status !== 'idle') meta.appendChild(statusPill(status));
  meta.appendChild(el('span', 'text', text || '…'));
  item.appendChild(meta);
}

// --- Reorder by drag -------------------------------------------------------

let dragId = null; // sidebar re-renders pause while a session is being dragged

function moveSession(from, to, after) {
  if (from === to) return;
  const order = [...sessions.keys()].filter((k) => k !== from);
  let at = order.indexOf(to);
  if (after) at += 1;
  order.splice(at, 0, from);
  const entries = order.map((k) => [k, sessions.get(k)]);
  sessions.clear();
  for (const [k, v] of entries) sessions.set(k, v);
  saveOpenSessions();
}

function makeDraggable(item, id) {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragover', (e) => {
    if (dragId === null || dragId === id) return;
    e.preventDefault();
    const r = item.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    item.classList.toggle('dropAfter', after);
    item.classList.toggle('dropBefore', !after);
  });
  item.addEventListener('dragleave', () => item.classList.remove('dropAfter', 'dropBefore'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = item.classList.contains('dropAfter');
    if (dragId !== null) moveSession(dragId, id, after);
  });
  item.addEventListener('dragend', () => {
    dragId = null;
    renderSidebar();
  });
}

function renderSidebar() {
  if (editing || dragId !== null) return;
  const active = $('activeList');
  active.replaceChildren();
  if (!sessions.size) active.appendChild(el('div', 'empty', t(currentLang, 'noActive')));
  for (const [id, s] of sessions) {
    const item = el('div', 'item' + (id === activeId ? ' active' : ''));
    const title = activeTitle(s);
    item.title = title;
    const other = s.agent !== 'claude';
    const info = !other && s.sessionId && live.get(s.sessionId);
    const status = other ? s.agentStatus || 'idle' : info ? info.status : 'idle';
    // No need to blink the session you are looking at.
    if (id !== activeId || !document.hasFocus()) markAttention(item, s.sessionId, status);
    const name = nameRow(item, title, status, s.model || info?.model || (other ? AGENT_NAMES[s.agent] : null));
    const meta = [projectName(s.project)];
    if (s.contextTokens != null) meta.push(`${s.contextTokens.toLocaleString(locale())} tok`);
    metaRow(item, meta.join(' · '), status);
    itemActions(
      item,
      name,
      title,
      (v) => setActiveTitle(s, v),
      () => {
        window.claudeTerm.closeSession(id);
        removeSession(id);
      },
      other ? null : s.sessionId // the detail panel reads Claude Code transcripts
    );
    item.addEventListener('click', () => setActive(id));
    makeDraggable(item, id);
    active.appendChild(item);
  }

  // Sessions running in other terminals: shown and inspectable, not attachable.
  const ours = new Set([...sessions.values()].map((s) => s.sessionId).filter(Boolean));
  const external = [...live.values()].filter((l) => !ours.has(l.id));
  const ext = $('externalList');
  ext.replaceChildren();
  $('externalCount').textContent = external.length ? external.length : '';
  if (!external.length) ext.appendChild(el('div', 'empty', t(currentLang, 'noExternal')));
  for (const l of external) {
    const item = el('div', 'item external');
    const title = titles[l.id] || l.title || l.name || projectName(l.cwd);
    item.title = l.waitingFor ? `${title} — ${l.waitingFor}` : title;
    markAttention(item, l.id, l.status);
    const name = nameRow(item, title, l.status, l.model);
    metaRow(item, projectName(l.cwd), l.status);
    // Double-click continues it here; ✎ renames it.
    itemActions(item, name, title, (v) => saveTitle(l.id, v), null, l.id, false);
    item.addEventListener('click', () => {
      attention.delete(l.id);
      openDetail(l.id);
    });
    item.addEventListener('dblclick', () => {
      closeDetail();
      openLaunchModal({ id: l.id, agent: 'claude', cwd: l.cwd, title, fork: true });
    });
    item.addEventListener('contextmenu', (e) =>
      showSessionMenu(e, { id: l.id, agent: 'claude', cwd: l.cwd, title, running: true }, [
        [t(currentLang, 'menuRename'), () => startRename(name, title, (v) => saveTitle(l.id, v))],
        [t(currentLang, 'details'), () => openDetail(l.id)],
      ])
    );
    ext.appendChild(item);
  }

  const list = $('historyList');
  list.replaceChildren();
  const running = new Set([...ours, ...live.keys()]);
  const items = history.filter((h) => !running.has(h.id));
  if (!items.length) list.appendChild(el('div', 'empty', t(currentLang, 'noHistory')));
  for (const h of items) {
    const item = el('div', 'item');
    const title = titles[h.id] || h.title;
    item.title = title;
    const other = h.agent && h.agent !== 'claude';
    const name = nameRow(item, title, null, other ? AGENT_NAMES[h.agent] : null);
    metaRow(item, `${projectName(h.cwd)} · ${relativeTime(h.mtime)}`);
    itemActions(item, name, title, (v) => saveTitle(h.id, v), null, other ? null : h.id);
    item.addEventListener('click', () => openLaunchModal({ ...h, title }));
    const extra = [[t(currentLang, 'menuRename'), () => startRename(name, title, (v) => saveTitle(h.id, v))]];
    if (!other) extra.push([t(currentLang, 'details'), () => openDetail(h.id)]);
    item.addEventListener('contextmenu', (e) => showSessionMenu(e, { ...h, agent: h.agent || 'claude', title }, extra));
    list.appendChild(item);
  }
}

async function pollLive() {
  try {
    const list = await window.claudeTerm.listLive();
    live = new Map(list.map((l) => [l.id, l]));
    const focusedId = sessions.get(activeId)?.sessionId;
    for (const l of list) {
      const prev = lastStatus.get(l.id);
      if (l.status === 'busy') attention.delete(l.id);
      else if (prev === 'busy' && l.id !== focusedId) attention.add(l.id);
      lastStatus.set(l.id, l.status);
    }
    const otherIds = new Set([...sessions.values()].filter((x) => x.agent !== 'claude').map((x) => x.sessionId));
    for (const id of attention) if (!live.has(id) && !otherIds.has(id)) attention.delete(id);
    renderSidebar();
  } catch {}
}
setInterval(pollLive, 2000);

// Section headers fold their list: Active starts open, History closed.
for (const header of document.querySelectorAll('.sectionTitle')) {
  header.addEventListener('click', () => {
    const list = $(header.dataset.list);
    list.hidden = !list.hidden;
    header.classList.toggle('collapsed', list.hidden);
  });
}

// --- Status bar ------------------------------------------------------------

function renderLimit(id, key, agent) {
  const entry = limits[agent][key];
  const e = $(id);
  if (!entry) {
    e.textContent = '—';
    e.className = '';
    return;
  }
  const left = 100 - entry.percent;
  let text = `${entry.percent}% ${t(currentLang, 'used')} (${left}% ${t(currentLang, 'remaining')})`;
  if (entry.resetsAt) {
    const opts =
      key === 'weekly'
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' };
    text += ` · ${t(currentLang, 'resets')} ${entry.resetsAt.toLocaleString(locale(), opts)}`;
  }
  e.textContent = text;
  e.className = entry.percent >= 90 ? 'danger' : entry.percent >= 70 ? 'warn' : '';
}

function render() {
  const s = sessions.get(activeId);
  if (s && s.contextTokens != null) {
    let text = s.contextTokens.toLocaleString(locale());
    if (s.contextPct != null) text += ` (${Math.round(s.contextPct)}%)`;
    $('tokenCount').textContent = text;
  } else {
    $('tokenCount').textContent = '—';
  }
  // Limits shown are those of the agent in the open session.
  const agent = s?.agent || 'claude';
  renderLimit('fiveHourLimit', 'fiveHour', agent);
  renderLimit('weeklyLimit', 'weekly', agent);
  document.title = s ? `ClaudeTerm — ${projectName(s.project)}` : 'ClaudeTerm';
  renderSidebar();
}

// --- Session detail panel ---------------------------------------------------

const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString(locale()));

function compact(n) {
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function duration(ms) {
  if (ms == null) return '—';
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} ${t(currentLang, 'unit_h')} ${m} ${t(currentLang, 'unit_m')}`;
  if (m) return `${m} ${t(currentLang, 'unit_m')}`;
  return `${sec} ${t(currentLang, 'unit_s')}`;
}

function section(label, ...children) {
  const sec = el('div', 'dSection');
  if (label) sec.appendChild(el('div', 'dLabel', label));
  for (const c of children) if (c) sec.appendChild(c);
  return sec;
}

function statGrid(cells) {
  const grid = el('div', 'grid');
  for (const [label, value, cls] of cells) {
    const cell = el('div');
    cell.appendChild(el('div', 'dLabel', label));
    cell.appendChild(el('div', 'val' + (cls ? ' ' + cls : ''), value));
    grid.appendChild(cell);
  }
  return grid;
}

// Label, "tokens · share", and a thin bar under it.
function shareRow(name, tokens, total, muted) {
  const row = el('div', 'row');
  const head = el('div', 'rowHead');
  head.appendChild(el('span', 'rowName' + (muted ? ' muted' : ''), name));
  const pct = total ? Math.round((tokens / total) * 100) : 0;
  head.appendChild(el('span', 'rowVal', `${fmt(tokens)} · ${pct}%`));
  row.appendChild(head);
  const bar = el('div', 'bar');
  const fill = el('span', 'fill' + (muted ? ' muted' : ''));
  fill.style.width = Math.max(pct, tokens ? 0.5 : 0) + '%';
  bar.appendChild(fill);
  row.appendChild(bar);
  return row;
}

function partLabel(p) {
  if (p.part === 'memory') return p.label;
  const name = t(currentLang, 'part_' + p.part);
  return p.count ? `${name} (${p.count})` : name;
}

// Two-column name / number list, the first `limit` rows with a "show all" toggle.
function nameList(rows, limit) {
  const wrap = el('div');
  const list = el('div', 'list');
  const draw = (all) => {
    list.replaceChildren();
    for (const [name, value] of all ? rows : rows.slice(0, limit)) {
      const n = el('span', 'rowName', name);
      n.title = name;
      list.appendChild(n);
      list.appendChild(el('span', 'num', value));
    }
  };
  draw(false);
  wrap.appendChild(list);
  if (rows.length > limit) {
    const more = el('button', 'linkBtn', t(currentLang, 'showAll') + ` (${rows.length})`);
    let all = false;
    more.addEventListener('click', () => {
      all = !all;
      draw(all);
      more.textContent = all ? t(currentLang, 'showLess') : t(currentLang, 'showAll') + ` (${rows.length})`;
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function renderDetail(d) {
  const info = live.get(d.id);
  const mine = [...sessions.values()].find((s) => s.sessionId === d.id);
  $('detailProject').textContent = projectName(d.cwd);
  $('detailTitle').textContent = titles[d.id] || (mine && activeTitle(mine)) || info?.title || d.title || '—';

  const body = $('detailBody');
  const scroll = body.scrollTop;
  body.replaceChildren();

  // Status, model, last activity
  const top = el('div', 'dTop');
  top.appendChild(statusPill(info ? info.status : 'ended'));
  const model = (mine && mine.model) || d.model;
  if (model) top.appendChild(el('span', 'model', model));
  if (d.models.length > 1) top.appendChild(el('span', null, d.models.join(' → ')));
  if (d.lastActiveAt) top.appendChild(el('span', null, relativeTime(d.lastActiveAt)));
  body.appendChild(section(null, top));

  // Tokens
  const tk = d.tokens;
  body.appendChild(
    section(
      t(currentLang, 'd_tokens'),
      statGrid([
        [t(currentLang, 'd_input'), fmt(tk.input)],
        [t(currentLang, 'd_output'), fmt(tk.output)],
        [t(currentLang, 'd_total'), fmt(tk.input + tk.output), 'accent'],
        [t(currentLang, 'd_cacheRead'), fmt(tk.cacheRead)],
        [t(currentLang, 'd_cacheWrite'), fmt(tk.cacheCreate)],
      ])
    )
  );

  // Activity
  const c = d.counts;
  body.appendChild(
    section(
      t(currentLang, 'd_activity'),
      statGrid([
        [t(currentLang, 'd_messages'), fmt(c.user)],
        [t(currentLang, 'd_turns'), fmt(c.assistant)],
        [t(currentLang, 'd_toolCalls'), fmt(c.tool)],
        [t(currentLang, 'd_subagents'), fmt(c.subagents)],
        [t(currentLang, 'd_working'), duration(d.activeMs)],
        [t(currentLang, 'd_elapsed'), duration(d.openMs)],
      ])
    )
  );

  // Context window: static block + conversation against the model's window
  const ctx = d.context;
  if (ctx) {
    const bar = el('div', 'bar ctxBar');
    const st = el('span', 'static');
    st.style.width = (ctx.staticTokens / ctx.windowTokens) * 100 + '%';
    const cv = el('span', 'conv');
    cv.style.width = (ctx.conversationTokens / ctx.windowTokens) * 100 + '%';
    bar.append(st, cv);
    const pct = Math.round((ctx.current / ctx.windowTokens) * 100);
    body.appendChild(
      section(
        t(currentLang, 'd_context'),
        bar,
        statGrid([
          [t(currentLang, 'd_static'), fmt(ctx.staticTokens)],
          [t(currentLang, 'd_conversation'), fmt(ctx.conversationTokens)],
          [t(currentLang, 'd_free'), fmt(ctx.freeTokens)],
        ]),
        el('div', 'note', `${pct}% / ${compact(ctx.windowTokens)} tokens${model ? ' · ' + model : ''}`)
      )
    );

    // What the static block is made of
    if (ctx.staticParts.length) {
      const sec = section(t(currentLang, 'd_staticParts'));
      for (const p of ctx.staticParts) {
        sec.appendChild(shareRow(partLabel(p), p.tokens, ctx.staticTokens, p.part === 'rest'));
      }
      sec.appendChild(el('div', 'note', t(currentLang, 'd_staticNote').replace('{n}', fmt(ctx.staticTokens))));
      body.appendChild(sec);
    }
  }

  // Skills: loaded during the session, and the listing every turn carries
  if (d.skillsUsed.length || d.skillListing.length) {
    const sec = section(t(currentLang, 'd_skills'));
    if (d.skillsUsed.length) {
      sec.appendChild(el('div', 'dLabel sub', t(currentLang, 'd_skillsUsed')));
      sec.appendChild(
        nameList(
          d.skillsUsed.map((s) => [s.calls > 1 ? `${s.name} ×${s.calls}` : s.name, `${fmt(s.tokens)} tok`]),
          8
        )
      );
    } else {
      sec.appendChild(el('div', 'note', t(currentLang, 'd_noSkillsUsed')));
    }
    if (d.skillListing.length) {
      sec.appendChild(el('div', 'dLabel sub', t(currentLang, 'd_skillListing')));
      sec.appendChild(nameList(d.skillListing.map((s) => [s.name, `${fmt(s.tokens)} tok`]), 6));
    }
    body.appendChild(sec);
  }

  // Tools by call count
  if (d.tools.length) {
    body.appendChild(section(t(currentLang, 'd_tools'), nameList(d.tools.map((x) => [x.name, fmt(x.calls)]), 6)));
  }

  // Resume command
  const resume = el('div', 'resume');
  const cmd = `claude --resume ${d.id}`;
  resume.appendChild(el('code', null, cmd));
  const copy = el('button', null, t(currentLang, 'copy'));
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(cmd);
    copy.textContent = t(currentLang, 'copied');
  });
  resume.appendChild(copy);
  // Pasting the command into a running Claude prompt does nothing useful, so
  // offer to open it in a new tab instead. Hidden while the session runs.
  const running = live.has(d.id) || [...sessions.values()].some((s) => s.sessionId === d.id);
  if (!running) {
    const open = el('button', null, t(currentLang, 'resumeTitle'));
    open.addEventListener('click', () => {
      closeDetail();
      openLaunchModal({ id: d.id, agent: 'claude', cwd: d.cwd, title: titles[d.id] || d.title || d.id.slice(0, 8) });
    });
    resume.appendChild(open);
  }
  body.appendChild(section(null, resume));

  body.scrollTop = scroll;
}

async function loadDetail() {
  const id = detailId;
  if (!id) return;
  const d = await window.claudeTerm.sessionDetail(id);
  if (id !== detailId) return; // switched while loading
  if (!d) {
    $('detailTitle').textContent = '—';
    $('detailBody').replaceChildren(el('div', 'note', t(currentLang, 'd_notFound')));
    return;
  }
  renderDetail(d);
}

function openDetail(id) {
  const changed = id !== detailId;
  detailId = id;
  if (changed) {
    $('detailProject').textContent = '';
    $('detailTitle').textContent = '…';
    $('detailBody').replaceChildren();
  }
  $('detail').classList.add('open');
  $('detail').setAttribute('aria-hidden', 'false');
  loadDetail();
}

function closeDetail() {
  detailId = null;
  $('detail').classList.remove('open');
  $('detail').setAttribute('aria-hidden', 'true');
  const s = sessions.get(activeId);
  if (s) s.term.focus();
}

$('detailClose').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('ctxMenu').hidden) return closeMenu();
  if ($('settingsModal').classList.contains('open')) return $('settingsModal').classList.remove('open');
  if (detailId && !$('launchModal').classList.contains('open')) closeDetail();
});
// A running session keeps writing; re-read (cached by size + mtime) while open.
setInterval(() => {
  if (detailId && live.has(detailId)) loadDetail();
}, 3000);

// --- Language --------------------------------------------------------------

function applyLang() {
  document.documentElement.lang = currentLang; // so uppercase headers get "AKTİF", not "AKTIF"
  $('langPicker').value = currentLang;
  $('lblContext').textContent = t(currentLang, 'context') + ':';
  $('lblFiveHour').textContent = t(currentLang, 'fiveHour') + ':';
  $('lblWeekly').textContent = t(currentLang, 'weekly') + ':';
  $('btnNew').textContent = '+ ' + t(currentLang, 'newSession');
  $('lblActive').textContent = t(currentLang, 'active');
  $('lblHistory').textContent = t(currentLang, 'history');
  $('lblExternal').textContent = t(currentLang, 'external');
  $('lblLogin').textContent = t(currentLang, 'openAtLogin');
  $('loginToggle').title = t(currentLang, 'openAtLoginHint');
  fillThemePicker();
  $('placeholder').textContent = t(currentLang, 'placeholder');
  $('launchNormalLabel').textContent = t(currentLang, 'launchNormal');
  $('launchSkipLabel').textContent = t(currentLang, 'launchSkipPerm');
  $('agentLabel').textContent = t(currentLang, 'agent');
  $('btnSettings').title = t(currentLang, 'settings');
  $('settingsTitle').textContent = t(currentLang, 'settings');
  $('lblTermFont').textContent = t(currentLang, 'termFontSize');
  $('lblSidebarFont').textContent = t(currentLang, 'sidebarFontSize');
  $('btnSettingsReset').textContent = t(currentLang, 'reset');
  $('btnSettingsDone').textContent = t(currentLang, 'done');
  $('modelLabel').textContent = t(currentLang, 'model');
  $('effortLabel').textContent = t(currentLang, 'effort');
  $('folderLabel').textContent = t(currentLang, 'folder');
  $('btnFolder').textContent = t(currentLang, 'change');
  fillLaunchPickers();
  $('btnCancel').textContent = t(currentLang, 'cancel');
  render();
  if (detailId) loadDetail();
}

function fillThemePicker() {
  const icons = { auto: '◐', light: '☀', dark: '☾' };
  $('themePicker').replaceChildren(
    ...THEMES.map((v) => {
      const o = el('option', null, `${icons[v]} ${t(currentLang, 'theme_' + v)}`);
      o.value = v;
      return o;
    })
  );
  $('themePicker').value = themeChoice;
  $('themePicker').title = t(currentLang, 'theme');
}

$('themePicker').addEventListener('change', (e) => {
  themeChoice = e.target.value;
  try {
    localStorage.setItem('claudeterm-theme', themeChoice);
  } catch {}
  applyTheme();
});

// --- Open at login -----------------------------------------------------------

async function initLoginItem() {
  const { available, enabled } = await window.claudeTerm.getLoginItem();
  $('loginCheck').checked = enabled;
  $('loginCheck').disabled = !available;
  $('loginToggle').classList.toggle('disabled', !available);
}

$('loginCheck').addEventListener('change', async (e) => {
  e.target.checked = await window.claudeTerm.setLoginItem(e.target.checked);
});

$('langPicker').addEventListener('change', (e) => {
  currentLang = e.target.value;
  setLang(currentLang);
  applyLang();
});

applyTheme();
applySettings();
applyLang();
initLoginItem();
refreshHistory();
(async () => {
  await pollLive();
  if (!(await restoreOpenSessions())) openLaunchModal(null);
})();
