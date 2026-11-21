const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isCommand, main, parseArgs } = require('../lib/cli');
const { createAnalysisStore, USER_SCOPE } = require('../lib/analysis-store');

const finding = (severity, title, extra = {}) => ({
  kind: 'stale',
  severity,
  scope: 'project',
  title,
  detail: `${title} detail`,
  files: ['a.md'],
  suggestion: `${title} fix`,
  ...extra,
});

const run = (ts, findings, extra = {}) => ({
  ts,
  hash: 'h',
  ids: ['memory-index'],
  audited: [{ id: 'memory-index', name: 'MEMORY.md', scope: 'memory', lines: 3 }],
  result: { summary: 'Summary text', findings, costUsd: 1.234, model: 'opus', scopeDesc: '1 memory', ...extra },
});

function configDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cli-'));
  const store = createAnalysisStore(dir);
  const api = path.join(dir, 'work', 'api');
  const web = path.join(dir, 'work', 'storefront');
  store.save(api, {
    runs: [run(Date.now() - 60_000, [finding('high', 'Old azt'), finding('low', 'Typo')]), run(Date.now() - 7_200_000, [finding('med', 'Earlier')])],
    dismissed: ['stale|Typo'],
  });
  store.save(web, { runs: [run(Date.now() - 120_000, [])] });
  store.save(USER_SCOPE, { runs: [run(Date.now() - 180_000, [finding('med', 'Broad rule', { scope: 'user' })])] });
  return { dir, api, web };
}

function cli(args, opts = {}) {
  const out = [];
  const err = [];
  const code = main(args, { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, cwd: os.tmpdir(), ...opts });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('isCommand', () => {
  it('takes the commands and help, and leaves the server flags to the server', () => {
    for (const a of ['projects', 'analysis', 'help', '--help', '-h']) assert.equal(isCommand(a), true, a);
    for (const a of [undefined, '--port', '--open', '--project', 'toString']) assert.equal(isCommand(a), false, String(a));
  });
});

describe('parseArgs', () => {
  it('reads values, = values and boolean flags', () => {
    assert.deepEqual(parseArgs(['api', '--run', '2', '--severity=high', '--json']), {
      flags: { run: '2', severity: 'high', json: true },
      positional: ['api'],
    });
  });
});

describe('help', () => {
  it('lists the commands, then the flags of one', () => {
    const top = cli(['help']);
    assert.equal(top.code, 0);
    assert.match(top.out, /projects\s+List the projects/);
    assert.match(top.out, /analysis\s+Show the analysis findings/);
    assert.match(cli(['help', 'analysis']).out, /--severity <level>/);
    assert.match(cli(['analysis', '--help']).out, /--run <n>/);
  });
});

describe('projects', () => {
  it('lists each project with its path, score and counts', () => {
    const { dir, api, web } = configDir();
    const rows = JSON.parse(cli(['projects', '--json', '--dir', dir]).out);
    const byProject = Object.fromEntries(rows.map((r) => [r.user ? 'user' : r.project, r]));
    assert.deepEqual(byProject[api].counts, { high: 1, med: 0, low: 0 });
    assert.equal(byProject[api].health, 90);
    assert.equal(byProject[api].runs, 2);
    assert.equal(byProject[web].health, 100);
    assert.equal(byProject.user.counts.med, 1);
    assert.match(cli(['projects', '--dir', dir]).out, /user scope \(--user\)/);
  });

  it('says so when the config dir has no results', () => {
    const r = cli(['projects', '--dir', fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cli-'))]);
    assert.equal(r.code, 0);
    assert.match(r.out, /No analysis results/);
  });
});

describe('analysis', () => {
  it('finds a project by path, by folder name and by the current folder', () => {
    const { dir, api } = configDir();
    for (const args of [[api], ['api'], ['API'], ['work\\ap'], ['work/ap']]) {
      const r = cli(['analysis', ...args, '--dir', dir]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /\[high\] stale: Old azt/);
    }
    assert.match(cli(['analysis', '--dir', dir], { cwd: api }).out, /Old azt/);
  });

  it('hides dismissed findings unless asked', () => {
    const { dir } = configDir();
    const live = cli(['analysis', 'api', '--dir', dir]).out;
    assert.doesNotMatch(live, /Typo/);
    assert.match(live, /Health 90\/100 · 1 high · 0 med · 0 low · 1 dismissed/);
    assert.match(cli(['analysis', 'api', '--dismissed', '--dir', dir]).out, /\[low\] stale: Typo/);
  });

  it('filters by severity and picks an older run', () => {
    const { dir } = configDir();
    assert.match(cli(['analysis', 'api', '--severity', 'low', '--dir', dir]).out, /No findings match/);
    const older = JSON.parse(cli(['analysis', 'api', '--run', '2', '--json', '--dir', dir]).out);
    assert.equal(older.run, 2);
    assert.deepEqual(older.findings.map((f) => f.title), ['Earlier']);
    assert.equal(older.runs.length, 2);
  });

  it('shows the user scope', () => {
    const { dir } = configDir();
    assert.match(cli(['analysis', '--user', '--dir', dir]).out, /^user scope — run 1 of 1[\s\S]*Broad rule/);
  });

  it('fails with a pointer to projects on a bad project, run or severity', () => {
    const { dir } = configDir();
    const cases = [
      [['analysis', 'nope'], /No project with analysis results matches "nope"/],
      [['analysis'], /No analysis results for .*See: claude-code-memory-explorer projects/],
      [['analysis', 'api', '--run', '9'], /has 2 runs/],
      [['analysis', 'api', '--severity', 'urgent'], /--severity takes high, med, low/],
    ];
    for (const [args, re] of cases) {
      const r = cli([...args, '--dir', dir]);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, re);
    }
  });
});

describe('bin.js', () => {
  it('runs a command without starting the server', () => {
    const { dir } = configDir();
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin.js'), 'projects', '--dir', dir], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /health 90\/100/);
    assert.doesNotMatch(r.stdout, /running at/);
  });
});
