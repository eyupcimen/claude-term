const path = require('path');

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

function terminalShell(platform = process.platform, env = process.env) {
  if (isWindows(platform)) {
    return { file: env.CLAUDETERM_POWERSHELL || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: env.SHELL || '/bin/zsh', args: ['-l'] };
}

function quotePowerShell(value) {
  return `"${String(value).replace(/[`"$]/g, '`$&')}"`;
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// nodePath is the Electron binary; without ELECTRON_RUN_AS_NODE it would start
// a second app window instead of running the helper script.
function buildStatusLineCommand(nodePath, helperPath, platform = process.platform) {
  if (isWindows(platform)) {
    return `$env:ELECTRON_RUN_AS_NODE='1'; & ${quotePowerShell(nodePath)} ${quotePowerShell(helperPath)}`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${quotePosix(nodePath)} ${quotePosix(helperPath)}`;
}

function buildClaudeLaunchCommand({ settingsFile, resumeId, flags, prompt, platform = process.platform }) {
  const quote = isWindows(platform) ? quotePowerShell : quotePosix;
  const parts = ['claude', '--settings', quote(settingsFile)];
  if (resumeId) parts.push('--resume', quote(resumeId));
  if (flags) parts.push(flags);
  if (prompt) parts.push(quote(prompt));
  return isWindows(platform) ? `${parts.join(' ')}\r\nexit` : `${parts.join(' ')}; exit`;
}

// Codex resumes with a subcommand, the others with a flag.
const RESUME_ARGS = { codex: ['resume'], gemini: ['--resume'], copilot: ['--resume'], antigravity: ['--conversation'] };
const COMMANDS = { antigravity: 'agy' };
// How each starts interactively with a first message already sent.
const PROMPT_ARGS = { codex: [], gemini: ['-i'], copilot: ['-i'] };

function buildAgentLaunchCommand({ agent, resumeId, flags, prompt, platform = process.platform }) {
  const quote = isWindows(platform) ? quotePowerShell : quotePosix;
  const parts = [COMMANDS[agent] || agent];
  if (resumeId) parts.push(...RESUME_ARGS[agent], quote(resumeId));
  if (flags) parts.push(flags);
  if (prompt && PROMPT_ARGS[agent]) parts.push(...PROMPT_ARGS[agent], quote(prompt));
  return isWindows(platform) ? `${parts.join(' ')}\r\nexit` : `${parts.join(' ')}; exit`;
}

function defaultWorkspace(home, exists, platform = process.platform) {
  const paths = isWindows(platform) ? path.win32 : path;
  const developer = paths.join(home, 'Developer');
  if (exists(developer)) return developer;
  const documents = paths.join(home, 'Documents');
  if (isWindows(platform) && exists(documents)) return documents;
  return home;
}

module.exports = { isWindows, terminalShell, quotePowerShell, quotePosix, buildStatusLineCommand, buildClaudeLaunchCommand, buildAgentLaunchCommand, defaultWorkspace };
