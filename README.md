# ClaudeTerm

A small macOS terminal that opens straight into [Claude Code](https://claude.com/claude-code) and keeps your usage in view.

- Sidebar with all your Claude Code sessions: open ones on top, past ones below (click to resume in the original folder)
- Several sessions side by side in one window; the selected one fills the right side
- Rename any session — double-click its title or use ✎. Names are kept across restarts
- GPU-rendered terminal (WebGL) for fast scrolling
- Asks on launch: normal mode or `--dangerously-skip-permissions`, which model (Haiku 4.5, Sonnet 5, Opus 5.5, Fable 5.1 — Sonnet by default) and effort level (lower effort uses fewer tokens). Your last choice is remembered
- Status bar: this session's context tokens, 5-hour limit and weekly limit (used / remaining / reset time)
- Window title shows the current project
- UI in English, German, Turkish and Spanish (follows the system language, switchable from the 🌐 menu)

Usage data comes from Claude Code's own status line feed, passed in per window via `--settings`. Your `~/.claude/settings.json` is not modified.

## Build it yourself

No prebuilt binaries — clone and build on your own Mac. Requirements: macOS, Node.js 20+, Xcode Command Line Tools, and Claude Code installed and logged in.

```sh
git clone https://github.com/eyupcimen/claude-term.git
cd claude-term
npm install
npx electron-rebuild
npm start          # run it
npm run dist       # or build ClaudeTerm.app + dmg into dist/
```

Or open the folder in Claude Code and ask: *"build and run this app"*.

A locally built app isn't quarantined, so macOS opens it without the Gatekeeper warning.

## License

MIT
