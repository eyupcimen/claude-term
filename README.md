# ClaudeTerm

A small macOS terminal that opens straight into [Claude Code](https://claude.com/claude-code) and keeps your usage in view.

![ClaudeTerm: sessions with model and live status on the left, Claude Code in the middle, session details on the right](docs/screenshot.png)

- Sidebar with all your Claude Code sessions: open ones on top, past ones below (click to resume in the original folder)
- Each open session shows its model (e.g. `Opus 5.5`) and live status: busy, waiting for you, or idle
- "Other terminals" lists Claude Code sessions running outside ClaudeTerm, so you can see them all in one place
- Session details (ⓘ): tokens, messages, tool calls, subagents, working time, how full the context window is, and what the static context is made of — CLAUDE.md files, MCP instructions, tool and agent listings, and tokens per skill (both the skills loaded in the session and each skill's share of the listing sent every turn)
- Light and dark theme (follows the system, or pick one); the terminal follows it too
- Several sessions side by side in one window; the selected one fills the right side
- Rename any session — double-click its title or use ✎. Names are kept across restarts
- GPU-rendered terminal (WebGL) for fast scrolling
- Asks on launch: normal mode or `--dangerously-skip-permissions`, which model (Haiku 4.5, Sonnet 5, Opus 5.5, Fable 5.1 — Sonnet by default) and effort level (lower effort uses fewer tokens). Your last choice is remembered
- Status bar: this session's context tokens, 5-hour limit and weekly limit (used / remaining / reset time)
- Window title shows the current project
- UI in English, German, Turkish and Spanish (follows the system language, switchable from the 🌐 menu)

Usage data comes from Claude Code's own status line feed, passed in per window via `--settings`. Your `~/.claude/settings.json` is not modified. Session status and details are read from the files Claude Code writes under `~/.claude` (read-only, nothing leaves your machine). The session detail view is inspired by [claude-code-session-tracker](https://github.com/meyusufdemirci/claude-code-session-tracker).

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

To install it like any other app, build the `.app` only and copy it to Applications:

```sh
npx electron-builder --mac dir
cp -R dist/mac-arm64/ClaudeTerm.app /Applications/    # Intel Macs: dist/mac/
```

Then open it from Spotlight (⌘ Space → ClaudeTerm).

Or open the folder in Claude Code and ask: *"build and run this app"*.

A locally built app isn't quarantined, so macOS opens it without the Gatekeeper warning.

## License

MIT © [@eyupcimen](https://github.com/eyupcimen)
