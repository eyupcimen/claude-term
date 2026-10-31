const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../gemini');
const copilot = require('../copilot');

const line = (o) => JSON.stringify(o);

test('folds Gemini CLI chat records into status, model, context and title', () => {
  const state = gemini.applyLines({}, [
    line({ sessionId: 'g-1', projectHash: 'h', startTime: '2026-10-30T10:00:00.000Z', kind: 'main' }),
    line({ id: 'm1', type: 'user', content: [{ text: 'fix the build' }] }),
  ]);
  assert.equal(state.sessionId, 'g-1');
  assert.equal(state.status, 'busy');
  assert.equal(state.firstPrompt, 'fix the build');
  gemini.applyLines(state, [
    line({ id: 'm2', type: 'gemini', content: 'working', model: 'gemini-x' }),
    line({ id: 'm2', type: 'gemini', content: 'done', model: 'gemini-x', tokens: { input: 1048576 / 4 } }),
    line({ $set: { summary: 'Fix build' } }),
  ]);
  assert.equal(state.status, 'idle');
  assert.equal(state.model, 'gemini-x');
  assert.equal(state.contextPct, 25);
  assert.equal(state.title, 'Fix build');
});

test('folds Copilot CLI events into status, model and cwd', () => {
  const state = copilot.applyLines({}, [
    line({ type: 'session.start', data: { sessionId: 'c-1', startTime: '2026-10-30T10:00:00.000Z', context: { cwd: '/w' }, selectedModel: 'm1' } }),
    line({ type: 'user.message', data: { content: 'add tests' } }),
  ]);
  assert.equal(state.sessionId, 'c-1');
  assert.equal(state.cwd, '/w');
  assert.equal(state.model, 'm1');
  assert.equal(state.status, 'busy');
  assert.equal(state.firstPrompt, 'add tests');
  copilot.applyLines(state, [
    line({ type: 'session.model_change', data: { newModel: 'm2' } }),
    line({ type: 'assistant.turn_end', data: { turnId: '1' } }),
  ]);
  assert.equal(state.model, 'm2');
  assert.equal(state.status, 'idle');
});
