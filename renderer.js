const LOCALE_MAP = { en: 'en-US', de: 'de-DE', tr: 'tr-TR', es: 'es-ES' };

let currentLang = detectLang();
// name -> { percent, resetsAt (Date|null), resetText (string|null) }
const limits = { fiveHour: null, weekly: null };
let lastStatus = null;

const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, monospace',
  theme: { background: '#1e1e1e' },
  scrollback: 2000,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

term.onData((data) => window.claudeTerm.sendInput(data));

window.claudeTerm.onPtyData((data) => {
  term.write(data);
  scheduleLimitScan();
});

function doResize() {
  fitAddon.fit();
  window.claudeTerm.resize(term.cols, term.rows);
}
window.addEventListener('resize', doResize);
setTimeout(doResize, 200);

// --- Launch picker -------------------------------------------------------

document.getElementById('btnNormal').addEventListener('click', () => launch(''));
document.getElementById('btnSkipPerm').addEventListener('click', () =>
  launch('--dangerously-skip-permissions')
);

const modelPicker = document.getElementById('modelPicker');
try {
  modelPicker.value = localStorage.getItem('claudeterm-model') || '';
} catch {}

function launch(extraFlags) {
  const model = modelPicker.value;
  try {
    localStorage.setItem('claudeterm-model', model);
  } catch {}
  const flags = [model ? `--model ${model}` : '', extraFlags].filter(Boolean).join(' ');
  document.getElementById('launchModal').remove();
  window.claudeTerm.sendLaunchCommand(flags);
  term.focus();
}

// --- Status from Claude Code's status line feed --------------------------

function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

window.claudeTerm.onStatusUpdate((status) => {
  lastStatus = status;
  if (status.fiveHour) {
    limits.fiveHour = {
      percent: Math.round(status.fiveHour.used_percentage),
      resetsAt: toDate(status.fiveHour.resets_at),
    };
  }
  if (status.weekly) {
    limits.weekly = {
      percent: Math.round(status.weekly.used_percentage),
      resetsAt: toDate(status.weekly.resets_at),
    };
  }
  render();
});

// --- Fallback: read the limit line Claude Code prints on screen ----------
// e.g. "You've used 89% of your weekly limit · resets Oct 12 at 4am (Europe/Berlin)"
// Only used until the status line feed delivers real numbers.

let scanPending = false;

function scheduleLimitScan() {
  if (scanPending) return;
  scanPending = true;
  setTimeout(() => {
    scanPending = false;
    scanBufferForLimits();
  }, 400);
}

function scanBufferForLimits() {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - 300);
  const re = /(\d{1,3})%\s+of\s+your\s+([a-zA-Z0-9 \-]+?)\s+limit(?:[^a-zA-Z0-9]+resets?\s+([^\n]+))?/i;
  let changed = false;

  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const m = re.exec(line.translateToString(true));
    if (!m) continue;
    const name = m[2].toLowerCase();
    const key = name.includes('week') ? 'weekly' : /5|session|hour/.test(name) ? 'fiveHour' : null;
    if (!key || (limits[key] && limits[key].resetsAt)) continue; // feed data wins
    limits[key] = { percent: parseInt(m[1], 10), resetsAt: null, resetText: (m[3] || '').trim() };
    changed = true;
  }
  if (changed) render();
}

// --- Rendering -------------------------------------------------------------

function formatReset(entry, key) {
  if (entry.resetsAt) {
    const opts =
      key === 'weekly'
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' };
    return `${t(currentLang, 'resets')} ${entry.resetsAt.toLocaleString(LOCALE_MAP[currentLang], opts)}`;
  }
  return entry.resetText || '';
}

function renderLimit(id, key) {
  const entry = limits[key];
  const el = document.getElementById(id);
  if (!entry) {
    el.textContent = '—';
    el.className = '';
    return;
  }
  const left = 100 - entry.percent;
  let text = `${entry.percent}% ${t(currentLang, 'used')} (${left}% ${t(currentLang, 'remaining')})`;
  const reset = formatReset(entry, key);
  if (reset) text += ` · ${reset}`;
  el.textContent = text;
  el.className = entry.percent >= 90 ? 'danger' : entry.percent >= 70 ? 'warn' : '';
}

function render() {
  const locale = LOCALE_MAP[currentLang] || 'en-US';
  const ctxEl = document.getElementById('tokenCount');
  if (lastStatus && lastStatus.contextTokens != null) {
    let text = lastStatus.contextTokens.toLocaleString(locale);
    if (lastStatus.contextPct != null) text += ` (${Math.round(lastStatus.contextPct)}%)`;
    ctxEl.textContent = text;
  } else {
    ctxEl.textContent = '—';
  }

  renderLimit('fiveHourLimit', 'fiveHour');
  renderLimit('weeklyLimit', 'weekly');

  const project = lastStatus && lastStatus.project;
  document.title = project ? `ClaudeTerm — ${projectName(project, lastStatus.home)}` : 'ClaudeTerm';
}

function projectName(dir, home) {
  if (home && dir === home) return '~';
  return dir.split('/').filter(Boolean).pop() || dir;
}

// --- Language --------------------------------------------------------------

function applyLang() {
  document.getElementById('langPicker').value = currentLang;
  document.getElementById('lblContext').textContent = t(currentLang, 'context') + ':';
  document.getElementById('lblFiveHour').textContent = t(currentLang, 'fiveHour') + ':';
  document.getElementById('lblWeekly').textContent = t(currentLang, 'weekly') + ':';
  const title = document.getElementById('launchTitle');
  if (title) {
    title.textContent = t(currentLang, 'launchTitle');
    document.getElementById('launchNormalLabel').textContent = t(currentLang, 'launchNormal');
    document.getElementById('launchSkipLabel').textContent = t(currentLang, 'launchSkipPerm');
    document.getElementById('modelLabel').textContent = t(currentLang, 'model');
    document.getElementById('modelDefaultOpt').textContent = t(currentLang, 'modelDefault');
  }
  render();
}

document.getElementById('langPicker').addEventListener('change', (e) => {
  currentLang = e.target.value;
  setLang(currentLang);
  applyLang();
});

applyLang();
