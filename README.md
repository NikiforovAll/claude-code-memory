# Claude Code Memory

> See everything Claude Code knows about your project — CLAUDE.md files, rules, auto memory, and imports.

## Getting Started

```bash
npx claude-code-memory-explorer --open
```

Open http://localhost:3459 (or use `--open` to auto-launch the browser).

That's it. No config — the dashboard reads your existing Claude Code memory files.

## Features

- **Full memory stack** — User CLAUDE.md, project CLAUDE.md, CLAUDE.local.md, rules, auto memory, and managed policies
- **Import resolution** — Follows `@path/to/file.md` references and `[text](file.md)` markdown links up to 5 levels deep
- **Rules inspection** — Shows path-scoped frontmatter (`paths`, `type`, `name`) with conditional load indicators
- **Auto memory** — Visualizes MEMORY.md with startup cutoff line, on-demand topic files, and frontmatter badges
- **Tree + preview** — Left panel grouped by scope (user/project/rules/memory), right panel with syntax-highlighted preview
- **Keyboard-driven** — j/k navigation, h/l group jump, e to open in editor, t for theme, ? for help
- **Resizable sidebar** — Drag handle between tree and preview, width persisted
- **Browser history** — Back/forward navigates file selection, bookmarkable URLs
- **Dark & light theme** — Dark default, light toggle with `t` key
- **Hub integration** — Works as a tab in Claude Code Hub alongside Cost and Marketplace

## Configuration

```bash
PORT=8080 npx claude-code-memory-explorer              # Custom port
npx claude-code-memory-explorer --open                 # Auto-open browser
npx claude-code-memory-explorer --dir=~/.claude-work   # Custom Claude config dir
npx claude-code-memory-explorer --project=/path/to/project  # Specify project path
```

If port 3459 is in use, the server falls back to a random available port.

### Global install

```bash
npm install -g claude-code-memory-explorer
claude-code-memory-explorer --open
```

## How It Works

Claude Code stores memory across multiple locations:

| Source | Path | Load Behavior |
|--------|------|---------------|
| Managed policy | `/etc/claude-code/CLAUDE.md` | Always |
| User CLAUDE.md | `~/.claude/CLAUDE.md` | Always |
| Project CLAUDE.md | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Always |
| CLAUDE.local.md | `./CLAUDE.local.md` | Always |
| Rules | `.claude/rules/*.md` | Conditional (path-scoped) |
| Auto memory | `~/.claude/projects/<encoded>/memory/` | Startup (MEMORY.md) or on-demand |

The dashboard:
1. **Scans** all memory locations — `~/.claude/`, ancestor directories, project rules, auto memory
2. **Parses** YAML frontmatter in rules files for path globs and metadata
3. **Resolves** `@import` chains recursively (max 5 levels), tracking both hard imports and soft markdown links
4. **Groups** sources by scope with parent-child nesting for imports
5. **Renders** with Highlight.js syntax highlighting — no build step, vanilla JS

Nothing is modified — the dashboard is read-only.

### Memory Path Encoding

Claude Code encodes project paths for auto memory storage: `C:\Users\me\dev\myproject` becomes `C--Users-me-dev-myproject` under `~/.claude/projects/`. The dashboard tries exact match first, then falls back to substring matching.

## FAQ

**Does it modify any files?**
No. Completely read-only — only reads markdown files from the Claude Code memory locations.

**Does it work with Claude Code Hub?**
Yes. Exposes `/hub-config` endpoint for hub tab integration.

**Can I switch projects?**
Yes. Use the project picker (Shift+P) or pass `?project=/path` as a URL parameter.

## License

MIT
