// Reads what Codex CLI writes under ~/.codex: one rollout transcript per
// session in sessions/YYYY/MM/DD, and thread names in session_index.jsonl.
// Codex has no status line hook, so a running session is followed by tailing
// its rollout file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDirs, readHead: readBytes, realpath } = require('./agent-files');

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');
const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
// The first line carries Codex's whole system prompt, so read generously.
const HEAD_BYTES = 256 * 1024;

// Every rollout file, newest first. Folders are named by date, so walking them
// in reverse lets callers stop early.
function rolloutFiles(root = SESSIONS_DIR) {
  const out = [];
  const byName = (a, b) => b.name.localeCompare(a.name);
  for (const y of readDirs(root).filter((d) => d.isDirectory()).sort(byName)) {
    for (const m of readDirs(path.join(root, y.name)).filter((d) => d.isDirectory()).sort(byName)) {
      for (const d of readDirs(path.join(root, y.name, m.name)).filter((d) => d.isDirectory()).sort(byName)) {
        const dir = path.join(root, y.name, m.name, d.name);
        for (const f of readDirs(dir)) {
          const match = f.isFile() && ID_RE.exec(f.name);
          if (!match) continue;
          const full = path.join(dir, f.name);
          try {
            out.push({ full, id: match[1], mtime: fs.statSync(full).mtimeMs });
          } catch {}
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readHead(file) {
  return readBytes(file, HEAD_BYTES);
}

// cwd and start time from the session_meta line, which may be cut off by
// HEAD_BYTES, so they are matched rather than parsed.
function metaFrom(head) {
  const first = head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n'));
  const str = (key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(first);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return null;
    }
  };
  const ts = Date.parse(str('timestamp'));
  // Reviewers and other helpers Codex spawns get their own rollout.
  const subagent = first.includes('"source":{"subagent"');
  return { cwd: str('cwd'), startedAt: isNaN(ts) ? null : ts, subagent };
}

// The first thing typed, as a fallback title.
function firstPrompt(head) {
  for (const line of head.split('\n')) {
    if (!line.includes('"user_message"')) continue;
    try {
      const o = JSON.parse(line);
      const text = (o.payload?.message || '').trim();
      if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').slice(0, 200);
    } catch {}
  }
  return null;
}

// Codex's own short thread names, by session id; the latest entry wins.
function threadNames(file = INDEX_FILE) {
  const names = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.id && o.thread_name) names.set(o.id, o.thread_name);
    } catch {}
  }
  return names;
}

function listCodexHistory(limit = 40) {
  const names = threadNames();
  const out = [];
  for (const f of rolloutFiles()) {
    if (out.length >= limit) break;
    let head;
    try {
      head = readHead(f.full);
    } catch {
      continue;
    }
    const meta = metaFrom(head);
    if (meta.subagent) continue;
    const title = names.get(f.id) || firstPrompt(head);
    if (!title) continue; // nothing was ever asked in this session
    out.push({ id: f.id, cwd: meta.cwd, title, mtime: f.mtime, agent: 'codex' });
  }
  return out;
}

function findRollout(id) {
  const f = rolloutFiles().find((r) => r.id === id);
  return f ? f.full : null;
}

// The rollout a session we just started in `cwd` writes to: the newest one
// begun after `since` that no other session of ours has claimed.
function findNewRollout(cwd, since, taken) {
  const dir = realpath(cwd);
  for (const f of rolloutFiles()) {
    if (f.mtime < since - 2000) break;
    if (taken.has(f.full)) continue;
    let meta;
    try {
      meta = metaFrom(readHead(f.full));
    } catch {
      continue;
    }
    if (meta.cwd && realpath(meta.cwd) === dir && meta.startedAt != null && meta.startedAt >= since - 2000) return f.full;
  }
  return null;
}

const LIMIT_KEYS = { 300: 'fiveHour', 10080: 'weekly' };

// Folds rollout lines into the same shape Claude Code's status line gives.
function applyLines(state, lines) {
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload || {};
    if (o.type === 'session_meta') state.sessionId = p.id || p.session_id || state.sessionId;
    else if (o.type === 'turn_context' && p.model) state.model = p.model;
    else if (o.type !== 'event_msg') continue;
    else if (p.type === 'thread_settings_applied') state.model = p.thread_settings?.model || state.model;
    else if (p.type === 'task_started') state.status = 'busy';
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') state.status = 'idle';
    else if (p.type === 'token_count') {
      const last = p.info?.last_token_usage;
      const window = p.info?.model_context_window;
      if (last) {
        state.contextTokens = last.input_tokens || 0;
        state.contextPct = window ? (state.contextTokens / window) * 100 : null;
      }
      for (const lim of [p.rate_limits?.primary, p.rate_limits?.secondary]) {
        const key = lim && LIMIT_KEYS[lim.window_minutes];
        if (key) state[key] = { used_percentage: lim.used_percent, resets_at: lim.resets_at };
      }
    }
  }
  return state;
}

module.exports = { listCodexHistory, findRollout, findNewRollout, applyLines, threadNames, metaFrom, rolloutFiles };
