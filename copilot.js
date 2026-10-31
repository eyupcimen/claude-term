// Reads what GitHub Copilot CLI writes under ~/.copilot/session-state: one
// folder per session id holding workspace.yaml (cwd, summary) and events.jsonl,
// one {type, data, timestamp} event per line. The format is not documented,
// so every field is read defensively.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDirs, readHead, realpath, mtime, parseLines } = require('./agent-files');

const STATE_DIR = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state');
const HEAD_BYTES = 64 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every session's event log, newest first.
function eventFiles(root = STATE_DIR) {
  const out = [];
  for (const d of readDirs(root)) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
    const full = path.join(root, d.name, 'events.jsonl');
    const m = mtime(full);
    if (m != null) out.push({ full, id: d.name, mtime: m });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Top-level `key: value` lines from workspace.yaml; enough for cwd and summary.
function readWorkspace(eventsFile) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(path.dirname(eventsFile), 'workspace.yaml'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (!m || !m[2]) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Folds events into the same shape Claude Code's status line gives.
function applyLines(state, lines) {
  for (const e of parseLines(lines)) {
    const d = e.data || {};
    switch (e.type) {
      case 'session.start':
        state.sessionId = d.sessionId || state.sessionId;
        state.cwd = d.context?.cwd || state.cwd;
        state.startedAt = Date.parse(d.startTime || e.timestamp) || null;
        state.model = d.selectedModel || d.model || state.model;
        break;
      case 'session.model_change':
        state.model = d.newModel || d.model || state.model;
        break;
      case 'user.message':
        state.status = 'busy';
        if (!state.firstPrompt && typeof d.content === 'string' && d.content.trim()) {
          state.firstPrompt = d.content.trim().replace(/\s+/g, ' ').slice(0, 200);
        }
        break;
      case 'assistant.turn_start':
        state.status = 'busy';
        break;
      case 'assistant.turn_end':
      case 'session.idle':
      case 'session.shutdown':
        state.status = 'idle';
        break;
    }
  }
  return state;
}

function readSession(file) {
  try {
    return applyLines({}, readHead(file, HEAD_BYTES).split('\n'));
  } catch {
    return null;
  }
}

function listCopilotHistory(limit = 40) {
  const out = [];
  for (const f of eventFiles()) {
    if (out.length >= limit) break;
    const ws = readWorkspace(f.full);
    const head = readSession(f.full) || {};
    const title = ws.name || ws.summary || head.firstPrompt;
    if (!title) continue; // nothing was ever asked in this session
    out.push({ id: f.id, cwd: ws.cwd || head.cwd || null, title, mtime: f.mtime, agent: 'copilot' });
  }
  return out;
}

function findSessionFile(id) {
  const full = path.join(STATE_DIR, id, 'events.jsonl');
  return mtime(full) != null ? full : null;
}

function findNewSessionFile(cwd, since, taken) {
  const dir = realpath(cwd);
  for (const f of eventFiles()) {
    if (f.mtime < since - 2000) break;
    if (taken.has(f.full)) continue;
    const head = readSession(f.full);
    const at = head?.cwd || readWorkspace(f.full).cwd;
    if (at && realpath(at) === dir && head.startedAt >= since - 2000) return f.full;
  }
  return null;
}

// Copilot's own short title, once it has written one.
function sessionTitle(file) {
  const ws = readWorkspace(file);
  return ws.name || ws.summary || null;
}

module.exports = { listCopilotHistory, findSessionFile, findNewSessionFile, applyLines, sessionTitle };
