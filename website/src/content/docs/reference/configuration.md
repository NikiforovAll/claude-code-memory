---
title: CLI and configuration
description: Flags, environment variables, defaults, network guards, and the files Claude Code Memory Diagnoser reads and writes.
---

Claude Code Memory Diagnoser needs no config file. You start it with `npx`, and flags or environment variables change the port, the Claude config dir, and the network binding.

```bash
npx claude-code-memory-explorer --open
```

The package is `claude-code-memory-explorer`. It needs Node.js 20 or later.

## Flags

| Flag | What it does | Default |
| --- | --- | --- |
| `--port <n>` or `--port=<n>` | Port to listen on. | `PORT`, else `3544` |
| `--open` | Opens `http://localhost:<port>` in your browser after start. | Off |
| `--dir <path>` | Claude config dir to read. A leading `~` expands to your home dir. | See [Config dir](#config-dir) |
| `--project <path>` | Project the server starts on. | The current directory |
| `--host <addr>` | Address to bind. | `HOST`, else `127.0.0.1` |
| `--allowed-hosts <list>` or `--allowed-hosts=<list>` | Comma-separated extra `Host` header values to accept. | `ALLOWED_HOSTS`, else none |

To look at a different project, use the project picker. Click the folder button in the top bar, or press <kbd>Shift+P</kbd>. The browser remembers the last project you picked and opens it on the next load, in place of the start project. A `?project=/path` query in the URL also switches the project. See [Switch projects](/claude-code-memory/guides/browse/#switch-projects).

## Environment variables

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on, when `--port` is not set. |
| `CLAUDE_CONFIG_DIR` | Claude config dir, when `--dir` is not set. |
| `CLAUDE_DIR` | Claude config dir, when `--dir` and `CLAUDE_CONFIG_DIR` are not set. |
| `HOST` | Bind address, when `--host` is not set. |
| `ALLOWED_HOSTS` | Extra allowed `Host` values, when `--allowed-hosts` is not set. |
| `EDITOR` | Editor for the pencil button in the file view (tooltip "Open in VS Code") and the <kbd>e</kbd> key. Default is `code`. For VS Code family editors (`code`, `code-insiders`, `codium`, `vscodium`, `cursor`, `windsurf`, `positron`, `trae`) the app adds `-n` to open a new window. |
| `CLAUDE_HUB` | Set by Claude Code Hub. Turns on hub integration. See [Run inside Claude Code Hub](/claude-code-memory/reference/hub/). |
| `HUB_URL` | Set by Claude Code Hub. The hub origin that can frame the app and send it requests. |

## Config dir

The app picks the Claude config dir in this order:

1. `--dir`
2. `CLAUDE_CONFIG_DIR`
3. `CLAUDE_DIR`
4. `~/.claude`

When the config dir is not `~/.claude`, the Analyze run passes it to `claude` as `CLAUDE_CONFIG_DIR`. With the default dir, `claude` gets your environment unchanged.

## Startup and port

On start the server prints these lines. With a non-loopback `--host` it also prints a warning (see [Network and security](#network-and-security)).

```text
Memory Diagnoser running at http://localhost:3544
Project: /path/to/your/project
```

If the port is busy, the server prints `Port 3544 busy, trying random port...` and listens on a random free port from the OS. It does not try the next port. Read the actual port from the `running at` line.

## Network and security

The app has no authentication. Anyone who can reach the port can read your memory files and delete them.

- **Loopback bind.** By default the server binds `127.0.0.1` and also `::1` on the same port, so `localhost` works for both IPv4 and IPv6.
- **Network bind.** If `--host` is not a loopback address, the server prints `WARNING: listening on <addr> - reachable from your network, with no authentication.` It then binds that address only.
- **Host allowlist.** The server answers only requests whose `Host` header is `localhost`, a `127.x` address, `::1`, a name from `--allowed-hosts`, or the address you bound with `--host`. Other hosts get a 403 page. This stops DNS rebinding, where a website points its own name at `127.0.0.1` to read local data. The 403 page tells you how to allow a host, for example `--host 0.0.0.0 --allowed-hosts=myhost`. Do this only on a network you trust.
- **Origin check.** A request other than GET, HEAD, or OPTIONS gets a 403 if its `Origin` is not loopback on the same port or the hub origin. It also gets a 403 if the browser marks it cross-site with `Sec-Fetch-Site`. Requests with no `Origin`, such as from `curl`, pass.
- **Frame guard.** Standalone, the app sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no page can frame it. With `HUB_URL` set, `frame-ancestors` allows the app itself, any `localhost` or `127.0.0.1` port, and the hub origin.

## Files the app reads

From the config dir:

- `CLAUDE.md`
- `rules/**/*.md`
- `settings.json`, for `autoMemoryDirectory`, and in the user scope for the output style and memory settings
- `skills/`, `agents/`, and `output-styles/`
- `projects/<encoded project>/memory/`, or the same path under `autoMemoryDirectory` when it is set
- `agent-memory/<agent>/`
- `memory-analysis/*.json`

From the project, its parent dirs, and its subdirs: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `.claude/CLAUDE.local.md`.

From the project: `.claude/rules/`, `.claude/skills/`, `.claude/agents/`, `.claude/agent-memory/`, and `.claude/agent-memory-local/`.

It also reads the managed policy `CLAUDE.md`, the managed settings, and every file that these files import. For the full list and the load order, see [What Claude Code loads](/claude-code-memory/guides/memory-stack/).

The app caches the scan for 30 seconds. Press <kbd>r</kbd> to scan again now.

## Files the app writes

Browsing changes nothing. The app writes to disk only in these cases:

- **Delete file.** Removes the file after you confirm.
- **Cleanup orphaned refs.** Rewrites a `MEMORY.md` and removes the `- [name](file.md)` lines whose target file does not exist.
- **Analyze.** Saves runs and dismissed findings in `<config dir>/memory-analysis/`, one file for each project and one that all projects share for the user `CLAUDE.md`. See [Analyze memory with Claude](/claude-code-memory/guides/analyze/).

Delete and Cleanup work only on paths inside the config dir, the current project, or the auto memory base dir. Other paths get a 403.

## Scripts for contributors

In a clone of the repository:

| Script | Command |
| --- | --- |
| `npm start` | `node server.js` |
| `npm run dev` | `node server.js --open` |
| `npm test` | `node --test test/*.test.js` |
