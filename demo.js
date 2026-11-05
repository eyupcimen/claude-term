// Demo mode (CLAUDETERM_DEMO=1): made-up sessions, history and limits, and a
// scripted terminal instead of a real agent. Used for screenshots and ads, so
// nothing from ~/.claude ever shows up in them.

const HOME = '/Users/demo';
const now = Date.now();
const min = 60000;
const day = 1440 * min;

const SESSIONS = [
  {
    sessionId: 'demo-a1',
    title: 'Fix landscape recording',
    cwd: `${HOME}/Developer/Teleprompter`,
    model: 'Opus 5.5',
    status: 'busy',
    contextTokens: 84210,
    contextPct: 42,
  },
  {
    sessionId: 'demo-a2',
    title: 'Feedback kit package',
    cwd: `${HOME}/Developer/FeedbackKit`,
    model: 'Sonnet 5',
    status: 'waiting',
    contextTokens: 51200,
    contextPct: 26,
  },
  {
    sessionId: 'demo-a3',
    title: 'Portfolio site copy',
    cwd: `${HOME}/Developer/portfolio`,
    model: 'Haiku 4.5',
    status: 'idle',
    contextTokens: 12900,
    contextPct: 6,
  },
];

const LIVE = [
  { id: 'demo-e1', cwd: `${HOME}/Developer/reels`, title: 'AI reels project', model: 'Opus 5.5', status: 'busy' },
  { id: 'demo-e2', cwd: `${HOME}/Developer/cod`, title: 'COD project', model: 'Sonnet 5', status: 'idle' },
];

const HISTORY = [
  ['Interval timer flexibility', 'RunApp', 2 * day],
  ['Windows build script', 'ClaudeTerm', 3 * day],
  ['Handoff to Codex test', 'ClaudeTerm', 5 * day, 'codex'],
  ['Legal RAG chunking', 'legal-rag', 8 * day],
  ['Onboarding screens', 'SpeakLens', 12 * day],
  ['Release notes 1.3', 'ClaudeTerm', 15 * day],
].map(([title, dir, age, agent], i) => ({
  id: `demo-h${i}`,
  title,
  cwd: `${HOME}/Developer/${dir}`,
  mtime: now - age,
  agent: agent || 'claude',
}));

const LIMITS = {
  fiveHour: { used_percentage: 62, resets_at: Math.round((now + 134 * min) / 1000) },
  weekly: { used_percentage: 74, resets_at: Math.round((now + 3 * day) / 1000) },
};

const E = '\x1b[';
const dim = (s) => `${E}38;2;138;145;142m${s}${E}0m`;
const acc = (s) => `${E}38;2;60;196;165m${s}${E}0m`;
const red = (s) => `${E}38;2;255;107;96m${s}${E}0m`;
const grn = (s) => `${E}38;2;76;199;122m${s}${E}0m`;

const SCRIPT = [
  dim('Claude Code · Opus 5.5 · medium effort'),
  '',
  '> landscape recordings are saved rotated. fix it',
  '',
  `${acc('●')} I'll check how the recorder sets the video orientation.`,
  dim('  ⎿ Read Teleprompter/iOS/Recorder.swift (214 lines)'),
  dim('  ⎿ Search "videoRotationAngle" in Teleprompter/ (3 results)'),
  '',
  `${acc('●')} The connection's rotation is set once at start and never updated,`,
  '  so a landscape recording keeps the portrait angle.',
  '',
  `${acc('●')} Update(Teleprompter/iOS/Recorder.swift)`,
  `    ${red('-  connection.videoRotationAngle = 90')}`,
  `    ${grn('+  connection.videoRotationAngle = rotationCoordinator')}`,
  `    ${grn('+      .videoRotationAngleForHorizonLevelCapture')}`,
  '',
  `${acc('✻')} ${dim('Building for device… (42s · esc to interrupt)')}`,
].join('\r\n');

function detail(id) {
  const s = SESSIONS.find((x) => x.sessionId === id);
  const l = LIVE.find((x) => x.id === id);
  const h = HISTORY.find((x) => x.id === id);
  const base = s || l || h;
  if (!base) return null;
  const current = s ? s.contextTokens : 64000;
  return {
    id,
    cwd: base.cwd,
    title: base.title,
    model: base.model || 'Opus 5.5',
    models: [base.model || 'Opus 5.5'],
    counts: { user: 12, assistant: 61, tool: 48, subagents: 1 },
    tokens: { input: 27548, output: 18903, cacheRead: 1204331, cacheCreate: 96412 },
    tools: [
      { name: 'Bash', calls: 21 },
      { name: 'Read', calls: 14 },
      { name: 'Edit', calls: 9 },
      { name: 'Grep', calls: 4 },
    ],
    activeMs: 14 * min,
    openMs: 52 * min,
    startedAt: now - 52 * min,
    lastActiveAt: now - min,
    context: {
      current,
      staticTokens: 38356,
      conversationTokens: current - 38356,
      windowTokens: 200000,
      freeTokens: 200000 - current,
      staticParts: [
        { part: 'tools', label: null, count: 141, tokens: 1501 },
        { part: 'agents', label: null, count: 6, tokens: 540 },
        { part: 'skills', label: null, count: 21, tokens: 2054 },
        { part: 'mcp', label: null, count: 2, tokens: 769 },
      ],
    },
    skillListing: [
      { name: 'code-review', tokens: 271 },
      { name: 'simplify', tokens: 242 },
      { name: 'handoff', tokens: 203 },
    ],
    skillsUsed: [],
  };
}

let next = 0;

// Stands in for createSession: no process, just a scripted screen and a status feed.
function createSession(send) {
  const s = SESSIONS[next++ % SESSIONS.length];
  const id = `demo-pty-${next}`;
  setTimeout(() => {
    send('pty-data', { id, data: s === SESSIONS[0] ? SCRIPT : dim(`Claude Code · ${s.model}`) + '\r\n\r\n> ' });
    send('status-update', {
      id,
      agent: 'claude',
      sessionId: s.sessionId,
      status: s.status,
      project: s.cwd,
      model: s.model,
      aiTitle: s.title,
      contextTokens: s.contextTokens,
      contextPct: s.contextPct,
      ...LIMITS,
    });
  }, 300);
  return { id, cwd: s.cwd, home: HOME };
}

module.exports = {
  HOME,
  count: SESSIONS.length,
  createSession,
  history: () => ({ home: HOME, items: HISTORY }),
  // Active sessions report their own status too, so they show in their rows.
  live: () => [
    ...SESSIONS.map((s) => ({ id: s.sessionId, cwd: s.cwd, title: s.title, model: s.model, status: s.status })),
    ...LIVE,
  ],
  detail,
};
