// Hands a past session to another agent: the readable part of its transcript
// (what was asked and answered, no tool output) goes into a Markdown file the
// new agent is asked to read first. No model call, so no extra tokens.

const fs = require('fs');
const path = require('path');
const { parseLines } = require('./agent-files');
const { findTranscript } = require('./sessions');
const codex = require('./codex');
const gemini = require('./gemini');
const copilot = require('./copilot');

const NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot CLI' };
// Keep the newest part; ~25k tokens is plenty to pick up from.
const MAX_CHARS = 100000;

function partsText(content, types) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && types.includes(c.type) && c.text)
    .map((c) => c.text)
    .join('\n');
}

// Injected context (environment notes, AGENTS.md, slash-command wrappers).
const isInjected = (text) => text.startsWith('<') || text.startsWith('# AGENTS.md');

const READERS = {
  claude: (records) =>
    records.flatMap((r) => {
      if (r.type === 'user' && !r.isMeta) {
        const text = partsText(r.message?.content, ['text']).trim();
        return text && !isInjected(text) ? [{ role: 'user', text }] : [];
      }
      if (r.type === 'assistant') {
        const text = partsText(r.message?.content, ['text']).trim();
        return text ? [{ role: 'agent', text }] : [];
      }
      return [];
    }),
  codex: (records) =>
    records.flatMap((r) => {
      const p = r.payload || {};
      if (r.type !== 'response_item' || p.type !== 'message') return [];
      const text = partsText(p.content, ['input_text', 'output_text']).trim();
      if (!text) return [];
      if (p.role === 'user') return isInjected(text) ? [] : [{ role: 'user', text }];
      if (p.role === 'assistant') return [{ role: 'agent', text }];
      return [];
    }),
  // A Gemini message is rewritten as it streams; the last copy of an id wins.
  gemini: (records) => {
    const byId = new Map();
    for (const r of records) {
      if (r.type !== 'user' && r.type !== 'gemini') continue;
      const text = partsText(r.content, ['text']).trim() || (typeof r.content === 'string' ? r.content.trim() : '');
      if (text) byId.set(r.id || byId.size, { role: r.type === 'user' ? 'user' : 'agent', text });
    }
    return [...byId.values()];
  },
  copilot: (records) =>
    records.flatMap((r) => {
      const text = typeof r.data?.content === 'string' ? r.data.content.trim() : '';
      if (!text) return [];
      if (r.type === 'user.message') return [{ role: 'user', text }];
      if (r.type === 'assistant.message') return [{ role: 'agent', text }];
      return [];
    }),
};

const FINDERS = {
  claude: findTranscript,
  codex: codex.findRollout,
  gemini: gemini.findSessionFile,
  copilot: copilot.findSessionFile,
};

function canHandOff(agent) {
  return agent in READERS;
}

function buildMarkdown(agent, cwd, turns) {
  const name = NAMES[agent];
  const blocks = turns.map((t) => `## ${t.role === 'user' ? 'User' : name}\n\n${t.text}`);
  // Drop the oldest turns until it fits.
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  let start = 0;
  while (total > MAX_CHARS && start < blocks.length - 1) total -= blocks[start++].length + 2;
  const head = [
    `# Earlier session with ${name}`,
    cwd ? `Folder: ${cwd}` : null,
    start ? `(The first ${start} of ${blocks.length} messages are left out.)` : null,
  ].filter(Boolean);
  return [head.join('\n\n'), ...blocks.slice(start)].join('\n\n') + '\n';
}

// Writes the handoff file under `dir` and returns its path, or null when the
// session can't be read.
function prepareHandoff({ agent, id, cwd }, dir) {
  if (!canHandOff(agent)) return null;
  const file = FINDERS[agent](id);
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const turns = READERS[agent](parseLines(text.split('\n')));
  if (!turns.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `handoff-${agent}-${id.slice(0, 8)}.md`);
  fs.writeFileSync(out, buildMarkdown(agent, cwd, turns));
  return out;
}

function handoffPrompt(file, fromAgent) {
  return (
    `Read ${file} first: it is the conversation from an earlier ${NAMES[fromAgent]} session in this folder. ` +
    'Tell me in a few lines where it left off and what is still open, then wait for my next instruction.'
  );
}

module.exports = { prepareHandoff, handoffPrompt, canHandOff, buildMarkdown, READERS };
