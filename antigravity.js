// Antigravity CLI (`agy`) keeps one conversation file per session, named by its
// id, in ~/.gemini/antigravity-cli/conversations. The file format is not
// documented, so only ids and times are read: enough to list, resume and
// restore sessions, not to show their status or context.

const os = require('os');
const path = require('path');
const { readDirs, mtime } = require('./agent-files');

const CONV_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]+)?$/i;

function conversationFiles(root = CONV_DIR) {
  const out = [];
  for (const f of readDirs(root)) {
    const m = f.isFile() && ID_RE.exec(f.name);
    if (!m) continue;
    const full = path.join(root, f.name);
    const t = mtime(full);
    if (t != null) out.push({ full, id: m[1], mtime: t });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function listAntigravityHistory(limit = 40) {
  return conversationFiles()
    .slice(0, limit)
    .map((f) => ({ id: f.id, cwd: null, title: `Antigravity ${f.id.slice(0, 8)}`, mtime: f.mtime, agent: 'antigravity' }));
}

function findSessionFile(id) {
  const f = conversationFiles().find((c) => c.id === id);
  return f ? f.full : null;
}

// Without a readable cwd, the newest conversation begun after launch is ours.
function findNewSessionFile(_cwd, since, taken) {
  const f = conversationFiles().find((c) => c.mtime >= since - 2000 && !taken.has(c.full));
  return f ? f.full : null;
}

function idFromFile(file) {
  return ID_RE.exec(path.basename(file))[1];
}

module.exports = { listAntigravityHistory, findSessionFile, findNewSessionFile, idFromFile };
