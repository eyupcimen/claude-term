const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarkdown, READERS } = require('../handoff');
const { buildClaudeLaunchCommand, buildAgentLaunchCommand } = require('../platform');

test('keeps what was asked and answered, without injected context', () => {
  const turns = READERS.codex([
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixed' }] } },
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: 'fix it' },
    { role: 'agent', text: 'fixed' },
  ]);
  assert.equal(buildMarkdown('codex', '/w', turns), '# Earlier session with Codex\n\nFolder: /w\n\n## User\n\nfix it\n\n## Codex\n\nfixed\n');
});

test('drops the oldest messages of a long session', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: String(i).repeat(5000) }));
  const md = buildMarkdown('claude', null, turns);
  assert.ok(md.length <= 101000);
  assert.match(md, /The first \d+ of 30 messages are left out/);
  assert.ok(md.includes('29'.repeat(10)));
});

test('starts each agent with a first message', () => {
  const p = { platform: 'darwin', prompt: "read x's file" };
  assert.equal(buildClaudeLaunchCommand({ settingsFile: '/s', ...p }), "claude --settings '/s' 'read x'\\''s file'; exit");
  assert.equal(buildAgentLaunchCommand({ agent: 'codex', ...p }), "codex 'read x'\\''s file'; exit");
  assert.equal(buildAgentLaunchCommand({ agent: 'gemini', ...p }), "gemini -i 'read x'\\''s file'; exit");
});
