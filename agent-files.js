// Small file helpers shared by the readers for Codex, Gemini and Copilot logs.

const fs = require('fs');

function readDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

module.exports = { readDirs, readHead, realpath, mtime, parseLines };
