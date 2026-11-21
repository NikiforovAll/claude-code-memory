'use strict';

const path = require('node:path');
const { createAnalysisStore, encodeProjectPath } = require('./analysis-store');
const { resolveClaudeDir } = require('./claude-dir');

const BIN = 'claude-code-memory-explorer';
const SEVERITIES = ['high', 'med', 'low'];
const SEV_WEIGHT = { high: 10, med: 3, low: 1 };

// #region DATA

const findingKey = (f) => `${f.kind}|${f.title}`;

// The same score, weights and finding key as public/app.js, which a browser script cannot share.
function healthScore(findings) {
  return Math.max(2, 100 - findings.reduce((s, f) => s + (SEV_WEIGHT[f.severity] || 1), 0));
}

function sevCounts(findings) {
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

function entryName(entry) {
  return entry.user ? 'user scope' : entry.project || entry.encoded;
}

// A user-scope finding is dismissed in the shared user entry, any other in the project's own.
function liveFindings(run, entry, userEntry) {
  const own = new Set(entry.state.dismissed || []);
  const shared = new Set(userEntry?.state.dismissed || []);
  return (run?.result?.findings || []).filter((f) => !(f.scope === 'user' ? shared : own).has(findingKey(f)));
}

function resolveEntry(entries, raw, cwd) {
  const projects = entries.filter((e) => !e.user);
  const target = raw ?? cwd;
  const encoded = encodeProjectPath(path.resolve(target));
  const byPath = projects.find((e) => e.encoded.toLowerCase() === encoded.toLowerCase());
  if (byPath) return byPath;
  if (raw === undefined) throw usageError(`No analysis results for ${cwd}. See: ${BIN} projects`);
  const norm = (s) => s.toLowerCase().replace(/\\/g, '/');
  const lower = norm(raw);
  const nameOf = (e) => (e.project ? path.basename(e.project) : e.encoded).toLowerCase();
  const named = projects.filter((e) => e.encoded.toLowerCase() === lower || nameOf(e) === lower);
  const hits = named.length ? named : projects.filter((e) => norm(entryName(e)).includes(lower));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw usageError(`No project with analysis results matches "${raw}". See: ${BIN} projects`);
  throw usageError(`"${raw}" matches ${hits.length} projects; pass the path:\n${hits.map((e) => `  ${entryName(e)}`).join('\n')}`);
}

// #endregion

// #region FORMAT

function ago(ts) {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

function countsText(c) {
  return `${c.high} high · ${c.med} med · ${c.low} low`;
}

function runLine(view) {
  const parts = [ago(Date.parse(view.ts)), view.ts];
  if (view.model) parts.push(view.model);
  if (typeof view.costUsd === 'number') parts.push(`$${view.costUsd.toFixed(2)}`);
  if (view.scope) parts.push(`scope: ${view.scope}`);
  return parts.join(' · ');
}

function projectsView(entries, userEntry) {
  return entries.map((e) => {
    const run = e.state.runs[0];
    const findings = liveFindings(run, e, userEntry);
    return {
      project: e.project,
      user: e.user,
      encoded: e.encoded,
      runs: e.state.runs.length,
      running: e.state.pending.some((p) => !p.stalled),
      latest: run ? new Date(run.ts).toISOString() : null,
      health: run ? healthScore(findings) : null,
      counts: sevCounts(findings),
    };
  });
}

function formatProjects(rows) {
  if (!rows.length) return ['No analysis results. Run an analysis in the Memory Diagnoser first.'];
  const lines = [];
  for (const r of rows) {
    lines.push(r.user ? 'user scope (--user)' : r.project || `${r.encoded} (encoded dir)`);
    const state = r.latest ? `health ${r.health}/100 · ${countsText(r.counts)} · ${r.runs} run${r.runs === 1 ? '' : 's'} · latest ${ago(Date.parse(r.latest))}, ${r.latest}` : 'no finished run';
    lines.push(`  ${state}${r.running ? ' · a run is in progress' : ''}`);
  }
  lines.push('', 'Findings: the analysis command with <project>, where <project> is a name above or a part of one.');
  return lines;
}

function analysisView(entry, userEntry, flags) {
  const runs = entry.state.runs;
  const n = flags.run === undefined ? 1 : Number.parseInt(flags.run, 10);
  if (!Number.isInteger(n) || n < 1) throw usageError('--run takes a number from 1, the latest run');
  if (!runs.length) throw usageError(`${entryName(entry)} has no finished run`);
  if (n > runs.length) throw usageError(`--run ${n}: ${entryName(entry)} has ${runs.length} run${runs.length === 1 ? '' : 's'}`);
  if (flags.severity !== undefined && !SEVERITIES.includes(flags.severity)) throw usageError(`--severity takes ${SEVERITIES.join(', ')}`);
  const run = runs[n - 1];
  const all = run.result?.findings || [];
  const live = flags.dismissed ? all : liveFindings(run, entry, userEntry);
  const findings = live.filter((f) => (!flags.severity || f.severity === flags.severity) && (!flags.kind || f.kind === flags.kind));
  return {
    project: entry.project,
    user: entry.user,
    encoded: entry.encoded,
    run: n,
    runs: runs.map((r) => ({ ts: new Date(r.ts).toISOString(), model: r.result?.model || null, scope: r.result?.scopeDesc || null, findings: (r.result?.findings || []).length })),
    ts: new Date(run.ts).toISOString(),
    model: run.result?.model || null,
    costUsd: run.result?.costUsd ?? null,
    scope: run.result?.scopeDesc || null,
    summary: run.result?.summary || null,
    health: healthScore(live),
    counts: sevCounts(live),
    hidden: all.length - live.length,
    audited: (run.audited || []).map((s) => s.name),
    findings,
  };
}

function formatAnalysis(view) {
  const lines = [`${entryName(view)} — run ${view.run} of ${view.runs.length}`, runLine(view)];
  const hidden = view.hidden ? ` · ${view.hidden} dismissed (--dismissed shows them)` : '';
  lines.push(`Health ${view.health}/100 · ${countsText(view.counts)}${hidden}`);
  if (view.audited.length) lines.push(`Audited ${view.audited.length} files`);
  if (view.summary) lines.push('', view.summary);
  if (!view.findings.length) lines.push('', 'No findings match.');
  for (const f of view.findings) {
    lines.push('', `[${f.severity}] ${f.kind}: ${f.title}`);
    if (f.files?.length) lines.push(`  files: ${f.files.join(', ')}`);
    lines.push(`  ${f.detail}`);
    if (f.evidence) lines.push(`  evidence: ${f.evidence}`);
    lines.push(`  fix: ${f.suggestion}`);
  }
  return lines;
}

// #endregion

// #region COMMANDS

const COMMON_FLAGS = {
  '--dir <config dir>': 'Claude config dir (else CLAUDE_CONFIG_DIR, else ~/.claude)',
  '--json': 'Print JSON',
};

const COMMANDS = {
  projects: {
    summary: 'List the projects that have analysis results',
    usage: `${BIN} projects [flags]`,
    flags: COMMON_FLAGS,
    examples: [`${BIN} projects`, `${BIN} projects --json`],
  },
  analysis: {
    summary: 'Show the analysis findings of a project',
    usage: `${BIN} analysis [<project>] [flags]`,
    flags: {
      '--user': 'The user scope: what every session loads',
      '--run <n>': 'A run by number; 1 is the latest (default)',
      '--severity <level>': `Only ${SEVERITIES.join(', ')}`,
      '--kind <kind>': 'Only one kind, such as stale or contradiction',
      '--dismissed': 'Include findings dismissed in the dashboard',
      ...COMMON_FLAGS,
    },
    notes: '<project> is a path, a folder name or a part of one; left out, it is the current folder.\nShows one run. The dashboard also merges runs; this command does not.',
    examples: [`${BIN} analysis`, `${BIN} analysis phoenix --severity high`, `${BIN} analysis C:/dev/app --run 2 --json`, `${BIN} analysis --user`],
  },
};

const BOOLEAN_FLAGS = new Set(['--json', '--user', '--dismissed', '--help', '-h']);
const HELP = new Set(['help', '--help', '-h']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const key = name.replace(/^-+/, '');
    if (BOOLEAN_FLAGS.has(name)) flags[key] = true;
    else if (eq !== -1) flags[key] = a.slice(eq + 1);
    else flags[key] = args[++i];
  }
  return { flags, positional };
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function topHelp() {
  const names = Object.keys(COMMANDS);
  const w = Math.max(...names.map((n) => n.length));
  return [
    `${BIN} — Memory Diagnoser analysis results from the command line`,
    '',
    `Usage: ${BIN} <command> [flags]`,
    `       ${BIN} [--port <n>] [--dir <config dir>] [--project <path>] [--open]   start the dashboard`,
    '',
    'Commands:',
    ...names.map((n) => `  ${n.padEnd(w)}  ${COMMANDS[n].summary}`),
    '',
    'Reads the saved runs in <config dir>/memory-analysis/. It needs no running',
    'dashboard and starts no analysis: run one in the Memory Diagnoser.',
    `Details: ${BIN} help <command>`,
  ].join('\n');
}

function leafHelp(name) {
  const c = COMMANDS[name];
  const lines = [c.summary, '', `Usage: ${c.usage}`];
  const flags = Object.entries(c.flags || {});
  if (flags.length) {
    const w = Math.max(...flags.map(([f]) => f.length));
    lines.push('', 'Flags:', ...flags.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`));
  }
  if (c.notes) lines.push('', c.notes);
  if (c.examples?.length) lines.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

function isCommand(arg) {
  return HELP.has(arg) || Object.hasOwn(COMMANDS, arg || '');
}

function main(args, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env, cwd = process.cwd() } = {}) {
  const [name, ...rest] = args;
  if (HELP.has(name)) {
    out(rest[0] && Object.hasOwn(COMMANDS, rest[0]) ? leafHelp(rest[0]) : topHelp());
    return 0;
  }
  const { flags, positional } = parseArgs(rest);
  if (flags.help || flags.h) {
    out(leafHelp(name));
    return 0;
  }
  try {
    const entries = createAnalysisStore(resolveClaudeDir(flags.dir, env)).list();
    const userEntry = entries.find((e) => e.user);
    if (name === 'projects') {
      const rows = projectsView(entries, userEntry);
      out(flags.json ? JSON.stringify(rows, null, 2) : formatProjects(rows).join('\n'));
      return 0;
    }
    if (flags.user && !userEntry) throw usageError('No analysis results for the user scope');
    const entry = flags.user ? userEntry : resolveEntry(entries, positional[0], cwd);
    const view = analysisView(entry, userEntry, flags);
    out(flags.json ? JSON.stringify(view, null, 2) : formatAnalysis(view).join('\n'));
    return 0;
  } catch (e) {
    err(e.usage ? e.message : `Error: ${e.message}`);
    return 1;
  }
}

// #endregion

module.exports = { isCommand, main, parseArgs };
