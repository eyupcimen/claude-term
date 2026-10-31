const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLines, metaFrom } = require('../codex');

const line = (o) => JSON.stringify(o);

test('reads cwd and start time from a session_meta line', () => {
  const head = line({ type: 'session_meta', payload: { id: 'abc', timestamp: '2026-10-30T10:00:00.000Z', cwd: '/Users/ada/app' } }) + '\n';
  assert.deepEqual(metaFrom(head), { cwd: '/Users/ada/app', startedAt: Date.parse('2026-10-30T10:00:00.000Z'), subagent: false });
});

test('folds rollout events into status, context and limits', () => {
  const state = applyLines({}, [
    line({ type: 'session_meta', payload: { id: 'abc' } }),
    line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-x' } } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1000 }, model_context_window: 4000 },
        rate_limits: {
          primary: { used_percent: 12, window_minutes: 300, resets_at: 100 },
          secondary: { used_percent: 40, window_minutes: 10080, resets_at: 200 },
        },
      },
    }),
    'not json',
  ]);
  assert.equal(state.sessionId, 'abc');
  assert.equal(state.model, 'gpt-x');
  assert.equal(state.status, 'busy');
  assert.equal(state.contextTokens, 1000);
  assert.equal(state.contextPct, 25);
  assert.deepEqual(state.fiveHour, { used_percentage: 12, resets_at: 100 });
  assert.deepEqual(state.weekly, { used_percentage: 40, resets_at: 200 });
  applyLines(state, [line({ type: 'event_msg', payload: { type: 'task_complete' } })]);
  assert.equal(state.status, 'idle');
});
