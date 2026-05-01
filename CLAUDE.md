# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Dashboard for visualizing all memory sources that influence Claude Code behavior. Shows the full memory stack: CLAUDE.md files (user/project/local), rules (`.claude/rules/*.md` with optional path-scoped frontmatter), auto memory (`~/.claude/projects/<encoded>/memory/`), subagent persistent memory (`~/.claude/agent-memory/`, `.claude/agent-memory/`, `.claude/agent-memory-local/`), and `@import` chains.

## Commands

- `npm start` — run server (port 3459)
- `npm run dev` — run with auto-open browser
- `npx @biomejs/biome check public/app.js public/style.css` — lint
- `npx @biomejs/biome format --write public/app.js public/style.css` — format

## Architecture

Single-file Express backend + vanilla JS frontend. No build step, no framework.

- **`server.js`** — Express server with two main responsibilities:
  1. **Filesystem scanning** (`discoverMemorySources`) — walks `~/.claude/`, ancestor directories, project `.claude/rules/`, and auto memory dirs to build the full memory source stack
  2. **API endpoints** — `/api/stack`, `/api/summary`, `/api/file`, `/api/rules/match`, `/api/imports` etc.
- **`public/app.js`** — SPA with tree panel (left) + preview panel (right) split layout. Fetches from API, renders tree grouped by scope, shows syntax-highlighted preview with frontmatter badges and clickable `@import` links.
- **`public/style.css`** — CSS variables on `:root` (dark default), `body.light` overrides. Scope colors: user=blue, project=green, local=yellow, rule=purple, memory=orange, policy=red.

Both JS files use `// #region` / `// #endregion` markers for code organization.

## Key Server Concepts

- **Project path encoding**: Claude Code stores auto memory in `~/.claude/projects/<encoded-path>/memory/`. The encoding replaces `/` with `-` and strips `:` from drive letters. `findMemoryDir()` tries exact match first, then resolves git linked worktrees to the main worktree's memory via `git rev-parse --git-common-dir`, then falls back to substring matching.
- **Agent persistent memory**: Subagents declared with `memory: user|project|local` frontmatter get a directory at `~/.claude/agent-memory/<agent>/`, `<project>/.claude/agent-memory/<agent>/`, or `<project>/.claude/agent-memory-local/<agent>/`. Each follows the auto-memory layout (`MEMORY.md` startup-loaded with 200-line / 25 KB cap, siblings on-demand). Sources carry `agentScope` and `agentName` fields; the tree groups them under "Agent Memory" with a per-agent sub-header.
- **Import resolution**: `@path/to/file.md` references are parsed from content. `resolveExistingImports()` resolves paths and filters out non-existent files. Imported files are recursively added to the stack (max 5 levels).
- **Frontmatter parsing**: YAML frontmatter in rules files (`paths`, `type`, `name`, `description`) determines conditional loading. `parseFrontmatter()` handles both inline values and YAML array syntax.
- **Rules matching**: `micromatch` glob matching against rule `paths` frontmatter via `/api/rules/match?file=`.
- **Cache**: 30-second TTL on `discoverMemorySources` results, cleared on project switch or manual refresh.

## Conventions

- Dark theme default, light theme via `body.light` class
- Accent color: `#e86f33`
- Fonts: IBM Plex Mono (data/code), Playfair Display (headings)
- Keyboard-driven: j/k navigation, t=theme, r=refresh, e=open in editor, ?=help
- Port 3459 (cost=3458, marketplace=3460)
- `zoom: 1.25` on body for proportional scaling
- No token/context budget estimation — only line/byte counts (deliberate decision)

## Prior Art

- `../claude-code-cost` — same stack, data visualization patterns
- `../claude-code-marketplace` — file tree, markdown preview, project picker, Highlight.js usage
