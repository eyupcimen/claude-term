// Reads what Claude Code itself writes under ~/.claude: which sessions are
// running right now (~/.claude/sessions) and, for one session, a full pass over
// its transcript (tokens, activity, what the static context is made of).
// Read-only; the formats are private, so every field is treated as optional.
// Approach adapted from meyusufdemirci/claude-code-session-tracker (MIT).

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

// --- Models ----------------------------------------------------------------

// `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`.
function modelLabel(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function contextWindowFor(id) {
  if (!id) return undefined;
  if (/haiku|claude-3|-4-5|-4-1|-4-0/.test(id)) return 200_000;
  return 1_000_000;
}

// --- Running sessions ------------------------------------------------------

function respondsToSignal(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// `Wed Oct 14 10:07:21 2026` (ctime). Carries no zone, so both readings are returned.
function parseCtime(value) {
  const p = String(value).trim().split(/\s+/);
  if (p.length < 5) return null;
  const month = MONTHS[p[1].slice(0, 3).toLowerCase()];
  const [h, mi, s] = p[3].split(':').map(Number);
  const day = Number(p[2]);
  const year = Number(p[4]);
  if (month === undefined || [h, mi, s, day, year].some((n) => !Number.isInteger(n))) return null;
  return {
    utc: Date.UTC(year, month, day, h, mi, s),
    local: new Date(year, month, day, h, mi, s).getTime(),
  };
}

function processStartTimes(pids) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const times = new Map();
      for (const line of String(stdout).split('\n')) {
        const [pid, ...rest] = line.trim().split(/\s+/);
        const t = parseCtime(rest.join(' '));
        if (pid && t) times.set(Number(pid), t.local);
      }
      resolve(times.size ? times : null);
    });
  });
}

// Session files outlive their process and pids get recycled, so a record only
// counts as running when its pid is alive *and* started when the record says.
// Claude Code writes procStart in UTC while ps prints local time; accept either.
async function filterAlive(records) {
  const signalled = records.filter((r) => respondsToSignal(r.pid));
  if (!signalled.length) return [];
  const started = await processStartTimes([...new Set(signalled.map((r) => r.pid))]);
  if (!started) return signalled;
  return signalled.filter((r) => {
    const actual = started.get(r.pid);
    if (actual === undefined) return false;
    const claimed = r.procStart && parseCtime(r.procStart);
    if (!claimed) return true;
    return Math.abs(actual - claimed.utc) <= 2000 || Math.abs(actual - claimed.local) <= 2000;
  });
}

// `shell` (running a command) reads as busy; anything unfamiliar as idle.
function toStatus(v) {
  if (v === 'busy' || v === 'shell') return 'busy';
  if (v === 'waiting') return 'waiting';
  return 'idle';
}

async function listLive() {
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS_DIR).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
    } catch {
      continue; // half-written
    }
    const id = str(r.sessionId);
    const cwd = str(r.cwd);
    const pid = num(r.pid) ?? Number(name.split('.')[0]);
    if (!id || !cwd || !Number.isInteger(pid)) continue;
    records.push({
      id,
      pid,
      cwd,
      procStart: str(r.procStart),
      kind: str(r.kind),
      name: str(r.name),
      status: toStatus(r.status),
      waitingFor: str(r.waitingFor),
      startedAt: num(r.startedAt) ?? 0,
      updatedAt: num(r.updatedAt) ?? num(r.statusUpdatedAt) ?? 0,
    });
  }
  // Resuming leaves the old file behind under another pid; keep the newest.
  const newest = new Map();
  for (const r of await filterAlive(records)) {
    const prev = newest.get(r.id);
    if (!prev || r.updatedAt > prev.updatedAt) newest.set(r.id, r);
  }
  const out = [...newest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of out) {
    const file = findTranscript(r.id);
    const tail = file ? tailInfo(file) : {};
    r.title = tail.title || null;
    r.model = modelLabel(tail.model);
  }
  return out;
}

// --- Transcripts -----------------------------------------------------------

const transcriptPaths = new Map();

function findTranscript(id) {
  const cached = transcriptPaths.get(id);
  if (cached && fs.existsSync(cached)) return cached;
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, id + '.jsonl');
    if (fs.existsSync(f)) {
      transcriptPaths.set(id, f);
      return f;
    }
  }
  return null;
}

const TAIL_BYTES = 256 * 1024;

