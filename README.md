# ClaudeTerm

A small macOS terminal that opens straight into [Claude Code](https://claude.com/claude-code) and keeps your usage in view.

- Asks on launch: normal mode or `--dangerously-skip-permissions`, and which model (defaults to Claude Code's own default)
- Status bar: this session's context tokens, 5-hour limit and weekly limit (used / remaining / reset time)
- Window title shows the current project
- UI in English, German, Turkish and Spanish (follows the system language, switchable from the 🌐 menu)

Usage data comes from Claude Code's own status line feed, passed in per window via `--settings`. Your `~/.claude/settings.json` is not modified.

## Run from source

```sh
npm install
npx electron-rebuild
npm start
```

## Build

```sh
npm run dist
```

The app is ad-hoc signed, not notarized. After installing, macOS may block it on first launch; right-click the app and choose **Open**.
