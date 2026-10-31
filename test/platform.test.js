const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalShell, buildStatusLineCommand, buildClaudeLaunchCommand, defaultWorkspace } = require('../platform');

test('uses PowerShell without macOS login-shell arguments on Windows', () => {
  assert.deepEqual(terminalShell('win32'), { file: 'powershell.exe', args: ['-NoLogo'] });
});

test('keeps the configured login shell on macOS', () => {
  assert.deepEqual(terminalShell('darwin', { SHELL: '/bin/fish' }), { file: '/bin/fish', args: ['-l'] });
});

test('builds a Windows Claude launch without POSIX exit syntax', () => {
  const command = buildClaudeLaunchCommand({ settingsFile: 'C:\\Users\\Ada Lovelace\\settings.json', resumeId: 'abc-123', flags: '--model sonnet', platform: 'win32' });
  assert.match(command, /--settings "C:\\Users\\Ada Lovelace\\settings\.json"/);
  assert.match(command, /--resume "abc-123"/);
  assert.match(command, /\r\nexit$/);
  assert.doesNotMatch(command, /; exit/);
});

test('uses platform-specific quoting for the status writer command', () => {
  assert.match(buildStatusLineCommand('/usr/local/bin/node', '/tmp/status writer.js', 'darwin'), /^ELECTRON_RUN_AS_NODE=1 '.*' '.*'$/);
  assert.match(buildStatusLineCommand('C:\\Program Files\\node.exe', 'C:\\app\\status writer.js', 'win32'), /^\$env:ELECTRON_RUN_AS_NODE='1'; & ".*" ".*"$/);
});

test('chooses Developer when it exists and Documents as the Windows fallback', () => {
  const existing = new Set(['C:\\Users\\Ada\\Documents']);
  assert.equal(defaultWorkspace('C:\\Users\\Ada', (p) => existing.has(p), 'win32'), 'C:\\Users\\Ada\\Documents');
  assert.equal(defaultWorkspace('/Users/ada', () => false, 'darwin'), '/Users/ada');
});

test('launches and resumes Codex, Gemini CLI, Copilot CLI and Antigravity', () => {
  const { buildAgentLaunchCommand } = require('../platform');
  const cmd = (o) => buildAgentLaunchCommand({ platform: 'darwin', ...o });
  assert.equal(cmd({ agent: 'codex', flags: '-c model_reasoning_effort=low' }), 'codex -c model_reasoning_effort=low; exit');
  assert.equal(cmd({ agent: 'codex', resumeId: 'abc' }), "codex resume 'abc'; exit");
  assert.equal(cmd({ agent: 'gemini', resumeId: 'abc', flags: '--yolo' }), "gemini --resume 'abc' --yolo; exit");
  assert.equal(cmd({ agent: 'copilot', resumeId: 'abc' }), "copilot --resume 'abc'; exit");
  assert.equal(cmd({ agent: 'antigravity', resumeId: 'abc' }), "agy --conversation 'abc'; exit");
});