// Latest title and model, from the end of the file only.
function tailInfo(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  let title;
  let model;
  for (const line of text.split('\n')) {
    if (!line.includes('-title"') && !line.includes('"model"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    else if (o.type === 'assistant') {
      const m = str(o.message?.model);
      if (m && m !== '<synthetic>') model = m;
    }
  }
  return { title, model };
}

// --- Detail ----------------------------------------------------------------

// Characters per token. On the high side, so named rows understate a little
// and the unnamed "system prompt + tool schemas" remainder absorbs the rest.
const CHARS_PER_TOKEN = 4;
// Above this a record is a tool result or attachment, never an assistant turn.
const MAX_RECORD_CHARS = 256 * 1024;

const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const joinedLength = (arr) =>
  Array.isArray(arr) ? arr.reduce((n, e) => n + (typeof e === 'string' ? e : JSON.stringify(e ?? '')).length + 1, 0) : 0;

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function addUsage(t, u) {
  if (!u) return;
  t.input += num(u.input_tokens) ?? 0;
  t.output += num(u.output_tokens) ?? 0;
  t.cacheRead += num(u.cache_read_input_tokens) ?? 0;
  t.cacheCreate += num(u.cache_creation_input_tokens) ?? 0;
}

function shortPath(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// The pre-first-turn attachments that cost window space, as named slices.
function staticSlices(a) {
  switch (str(a.type)) {
    case 'instructions':
      return (Array.isArray(a.files) ? a.files : [])
        .filter((f) => str(f?.content))
        .map((f) => ({ part: 'memory', label: shortPath(str(f.path)) || 'CLAUDE.md', chars: f.content.length }));
    case 'nested_memory': {
      const text = str(obj(a.content)?.content);
      if (!text) return [];
      return [{ part: 'memory', label: str(a.displayPath) || shortPath(str(a.path)) || 'CLAUDE.md', chars: text.length }];
    }
    case 'skill_listing':
      return str(a.content) ? [{ part: 'skills', chars: a.content.length, count: skillLines(a.content).length }] : [];
    case 'deferred_tools_delta':
      return [{ part: 'tools', chars: joinedLength(a.addedLines), count: a.addedNames?.length }];
    case 'agent_listing_delta':
      return [{ part: 'agents', chars: joinedLength(a.addedLines), count: a.addedTypes?.length }];
    case 'mcp_instructions_delta':
      return [{ part: 'mcp', chars: joinedLength(a.addedBlocks), count: a.addedNames?.length }];
    default:
      return [];
  }
}

// `- name: description` lines of the skill listing, one entry per skill.
function skillLines(content) {
  const out = [];
  for (const line of content.split('\n')) {
    const m = /^- (\S+?):\s/.exec(line);
    if (m) out.push({ name: m[1].trim(), chars: line.length + 1 });
    else if (out.length) out[out.length - 1].chars += line.length + 1;
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

// A real user message, as opposed to a tool result or injected meta record.
function isUserMessage(r) {
  if (r.isMeta === true || r.isSidechain === true) return false;
  const c = r.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result');
}

const detailCache = new Map(); // file -> { size, mtimeMs, detail }

async function readDetail(id) {
  const file = findTranscript(id);
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = detailCache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.detail;
  const detail = await scan(file, id);
  detailCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, detail });
  return detail;
}

async function scan(file, id) {
  const counts = { user: 0, assistant: 0, tool: 0, subagents: 0 };
  const tokens = emptyTokens();
  const tools = new Map(); // name -> calls
  const models = [];
  const slices = [];
  let skillListing = [];
  const skillsUsed = new Map(); // name -> { calls, chars }
  let pendingSkill = null; // set by a Skill tool result / slash command, consumed by its body
  let previousTurn;
  let firstTurn;
  let lastTurn;
  let lastModel;
  let activeMs = 0;
  let firstTs;
  let lastTs;
  let cwd;
  let customTitle;
  let aiTitle;
  let summary;
  let firstPrompt;

  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > MAX_RECORD_CHARS) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj(r)) continue;
    if (r.timestamp) {
      const ts = Date.parse(r.timestamp);
      if (ts) {
        firstTs ??= ts;
        lastTs = ts;
      }
    }
    cwd ??= str(r.cwd);

    switch (r.type) {
      case 'assistant': {
        const m = obj(r.message);
        if (!m) break;
        const model = str(m.model);
        // Every content block of a turn is its own record repeating the turn's
        // usage; count each turn once.
        const turn = str(m.id);
        if (turn === undefined || turn !== previousTurn) {
          previousTurn = turn;
          counts.assistant += 1;
          addUsage(tokens, m.usage);
          const u = emptyTokens();
          addUsage(u, m.usage);
          if (m.usage) {
            firstTurn ??= u;
            lastTurn = u;
          }
        }
        if (model && model !== '<synthetic>') {
          if (!models.includes(model)) models.push(model);
          lastModel = model;
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== 'tool_use') continue;
            counts.tool += 1;
            tools.set(b.name, (tools.get(b.name) || 0) + 1);
          }
        }
        break;
      }
      case 'user': {
        const cmd = str(r.toolUseResult?.commandName);
        if (cmd) {
          pendingSkill = cmd;
          break;
        }
        const text = textOf(r.message?.content);
        const slash = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
        if (slash) pendingSkill = slash[1].trim();
        else if (pendingSkill && r.isMeta === true && text) {
          // The skill's body is injected as the next meta message.
          const s = skillsUsed.get(pendingSkill) || { calls: 0, chars: 0 };
          s.calls += 1;
          s.chars += text.length;
          skillsUsed.set(pendingSkill, s);
          pendingSkill = null;
        }
        if (isUserMessage(r)) {
          counts.user += 1;
          const p = text.trim();
          if (!firstPrompt && p && !p.startsWith('<')) firstPrompt = p.replace(/\s+/g, ' ');
        }
        break;
      }
      case 'attachment': {
        if (firstTurn) break; // later attachments are conversation, not standing cost
        const a = obj(r.attachment);
        if (!a) break;
        slices.push(...staticSlices(a));
        if (a.type === 'skill_listing' && str(a.content)) skillListing = skillLines(a.content);
        break;
      }
      case 'system':
        if (r.subtype === 'turn_duration') activeMs += num(r.durationMs) ?? 0;
        break;
      case 'custom-title':
        customTitle = str(r.customTitle) || customTitle;
        break;
      case 'ai-title':
        aiTitle = str(r.aiTitle) || aiTitle;
        break;
      case 'summary':
        summary ??= str(r.summary);
        break;
    }
  }

  try {
    const sub = path.join(path.dirname(file), id, 'subagents');
    counts.subagents = fs.readdirSync(sub).filter((n) => /^agent-.+\.jsonl$/.test(n)).length;
  } catch {}

  return {
    id,
    cwd: cwd || null,
    title: customTitle || aiTitle || summary || firstPrompt || null,
    model: modelLabel(lastModel),
    models: models.map(modelLabel),
    counts,
    tokens,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([name, calls]) => ({ name, calls })),
    activeMs: activeMs || null,
    startedAt: firstTs || null,
    lastActiveAt: lastTs || null,
    context: lastTurn ? buildContext(firstTurn, lastTurn, lastModel, slices) : null,
    skillListing: skillListing
      .map((s) => ({ name: s.name, tokens: tok(s.chars) }))
      .sort((a, b) => b.tokens - a.tokens),
    skillsUsed: [...skillsUsed.entries()]
      .map(([name, s]) => ({ name, calls: s.calls, tokens: tok(s.chars) }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

// The first turn's whole input stands in for the static block (system prompt,
// tools, memory, listings); the last turn's is what the window holds now.
function buildContext(first, last, model, slices) {
  const current = last.input + last.cacheRead + last.cacheCreate;
  const firstTotal = first.input + first.cacheRead + first.cacheCreate;
  // A /clear or compaction can leave the first turn larger than the window now.
  const staticTokens = Math.min(firstTotal, current);
  const windowTokens = contextWindowFor(model);

  const merged = new Map();
  for (const s of slices) {
    const key = s.part + '\u0000' + (s.label || '');
    const e = merged.get(key) || { part: s.part, label: s.label || null, count: 0, tokens: 0 };
    e.tokens += tok(s.chars);
    e.count += s.count || 0;
    merged.set(key, e);
  }
  const parts = [...merged.values()].filter((p) => p.tokens > 0);
  let named = parts.reduce((n, p) => n + p.tokens, 0);
  if (named > staticTokens && named > 0) {
    const scale = staticTokens / named;
    for (const p of parts) p.tokens = Math.round(p.tokens * scale);
    named = parts.reduce((n, p) => n + p.tokens, 0);
  }
  parts.sort((a, b) => b.tokens - a.tokens);
  if (staticTokens - named > 0) parts.push({ part: 'rest', label: null, count: 0, tokens: staticTokens - named });

  return {
    current,
    staticTokens,
    conversationTokens: current - staticTokens,
    windowTokens,
    freeTokens: Math.max(0, windowTokens - current),
    staticParts: parts,
  };
}

module.exports = { listLive, readDetail, modelLabel };
