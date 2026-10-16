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
// Every Claude Code session running on this machine, by session id, from
// ~/.claude/sessions. Ours get their status from it; the rest are listed apart.
let live = new Map();
let detailId = null; // session id whose detail panel is open

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
    fontSize: 14,
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
    // "Opus 5.5 (1M context)" → "Opus 5.5"; the window size is in the detail panel.
    s.model = (msg.model && msg.model.replace(/\s*\(.*\)$/, '')) || s.model;
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

function itemActions(item, nameEl, current, onSave, onClose, sessionId) {
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
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(nameEl, current, onSave);
    });
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

function renderSidebar() {
  if (editing) return;
  const active = $('activeList');
  active.replaceChildren();
  if (!sessions.size) active.appendChild(el('div', 'empty', t(currentLang, 'noActive')));
  for (const [id, s] of sessions) {
    const item = el('div', 'item' + (id === activeId ? ' active' : ''));
    const title = activeTitle(s);
    item.title = title;
    const info = s.sessionId && live.get(s.sessionId);
    const status = info ? info.status : 'idle';
    const name = nameRow(item, title, status, s.model || info?.model);
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
      s.sessionId
    );
    item.addEventListener('click', () => setActive(id));
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
    item.title = title;
    nameRow(item, title, l.status, l.model);
    metaRow(item, projectName(l.cwd), l.status);
    itemActions(item, null, title, null, null, l.id);
    item.addEventListener('click', () => openDetail(l.id));
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
    const name = nameRow(item, title, null, null);
    metaRow(item, `${projectName(h.cwd)} · ${relativeTime(h.mtime)}`);
    itemActions(item, name, title, (v) => saveTitle(h.id, v), null, h.id);
    item.addEventListener('click', () => openLaunchModal({ ...h, title }));
    list.appendChild(item);
  }
}

async function pollLive() {
  try {
    const list = await window.claudeTerm.listLive();
    live = new Map(list.map((l) => [l.id, l]));
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
  if (e.key === 'Escape' && detailId && !$('launchModal').classList.contains('open')) closeDetail();
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
  fillThemePicker();
  $('placeholder').textContent = t(currentLang, 'placeholder');
  $('launchTitle').textContent = t(currentLang, pendingResume ? 'resumeTitle' : 'launchTitle');
  $('launchNormalLabel').textContent = t(currentLang, 'launchNormal');
  $('launchSkipLabel').textContent = t(currentLang, 'launchSkipPerm');
  $('modelLabel').textContent = t(currentLang, 'model');
  $('effortLabel').textContent = t(currentLang, 'effort');
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

$('langPicker').addEventListener('change', (e) => {
  currentLang = e.target.value;
  setLang(currentLang);
  applyLang();
});

applyTheme();
applyLang();
refreshHistory();
pollLive();
openLaunchModal(null);
