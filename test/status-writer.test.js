const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeStatus } = require('../status-writer');

test('writes a valid JSON snapshot atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeterm-status-'));
  const file = path.join(dir, 'status.json');
  writeStatus(file, '{"model":{"display_name":"Sonnet"}}');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: { display_name: 'Sonnet' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('does not overwrite the last snapshot for invalid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeterm-status-'));
  const file = path.join(dir, 'status.json');
  fs.writeFileSync(file, '{"kept":true}');
  assert.throws(() => writeStatus(file, '{bad'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"kept":true}');
  fs.rmSync(dir, { recursive: true, force: true });
});
