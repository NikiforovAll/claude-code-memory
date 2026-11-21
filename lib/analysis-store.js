'use strict';

const fs = require('node:fs');
const path = require('node:path');

function encodeProjectPath(projectPath) {
  // Claude Code encoding: `:` and `/` both become `-`, so `C:\Users\foo` → `C--Users-foo`
  return projectPath
    .replace(/\\/g, '/')
    .replace(/:/g, '-')
    .replace(/\//g, '-');
}

const EMPTY_ANALYSIS = { pending: [], result: null, error: null, hash: null, ts: null, ids: null, runs: [], dismissed: [] };

// Findings about the user-level CLAUDE.md are shared across projects: they live in
// their own entry so any project's view (and dismissals) sees the same audit.
// The sentinel contains ':' mid-string, which encodeProjectPath output never keeps,
// so it cannot collide with a real project file.
const USER_SCOPE = '::user::';
const USER_FILE = 'user-scope.json';

// A pending entry whose server died mid-run would otherwise show as running forever.
// Instead of deleting it (losing the trace), mark it stalled: the UI stops spinning
// but the entry survives — if its run ever completes, the completion handler still
// removes it by id and the result surfaces. Runs are never killed, so stalled is a
// hint ("probably orphaned by a server restart"), not a verdict.
const PENDING_STALL_MS = 1_800_000;
function markStalePending(pending) {
  const cutoff = Date.now() - PENDING_STALL_MS;
  return (pending || []).map((p) => (p.startedAt > cutoff ? p : { ...p, stalled: true }));
}

// Analysis state lives in one file per project under <config dir>/memory-analysis/,
// named by the same path encoding Claude Code uses for its projects dir. Disk is the
// single source of truth — in-flight runs are persisted as `pending` entries so they
// survive page reloads and are visible to other server instances (hub + standalone)
// and to the CLI.
function createAnalysisStore(claudeDir) {
  const dir = path.join(claudeDir, 'memory-analysis');

  function file(project) {
    return path.join(dir, project === USER_SCOPE ? USER_FILE : `${encodeProjectPath(project)}.json`);
  }

  function load(filePath) {
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
    const loaded = { ...EMPTY_ANALYSIS, ...st };
    loaded.pending = markStalePending(loaded.pending);
    // result/ts/hash/ids are a projection of the newest run — derived here so no
    // writer can persist them out of sync with the runs history.
    const latest = (loaded.runs || [])[0];
    loaded.result = latest?.result || null;
    loaded.ts = latest?.ts || null;
    loaded.hash = latest?.hash || null;
    loaded.ids = latest ? latest.ids : null;
    return loaded;
  }

  function get(project) {
    return load(file(project)) || { ...EMPTY_ANALYSIS };
  }

  // `project` is written for the CLI: the file name alone cannot give the path back.
  function save(project, st) {
    const { pending = [], error = null, runs = [], dismissed = [] } = st;
    try {
      if (!pending.length && !error && !runs.length && !dismissed.length) {
        fs.rmSync(file(project), { force: true });
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const body = { project: project === USER_SCOPE ? null : project, pending, error, runs, dismissed };
      fs.writeFileSync(file(project), JSON.stringify(body), 'utf-8');
    } catch { /* best-effort persistence */ }
  }

  // Every entry on disk, the user scope included. `project` is null for a file written before
  // the path was stored.
  function list() {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const state = load(path.join(dir, name));
      if (!state) continue;
      const user = name === USER_FILE;
      entries.push({ encoded: name.slice(0, -'.json'.length), user, project: user ? null : state.project || null, state });
    }
    return entries;
  }

  return { get, save, list };
}

module.exports = { createAnalysisStore, encodeProjectPath, EMPTY_ANALYSIS, USER_SCOPE };
