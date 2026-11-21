---
name: memory-analysis
description: Read the Memory Diagnoser's saved analysis of Claude Code memory (CLAUDE.md, rules, auto memory) — which projects have results, a project's health score and its findings.
argument-hint: '[projects|analysis] [project] [flags]'
disable-model-invocation: true
---

# Memory analysis

The skill is a thin wrapper over the `claude-code-memory-explorer` CLI. Find the command in this order:

1. The command your system prompt names for the memory CLI, when it names one.
2. `node "<script>"`, where `script` is in `<config dir>/.memory/server.json`. The config dir is `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Put every path in quotes: on Windows it has backslashes. The file exists while the Memory Diagnoser runs, for example in Claude Code Hub.
3. `claude-code-memory-explorer` on PATH.
4. `npx claude-code-memory-explorer`.

Run `help` first with the command you found. If it prints no command list, the installed version has no CLI: stop, and tell the user to update the Memory Diagnoser or start it.

## Commands

| Command | What it prints |
|---|---|
| `projects` | The projects that have results: health score, finding counts, number of runs, time of the latest run |
| `analysis [<project>]` | The findings of one run. `<project>` is a path, a folder name or a part of one; left out, it is the current folder. `--user` shows the user scope. `--severity <high|med|low>` and `--kind <kind>` filter the findings |

Both take `--json`. `help <command>` prints the other flags.

## Rules

- The commands only read saved runs. They start no analysis: the user runs one in the Memory Diagnoser.
- A run can be old. Report its time, and read the named file before you act on a finding.
- A finding names its files and a suggested fix. Change a memory file only when the user asks.
