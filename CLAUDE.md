# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Dashboard for visualizing all memory sources that influence Claude Code behavior. Shows the full memory stack: CLAUDE.md files (user/project/local), rules (`.claude/rules/*.md` with optional path-scoped frontmatter), auto memory (`~/.claude/projects/<encoded>/memory/`), subagent persistent memory (`~/.claude/agent-memory/`, `.claude/agent-memory/`, `.claude/agent-memory-local/`), and `@import` chains.

## Commands

- `npm start` — run server (port 3544)
- `npm run dev` — run with auto-open browser
- `npx @biomejs/biome check` — lint the files in `biome.json` (`public/`, `server.js`, `lib/`); the formatter is off for the server files
- `npx @biomejs/biome format --write public/app.js public/style.css` — format
- `npm test` — node test runner over `test/*.test.js`

## Architecture

Single-file Express backend + vanilla JS frontend. No build step, no framework.

- **`server.js`** — Express server with three main responsibilities:
  1. **Filesystem scanning** (`discoverMemorySources`) — walks `~/.claude/`, ancestor directories, project `.claude/rules/`, and auto memory dirs to build the full memory source stack
  2. **API endpoints** — `/api/stack`, `/api/summary`, `/api/file`, `/api/rules/match`, `/api/imports` etc.
  3. **Analyzer** (the `ANALYZER` region, the largest block in the file) — runs headless `claude -p` audits of the memory stack with reviewer subagents, persists each run per project, and serves them over `/api/memory/analyze`, `/api/memory/analysis`, `/api/memory/analysis/dismiss`, and `/api/memory/analysis/delete-run`
- **`bin.js`** — the package bin. A first argument that is a command (`projects`, `analysis`, `help`) runs `lib/cli.js`; anything else starts `server.js`.
- **`lib/cli.js`** — read-only commands over the saved analysis runs, with a `COMMANDS` table that the help prints from. It needs no running server and starts no analysis. Agents read the help (cck's Kanbot is pointed at it), so keep each line short; a new command or flag goes in the table and in the website's `reference/configuration.md`.
- **`lib/analysis-store.js`** — reads and writes `<config dir>/memory-analysis/<encoded path>.json`, shared by the server and the CLI. A saved file carries `project`, the real path, because the encoded name cannot be decoded.
- **`lib/claude-dir.js`** — the config dir order (`--dir`, `CLAUDE_CONFIG_DIR`, `CLAUDE_DIR`, `~/.claude`), shared by the server and the CLI.
- **`<config dir>/.memory/server.json`** — `{pid, port, script}`, written on ready and removed on exit. cck reads it to find the CLI when the app runs under the hub, where the bin is not on PATH.
- **`plugin/`** — a Claude Code marketplace with one plugin, `memory-diagnoser`, whose `memory-analysis` skill wraps the CLI. It is not installed by default. cck loads it into Kanbot with `--plugin-dir` from `plugin/plugins/memory-diagnoser`, so that path and the plugin name must stay. The skill points at the help and names only the finding filters; a new command gets a row in its table.
- **`public/app.js`** — SPA with tree panel (left) + preview panel (right) split layout. Fetches from API, renders tree grouped by scope, shows syntax-highlighted preview with frontmatter badges and clickable `@import` links.
- **`public/style.css`** — CSS variables on `:root` (dark default), `body.light` overrides. Scope colors: user=blue, project=green, local=yellow, rule=purple, memory=orange, policy=red.

Both JS files use `// #region` / `// #endregion` markers for code organization.

## Key Server Concepts

- **Project path encoding**: Claude Code stores auto memory in `~/.claude/projects/<encoded-path>/memory/`. `encodeProjectPath()` replaces both `/` and `:` with `-` (a Windows drive letter keeps its position, it is not stripped). `findMemoryDir()` tries exact match first, then resolves git linked worktrees to the main worktree memory via `git rev-parse --git-common-dir`, then falls back to substring matching.
- **Custom projects base**: `getProjectsBaseDir()` honors the `autoMemoryDirectory` key from managed settings, else `~/.claude/settings.json` (matches Claude Code, which rejects this key from project/local for security). When set, it replaces `<CLAUDE_DIR>/projects` as the base for the encoded-project lookup in `findMemoryDir()`.
- **Agent persistent memory**: Subagents declared with `memory: user|project|local` frontmatter get a directory at `~/.claude/agent-memory/<agent>/`, `<project>/.claude/agent-memory/<agent>/`, or `<project>/.claude/agent-memory-local/<agent>/`. Each follows the auto-memory layout (`MEMORY.md` startup-loaded with 200-line / 25 KB cap, siblings on-demand). Sources carry `agentScope` and `agentName` fields; the tree groups them under "Agent Memory" with a per-agent sub-header.
- **Import resolution**: `@path/to/file.md` references are parsed from content. `resolveExistingImports()` resolves paths and filters out non-existent files. Imported files are recursively added to the stack (max 4 hops, as Claude Code does).
- **User scope**: `PUT /api/project {user: true}` sets the project to null. The stack then holds only what every session loads: policy, user CLAUDE.md, user rules, user skills, user agents (`~/.claude/agents`, scope `agent`, description counted in `agentDesc`) and user agent memory. Analysis runs go to the shared user entry. `GET /api/home` (cached) returns the effective output style and memory settings (managed, then user, then default) for the home cards. Managed is `<config dir>/remote-settings.json` (server-managed) when it exists, else the system `managed-settings.json`. The client keeps the user scope in the recents list as `::user::`, so a reload restores it; the hub's `project.changed` replay (before the first `hub:active`) does not replace it, a live change does. A home card opens the standard tree + preview narrowed to its groups (`homeFocus`, with a `Home › <group>` crumb and "show all"); selecting a file outside those groups, Escape or Home clears it. Settings files and the output style are not in the stack: their cards open them read-only in the preview (`previewPath`, no delete button); only the preview's editor button or `e` opens the editor.
- **Frontmatter parsing**: YAML frontmatter in rules files (`paths`, `type`, `name`, `description`) determines conditional loading. `parseFrontmatter()` handles both inline values and YAML array syntax.
- **Rules matching**: `micromatch` glob matching against rule `paths` frontmatter via `/api/rules/match?file=`.
- **Cache**: 30-second TTL on `discoverMemorySources` results, cleared on project switch or manual refresh.

## Conventions

- Dark theme default, light theme via `body.light` class
- Accent color: `#e86f33`
- Fonts: IBM Plex Mono (data/code), Playfair Display (headings)
- Keyboard-driven: j/k navigation, t=theme, r=refresh, e=open in editor, ?=help
- Port 3544 (cost=3543, marketplace=3542)
- No global `zoom`; base font-size 14px to match sibling apps (cck). The user-scope home (`.home`) sizes everything in `--px`, which grows in steps on wide screens
- No token estimation — line/byte/char counts only (deliberate decision); `/api/summary` returns `totalChars`/`scopeChars` for the client budget bar

## Prior Art

- `../claude-code-cost` — same stack, data visualization patterns
- `../claude-code-marketplace` — file tree, markdown preview, project picker, Highlight.js usage
