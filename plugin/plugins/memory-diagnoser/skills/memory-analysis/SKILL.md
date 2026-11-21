---
name: memory-analysis
description: Answer a question about the Memory Diagnoser's saved analysis of Claude Code memory — which projects have results, a project's health score and its findings.
argument-hint: '[question]'
disable-model-invocation: true
---

# Memory analysis

Answer the user's question about the saved memory analysis with the `claude-code-memory-explorer` CLI. With no question, show `analysis` for the current folder.

## Find the CLI

Use the first that exists:

1. The command your system prompt names for the memory CLI.
2. When the Memory Diagnoser runs (for example in Claude Code Hub), it writes `<config dir>/.memory/server.json`. Read its `script` field, the path of the CLI, and run `node "<that path>"`. The config dir is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Quote the path: on Windows it has backslashes.
3. `claude-code-memory-explorer` on PATH.
4. `npx claude-code-memory-explorer`.

Run `help` first with the command you found. If it prints no command list, the installed version has no CLI: stop, and tell the user to update the Memory Diagnoser or start it.

## Commands

| Command | What it prints |
|---|---|
| `projects` | The projects that have results: health score, finding counts, number of runs, time of the latest run |
| `analysis [<project>]` | The findings of one run. `<project>` is a path, a folder name or a part of one; left out, it is the current folder. `--user` shows the user scope. `--severity <high|med|low>` and `--kind <kind>` filter the findings |

Both take `--json`. `help <command>` prints the other flags.

## Answer

- Report the time of the run with its findings. A run can be old: read the named file before you act on a finding.
- No results, or results too old: the user starts a new analysis in the Memory Diagnoser. The CLI starts none.
- Change a memory file only when the user asks.
