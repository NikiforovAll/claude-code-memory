---
title: Troubleshooting
description: Find the symptom, then apply the fix.
---

## Startup and connection

### The app opened on a different port

The default port is 3544. If another process uses it, the server logs `Port 3544 busy, trying random port...` and listens on a random free port. Read the startup banner for the real address:

```text
Memory Diagnoser running at http://localhost:<port>
```

To use a fixed port, start with `--port <n>` or set the `PORT` environment variable. See [CLI and configuration](/claude-code-memory/reference/configuration/).

### 403 Forbidden when you use another host name

The server answers only requests addressed to localhost. This blocks DNS rebinding. A request with a different `Host` header gets `403 Forbidden - unrecognized Host header`.

To reach the app from another machine, restart with the command the 403 page suggests:

```bash
npx claude-code-memory-explorer --host 0.0.0.0 --allowed-hosts=<your-hostname>
```

The app has no authentication. Do this only on a network you trust.

## Project and memory files

### "No memory sources found", or the wrong project shows

The app scans the project it has open. The project name in the top bar tells you which one that is. To change it, click the project name or press <kbd>Shift+P</kbd>, then pick a recent project or select **+ Add path...** and type the full directory path.

### "directory not found" when you add a path

The server checks that the directory exists before it switches. Check the spelling and type the full absolute path.

### Auto memory is missing

The app looks for auto memory in `<config dir>/projects/<encoded project path>/memory`, then tries the main worktree and a name match. For the full lookup, see [Auto memory](/claude-code-memory/guides/memory-stack/#auto-memory).

Check these:

- The app uses the same config dir as Claude Code. See [Config dir](/claude-code-memory/reference/configuration/#config-dir).
- If you set `autoMemoryDirectory`, you set it in the user `settings.json`. The app does not read it from project settings.
- Claude Code has written memory for this project at least once.

### Windows short paths do not match

A Windows 8.3 short path such as `C:\Users\JOHNDO~1\...` encodes to a different folder name than the long path that Claude Code uses. The exact match then fails. Open the project with its long path, for example `C:\Users\johndoe\...`.

### Nested CLAUDE.md, skills or on-demand files are not in the footprint

This is by design. The footprint counts only what Claude Code can load into each session without a read on purpose. The tree still lists the other files. For the full rule, see [Footprint](/claude-code-memory/guides/memory-stack/#footprint).

### A rule shows as always loaded

A rule is conditional when its frontmatter has a `paths` value: one glob or a non-empty list. Without `paths`, or with an empty list, Claude Code loads it in every session, and the app marks it as always loaded. Add `paths` globs to scope it:

```markdown
---
paths:
  - "src/**/*.ts"
---
```

### Changes on disk do not show

The app caches each scan for 30 seconds. Press <kbd>r</kbd> or click Refresh to scan again. Switching the project also clears the cache.

### Open in editor opens the wrong editor

The app starts the command in the `EDITOR` environment variable. If `EDITOR` is not set, it uses `code`. Set `EDITOR` before you start the server, for example `EDITOR="code -w"` or `EDITOR=cursor`. If the command is not on `PATH`, the app shows `Editor not found on PATH`.

## Analysis

### "claude not found" when you run Analyze

Analyze runs the Claude Code CLI (`claude -p`) on your machine. Install Claude Code, log in, and make sure `claude` is on the `PATH` of the shell that starts the server. Then restart the server.

### A run shows as stalled

The server does not stop a run. After 30 minutes, a run that has not finished shows as stalled, for example after a server restart during the run. If the run finishes later, its result shows. Start a new run from **New analysis…** to replace it.

### A run failed

The error shows above the previous review, with a **Retry** button. Retry runs a new analysis of the auto memory files only. To repeat a run with other files, click **New analysis…**, pick the files, and click **Run analysis**. A run that returns no structured output counts as failed, so an empty result does not mean the files are clean. See [Analyze memory with Claude](/claude-code-memory/guides/analyze/).
