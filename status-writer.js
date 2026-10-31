const fs = require('fs');
const path = require('path');

function writeStatus(statusFile, input) {
  const parsed = JSON.parse(input);
  const dir = path.dirname(statusFile);
  const temp = path.join(dir, `.${path.basename(statusFile)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(parsed));
  fs.renameSync(temp, statusFile);
}

function main() {
  const statusFile = process.env.CLAUDETERM_STATUS_FILE;
  if (!statusFile) process.exitCode = 1;
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    if (!statusFile) return;
    try { writeStatus(statusFile, input); } catch { process.exitCode = 1; }
  });
}

if (require.main === module) main();

module.exports = { writeStatus };
