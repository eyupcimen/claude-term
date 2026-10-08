# ClaudeTerm

A small macOS terminal that opens straight into [Claude Code](https://claude.com/claude-code) and keeps your usage in view.

- Asks on launch: normal mode or `--dangerously-skip-permissions`, and which model (Sonnet by default; your last choice is remembered)
- Status bar: this session's context tokens, 5-hour limit and weekly limit (used / remaining / reset time)
- Window title shows the current project
- UI in English, German, Turkish and Spanish (follows the system language, switchable from the 🌐 menu)

Usage data comes from Claude Code's own status line feed, passed in per window via `--settings`. Your `~/.claude/settings.json` is not modified.

## Install

Requirements: macOS and [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` works in your terminal).

1. Download the dmg for your Mac from [Releases](https://github.com/eyupcimen/claude-term/releases/latest):
   - Apple Silicon (M1/M2/M3/M4…): `ClaudeTerm-<version>-arm64.dmg`
   - Intel: `ClaudeTerm-<version>.dmg`
2. Open the dmg and drag **ClaudeTerm** into **Applications**.
3. The app isn't notarized by Apple, so the first launch is blocked. Allow it once, either way:
   - Open ClaudeTerm, close the warning, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
   - Or run in Terminal: `xattr -dr com.apple.quarantine /Applications/ClaudeTerm.app`

After that it opens normally.

## Run from source

```sh
git clone https://github.com/eyupcimen/claude-term.git
cd claude-term
npm install
npx electron-rebuild
npm start
```

## Build

```sh
npm run dist
```

## License

MIT
