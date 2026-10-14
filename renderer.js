const LOCALE_MAP = { en: 'en-US', de: 'de-DE', tr: 'tr-TR', es: 'es-ES' };

let currentLang = detectLang();
let homeDir = null;
let activeId = null;
let history = [];
let pendingResume = null; // { id, cwd, title } when the modal is for resuming

// id -> { term, fit, pane, project, sessionId, contextTokens, contextPct, model }
const sessions = new Map();
// Plan limits are account-wide, so any session's feed updates them for all.
const limits = { fiveHour: null, weekly: null };
let editing = false; // sidebar re-renders are paused while a title is being edited

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
    fontSize: 14,
    fontFamily: 'Menlo, monospace',
    theme: { background: '#1e1e1e' },
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
  if (s) {
    s.sessionId = msg.sessionId || s.sessionId;
    // A title typed before Claude Code reported its session id is saved now.
    if (s.customTitle !== undefined && s.sessionId) {
      saveTitle(s.sessionId, s.customTitle);
      delete s.customTitle;
    }
    s.project = msg.project || s.project;
    s.model = msg.model || s.model;
    s.aiTitle = msg.aiTitle || s.aiTitle;
    s.contextTokens = msg.contextTokens;
    s.contextPct = msg.contextPct;
  }
  if (msg.fiveHour) {
    limits.fiveHour = {
      percent: Math.round(msg.fiveHour.used_percentage),
      resetsAt: toDate(msg.fiveHour.resets_at),
    };
  }
  if (msg.weekly) {
    limits.weekly = {
      percent: Math.round(msg.weekly.used_percentage),
      resetsAt: toDate(msg.weekly.resets_at),
    };
  }
  render();
});

// --- Launch modal ----------------------------------------------------------

const modelPicker = $('modelPicker');
const effortPicker = $('effortPicker');

// Full model names pin an exact version; `hint` is an i18n key. Prices are
// $ per million input/output tokens and track how fast plan limits drain.
const MODELS = [
  { value: '', label: null },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · $1/$5', hint: 'hintCheapest' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 · $2/$10', hint: 'hintBalanced' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5 · $4/$20', hint: 'hintStrong' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'hintFable' },
];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
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

// Sonnet by default: half the per-token price of Opus, so it uses up plan limits slower.
let chosenModel = loadChoice('claudeterm-model', MODELS.map((m) => m.value), 'claude-sonnet-5');
let chosenEffort = loadChoice('claudeterm-effort', EFFORTS, '');

function fillLaunchPickers() {
  modelPicker.replaceChildren(
    ...MODELS.map((m) => {
      const o = el('option', null, m.label || t(currentLang, 'modelDefault'));
      o.value = m.value;
      return o;
    })
  );
  effortPicker.replaceChildren(
    ...EFFORTS.map((e) => {
      const o = el('option', null, t(currentLang, e ? 'effort_' + e : 'modelDefault'));
      o.value = e;
      return o;
    })
  );
  modelPicker.value = chosenModel;
  effortPicker.value = chosenEffort;
  renderModelHint();
}

function renderModelHint() {
  const m = MODELS.find((x) => x.value === modelPicker.value);
  const parts = [];
  if (m && m.hint) parts.push(t(currentLang, m.hint));
  parts.push(t(currentLang, 'effortHint'));
  $('modelHint').textContent = parts.join(' ');
}

modelPicker.addEventListener('change', () => {
  chosenModel = modelPicker.value;
  renderModelHint();
});
effortPicker.addEventListener('change', () => {
  chosenEffort = effortPicker.value;
});

function openLaunchModal(resume) {
  pendingResume = resume || null;
  $('launchTitle').textContent = t(currentLang, resume ? 'resumeTitle' : 'launchTitle');
  $('launchSubtitle').textContent = resume ? resume.title : '';
  $('launchSubtitle').style.display = resume ? 'block' : 'none';
  $('launchModal').classList.add('open');
}

function closeLaunchModal() {
  $('launchModal').classList.remove('open');
  pendingResume = null;
}

async function launch(extraFlags) {
  const model = modelPicker.value;
  const effort = effortPicker.value;
  try {
    localStorage.setItem('claudeterm-model', model);
    localStorage.setItem('claudeterm-effort', effort);
  } catch {}
  const flags = [model ? `--model ${model}` : '', effort ? `--effort ${effort}` : '', extraFlags]
    .filter(Boolean)
    .join(' ');
  const resume = pendingResume;
  closeLaunchModal();

  const { id, cwd, home } = await window.claudeTerm.createSession({
    flags,
    resumeId: resume?.id,
    cwd: resume?.cwd,
  });
  homeDir = home;
  sessions.set(id, {
    ...createTermPane(id),
    project: cwd,
    sessionId: resume?.id || null,
    aiTitle: resume?.title || null,
    contextTokens: null,
    contextPct: null,
    model: null,
  });
  setActive(id);
  if (resume) renderSidebar();
}

