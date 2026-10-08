# ClaudeTerm

A small macOS terminal that opens straight into [Claude Code](https://claude.com/claude-code) and keeps your usage in view.

- Asks on launch: normal mode or `--dangerously-skip-permissions`, and which model (Sonnet by default; your last choice is remembered)
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
