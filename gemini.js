// Reads what Gemini CLI writes under ~/.gemini: per project folder a directory
// tmp/<project id>/ holding .project_root (the folder's path) and
// chats/session-<time>-<short id>.jsonl, one JSON record per line: session
// metadata first, then messages and {"$set": {...}} metadata updates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDirs, readHead, realpath, mtime, parseLines } = require('./agent-files');

const TMP_DIR = path.join(os.homedir(), '.gemini', 'tmp');
const HEAD_BYTES = 64 * 1024;
// Gemini models take a 1M-token prompt.
const CONTEXT_WINDOW = 1048576;

// Every main-session chat file with the project folder it belongs to, newest first.
function chatFiles(root = TMP_DIR) {
  const out = [];
  for (const d of readDirs(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let cwd = null;
    try {
      cwd = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim();
    } catch {
      continue;
    }
    const chats = path.join(dir, 'chats');
    for (const f of readDirs(chats)) {
      if (!f.isFile() || !/^session-.*\.jsonl$/.test(f.name)) continue;
      const full = path.join(chats, f.name);
      const m = mtime(full);
      if (m != null) out.push({ full, cwd, mtime: m });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || '').join(' ');
  return '';
}

// Folds chat records into the same shape Claude Code's status line gives.
function applyLines(state, lines) {
  for (const r of parseLines(lines)) {
    if (r.$set) {
      if (r.$set.summary) state.title = r.$set.summary;
      continue;
    }
    if (r.sessionId && !r.type) {
      state.sessionId = r.sessionId;
      state.kind = r.kind;
      state.startedAt = Date.parse(r.startTime) || null;
      if (r.summary) state.title = r.summary;
      continue;
    }
    if (r.type === 'user') {
      state.status = 'busy';
      if (!state.firstPrompt) {
        const t = textOf(r.content).trim();
        if (t && !t.startsWith('/')) state.firstPrompt = t.replace(/\s+/g, ' ').slice(0, 200);
      }
    } else if (r.type === 'gemini') {
      if (r.model) state.model = r.model;
      // Tokens are recorded once the reply is complete.
      if (r.tokens) {
        state.status = 'idle';
        state.contextTokens = r.tokens.input || 0;
        state.contextPct = (state.contextTokens / CONTEXT_WINDOW) * 100;
      }
    } else if (r.type === 'error' || r.type === 'info') {
      state.status = 'idle';
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

function listGeminiHistory(limit = 40) {
  const out = [];
  for (const f of chatFiles()) {
    if (out.length >= limit) break;
    let state;
    try {
      // The title can be set late, so the whole (usually small) file is read.
      state = applyLines({}, fs.readFileSync(f.full, 'utf8').split('\n'));
    } catch {
      continue;
    }
    if (!state.sessionId || state.kind === 'subagent') continue;
    const title = state.title || state.firstPrompt;
    if (!title) continue; // nothing was ever asked in this session
    out.push({ id: state.sessionId, cwd: f.cwd, title, mtime: f.mtime, agent: 'gemini' });
  }
  return out;
}

// Chat files are named after the first 8 characters of the session id.
function findSessionFile(id) {
  const short = id.slice(0, 8);
  for (const f of chatFiles()) {
    if (!f.full.endsWith(`-${short}.jsonl`)) continue;
    if (readSession(f.full)?.sessionId === id) return f.full;
  }
  return null;
}

function findNewSessionFile(cwd, since, taken) {
  const dir = realpath(cwd);
  for (const f of chatFiles()) {
    if (f.mtime < since - 2000) break;
    if (taken.has(f.full) || realpath(f.cwd) !== dir) continue;
    const head = readSession(f.full);
    if (head?.sessionId && head.kind !== 'subagent' && head.startedAt >= since - 2000) return f.full;
  }
  return null;
}

module.exports = { listGeminiHistory, findSessionFile, findNewSessionFile, applyLines };