$('btnNew').addEventListener('click', () => openLaunchModal(null));
$('btnNormal').addEventListener('click', () => launch(''));
$('btnSkipPerm').addEventListener('click', () => launch('--dangerously-skip-permissions'));
$('btnCancel').addEventListener('click', closeLaunchModal);

// --- Sidebar ---------------------------------------------------------------

async function refreshHistory() {
  const res = await window.claudeTerm.listHistory();
  homeDir = res.home;
  history = res.items;
  renderSidebar();
}

function activeTitle(s) {
  if (s.customTitle) return s.customTitle;
  return (s.sessionId && titles[s.sessionId]) || s.aiTitle || projectName(s.project);
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

function itemActions(item, nameEl, current, onSave, onClose) {
  const actions = el('div', 'actions');
  const rename = el('span', 'btn', '✎');
  rename.title = t(currentLang, 'rename');
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(nameEl, current, onSave);
  });
  actions.appendChild(rename);
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
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(nameEl, current, onSave);
  });
}

function renderSidebar() {
  if (editing) return;
  const active = $('activeList');
  active.replaceChildren();
  if (!sessions.size) active.appendChild(el('div', 'empty', t(currentLang, 'noActive')));
  for (const [id, s] of sessions) {
    const item = el('div', 'item' + (id === activeId ? ' active' : ''));
    const title = activeTitle(s);
    item.title = title;
    const name = el('div', 'name');
    name.appendChild(el('span', 'dot'));
    name.appendChild(document.createTextNode(title));
    item.appendChild(name);
    const meta = [projectName(s.project), s.model];
    if (s.contextTokens != null) meta.push(`${s.contextTokens.toLocaleString(locale())} tok`);
    item.appendChild(el('div', 'meta', meta.filter(Boolean).join(' · ') || '…'));
    itemActions(
      item,
      name,
      title,
      (v) => setActiveTitle(s, v),
      () => {
        window.claudeTerm.closeSession(id);
        removeSession(id);
      }
    );
    item.addEventListener('click', () => setActive(id));
    active.appendChild(item);
  }

  const live = new Set([...sessions.values()].map((s) => s.sessionId).filter(Boolean));
  const list = $('historyList');
  list.replaceChildren();
  const items = history.filter((h) => !live.has(h.id));
  if (!items.length) list.appendChild(el('div', 'empty', t(currentLang, 'noHistory')));
  for (const h of items) {
    const item = el('div', 'item');
    const title = titles[h.id] || h.title;
    item.title = title;
    const name = el('div', 'name', title);
    item.appendChild(name);
    item.appendChild(el('div', 'meta', `${projectName(h.cwd)} · ${relativeTime(h.mtime)}`));
    itemActions(item, name, title, (v) => saveTitle(h.id, v));
    item.addEventListener('click', () => openLaunchModal({ ...h, title }));
    list.appendChild(item);
  }
}

// Section headers fold their list: Active starts open, History closed.
for (const header of document.querySelectorAll('.sectionTitle')) {
  header.addEventListener('click', () => {
    const list = $(header.dataset.list);
    list.hidden = !list.hidden;
    header.classList.toggle('collapsed', list.hidden);
  });
}

// --- Status bar ------------------------------------------------------------

function renderLimit(id, key) {
  const entry = limits[key];
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
  renderLimit('fiveHourLimit', 'fiveHour');
  renderLimit('weeklyLimit', 'weekly');
  document.title = s ? `ClaudeTerm — ${projectName(s.project)}` : 'ClaudeTerm';
  renderSidebar();
}

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
  $('placeholder').textContent = t(currentLang, 'placeholder');
  $('launchTitle').textContent = t(currentLang, pendingResume ? 'resumeTitle' : 'launchTitle');
  $('launchNormalLabel').textContent = t(currentLang, 'launchNormal');
  $('launchSkipLabel').textContent = t(currentLang, 'launchSkipPerm');
  $('modelLabel').textContent = t(currentLang, 'model');
  $('effortLabel').textContent = t(currentLang, 'effort');
  fillLaunchPickers();
  $('btnCancel').textContent = t(currentLang, 'cancel');
  render();
}

$('langPicker').addEventListener('change', (e) => {
  currentLang = e.target.value;
  setLang(currentLang);
  applyLang();
});

applyLang();
refreshHistory();
openLaunchModal(null);
