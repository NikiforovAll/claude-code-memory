#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const { assertOpenTarget, openInEditor } = require('./lib/open-editor');
const { createNetGuard } = require('./lib/net-guard');

// #region CLI_ARGS

function getArg(name) {
  const eqIdx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return null;
  const arg = process.argv[eqIdx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[eqIdx + 1] || null;
}

const expandHome = (p) => (typeof p === 'string' ? p : '').replace(/^~/, os.homedir());

const PORT = getArg('port') || process.env.PORT || 3544;
const AUTO_OPEN = process.argv.includes('--open');
const claudeDirArg = getArg('dir') || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_DIR;
const CLAUDE_DIR = claudeDirArg ? expandHome(claudeDirArg) : path.join(os.homedir(), '.claude');
const projectDirArg = getArg('project');

// #endregion CLI_ARGS

// #region STATE

let currentProjectPath = projectDirArg ? path.resolve(expandHome(projectDirArg)) : process.cwd();

const cache = {};
const CACHE_TTL = 30_000;

function cached(key, fn) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  const data = fn();
  cache[key] = { data, ts: Date.now() };
  return data;
}

function clearCache() {
  for (const k of Object.keys(cache)) delete cache[k];
}

// #endregion STATE

// #region FILESYSTEM_SCANNING

const CLAUDE_MD_VARIANTS = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.local.md'];

const slug = s => s.replace(/[^a-zA-Z0-9]/g, '-');

const MANAGED_POLICY_PATHS = process.platform === 'win32'
  ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'CLAUDE.md')]
  : process.platform === 'darwin'
    ? ['/Library/Application Support/ClaudeCode/CLAUDE.md']
    : ['/etc/claude-code/CLAUDE.md'];

function fileInfo(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    const bytes = Buffer.byteLength(content, 'utf-8');
    const chars = content.length;
    const frontmatter = parseFrontmatter(content);
    return { path: filePath, content, lines, bytes, chars, frontmatter };
  } catch {
    return null;
  }
}

function stripQuotes(val) {
  if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const fm = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const val = kv[2].trim();
    i++;
    if (/^[>|][+-]?$/.test(val)) {
      // Block scalar (>, >-, |, |-): consume the indented block that follows
      const block = [];
      while (i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim())) {
        block.push(lines[i]);
        i++;
      }
      while (block.length && !block[block.length - 1].trim()) block.pop();
      const indents = block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
      const indent = indents.length ? Math.min(...indents) : 0;
      const body = block.map((l) => l.slice(indent));
      // Folded (>) joins lines with spaces; literal (|) keeps newlines
      fm[key] = val[0] === '>' ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n');
    } else if (!val) {
      // Nested block: list items or a child map
      const arr = [];
      const map = {};
      while (i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim())) {
        const item = lines[i].match(/^\s+-\s+"?(.+?)"?\s*$/);
        const child = lines[i].match(/^\s+([\w-]+):\s*(.*)$/);
        if (item) arr.push(item[1]);
        else if (child) map[child[1]] = stripQuotes(child[2].trim());
        i++;
      }
      fm[key] = arr.length ? arr : Object.keys(map).length ? map : [];
    } else if (val.startsWith('[')) {
      try {
        fm[key] = JSON.parse(val.replace(/'/g, '"'));
      } catch {
        fm[key] = val;
      }
    } else {
      // Plain scalar; YAML folds indented continuation lines into the value
      let scalar = val;
      while (
        i < lines.length && lines[i].trim() && /^\s/.test(lines[i]) &&
        !/^\s+(?:[\w-]+:|-\s)/.test(lines[i])
      ) {
        scalar += ` ${lines[i].trim()}`;
        i++;
      }
      fm[key] = stripQuotes(scalar);
    }
  }
  return Object.keys(fm).length ? fm : null;
}

function parseImports(content) {
  const imports = [];
  const softLinks = [];
  // Match @path/to/file.ext — must contain / or \ to be a file path import
  const re = /@(~?[\w./-]+\/[\w./-]+|~\/[\w./-]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1].includes('.') && !m[1].includes('/')) continue;
    // Skip npm scoped packages (e.g. @biomejs/biome) — require file extension in last segment
    const lastSeg = m[1].split('/').pop();
    if (!lastSeg.includes('.')) continue;
    imports.push(m[1]);
  }
  // Also match standalone @filename.md references (no path separator needed)
  const re2 = /(?:^|\s)@([\w-]+\.md)\b/gm;
  while ((m = re2.exec(content)) !== null) {
    if (!imports.includes(m[1])) imports.push(m[1]);
  }
  // Match markdown links [text](path.md) — soft references, don't change load type
  const re3 = /\[.*?\]\(((?!https?:\/\/)[^)]+\.md)\)/g;
  while ((m = re3.exec(content)) !== null) {
    if (!imports.includes(m[1]) && !softLinks.includes(m[1])) softLinks.push(m[1]);
  }
  return { imports, softLinks };
}

function resolveImport(importPath, fromFile) {
  let resolved = importPath;
  if (resolved.startsWith('~')) {
    resolved = expandHome(resolved);
  } else {
    resolved = path.resolve(path.dirname(fromFile), resolved);
  }
  return resolved;
}

function resolveAllImports(filePath, content) {
  const { imports: raw, softLinks } = parseImports(content);
  const resolved = [];
  const resolvedSoft = [];
  const unresolved = [];
  for (const imp of raw) {
    const abs = resolveImport(imp, filePath);
    if (fs.existsSync(abs)) resolved.push(abs);
    else unresolved.push(imp);
  }
  for (const imp of softLinks) {
    const abs = resolveImport(imp, filePath);
    if (fs.existsSync(abs)) resolvedSoft.push(abs);
    else unresolved.push(imp);
  }
  return { resolved, resolvedSoft, unresolved };
}

function resolveExistingImports(filePath, content) {
  const { resolved, resolvedSoft } = resolveAllImports(filePath, content);
  return [...resolved, ...resolvedSoft];
}

function spreadImports(filePath, content) {
  const { resolved, resolvedSoft, unresolved } = resolveAllImports(filePath, content);
  return { imports: resolved, softImports: resolvedSoft, unresolvedImports: unresolved };
}

function hasPathsFilter(frontmatter) {
  if (!frontmatter || !frontmatter.paths) return false;
  return Array.isArray(frontmatter.paths) ? frontmatter.paths.length > 0 : true;
}

function discoverMemorySources(projectPath) {
  const sources = [];

  // 1. Managed policy
  for (const p of MANAGED_POLICY_PATHS) {
    const info = fileInfo(p);
    if (info) {
      sources.push({
        id: 'policy-claude-md',
        name: 'CLAUDE.md',
        scope: 'policy',
        load: 'always',
        ...info,
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 2. User CLAUDE.md
  const userClaudeMd = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const userInfo = fileInfo(userClaudeMd);
  if (userInfo) {
    sources.push({
      id: 'user-claude-md',
      name: 'CLAUDE.md',
      scope: 'user',
      load: 'always',
      ...userInfo,
      ...spreadImports(userInfo.path, userInfo.content),
    });
  }

  // 3. User rules (~/.claude/rules/*.md)
  const userRulesDir = path.join(CLAUDE_DIR, 'rules');
  if (fs.existsSync(userRulesDir)) {
    for (const file of findMdFiles(userRulesDir)) {
      const info = fileInfo(file);
      if (!info) continue;
      sources.push({
        id: `user-rule-${path.basename(file, '.md')}`,
        name: path.basename(file),
        scope: 'rule',
        load: hasPathsFilter(info.frontmatter) ? 'conditional' : 'always',
        ...info,
        ruleSource: 'user',
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 4. Walk up from projectPath to find CLAUDE.md and CLAUDE.local.md
  const ancestors = getAncestorDirs(projectPath);
  const seenPaths = new Set(sources.map(s => s.path));
  for (const dir of ancestors) {
    const isProjectRoot = path.resolve(dir) === path.resolve(projectPath);
    for (const rel of CLAUDE_MD_VARIANTS) {
      const filePath = path.join(dir, rel);
      if (seenPaths.has(filePath)) continue;
      const info = fileInfo(filePath);
      if (!info) continue;
      seenPaths.add(filePath);
      sources.push({
        id: `project-claude-md-${slug(rel)}-${slug(dir)}`,
        name: rel,
        scope: 'project',
        load: 'always',
        ...info,
        dir,
        isProjectRoot,
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 4b. Scan subdirectories of projectPath for CLAUDE.md (tree-scoped)
  const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv']);
  const nestedSkillDirs = [];
  function walkForClaudeMd(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const subdir = path.join(dir, entry.name);
      for (const name of CLAUDE_MD_VARIANTS) {
        const filePath = path.join(subdir, name);
        if (seenPaths.has(filePath)) continue;
        const info = fileInfo(filePath);
        if (!info) continue;
        seenPaths.add(filePath);
        const rel = path.relative(projectPath, subdir).replace(/\\/g, '/');
        sources.push({
          id: `project-claude-md-${slug(name)}-${slug(subdir)}`,
          name: `${rel}/${name}`,
          scope: 'project',
          load: 'tree',
          ...info,
          dir: subdir,
          isProjectRoot: false,
          ...spreadImports(info.path, info.content),
        });
      }
      const nestedSkills = path.join(subdir, '.claude', 'skills');
      if (fs.existsSync(nestedSkills)) {
        nestedSkillDirs.push({ dir: nestedSkills, rel: path.relative(projectPath, subdir).replace(/\\/g, '/') });
      }
      walkForClaudeMd(subdir, depth + 1);
    }
  }
  walkForClaudeMd(projectPath, 0);

  // 5. Project rules (.claude/rules/*.md)
  const projectRulesDir = path.join(projectPath, '.claude', 'rules');
  if (fs.existsSync(projectRulesDir)) {
    for (const file of findMdFiles(projectRulesDir)) {
      const info = fileInfo(file);
      if (!info) continue;
      sources.push({
        id: `project-rule-${path.basename(file, '.md')}`,
        name: path.basename(file),
        scope: 'rule',
        load: hasPathsFilter(info.frontmatter) ? 'conditional' : 'always',
        ...info,
        ruleSource: 'project',
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 5b. Project skills (.claude/skills, incl. nested subdirectory skill dirs)
  function pushSkill(file, skillSource, extra = {}) {
    const info = fileInfo(file);
    if (!info) return;
    const dirName = path.basename(path.dirname(file));
    const skillName = (info.frontmatter && typeof info.frontmatter.name === 'string' && info.frontmatter.name) || dirName;
    const display = extra.nestedRel ? `${extra.nestedRel}:${skillName}` : skillName;
    sources.push({
      id: `skill-${skillSource}-${slug(file)}`,
      name: display,
      scope: 'skill',
      load: 'ondemand',
      skillSource,
      skillName,
      ...extra,
      ...info,
      ...spreadImports(info.path, info.content),
    });
  }
  for (const file of findSkillFiles(path.join(projectPath, '.claude', 'skills'))) pushSkill(file, 'project');
  for (const { dir, rel } of nestedSkillDirs) {
    for (const file of findSkillFiles(dir)) pushSkill(file, 'project', { nestedRel: rel });
  }

  function pushMemoryDir(dir, scope, idPrefix, extraFields = {}) {
    const memoryMd = path.join(dir, 'MEMORY.md');
    const memInfo = fileInfo(memoryMd);
    if (memInfo) {
      sources.push({
        id: `${idPrefix}-index`,
        name: 'MEMORY.md',
        scope,
        load: 'startup',
        ...extraFields,
        ...memInfo,
        maxLines: 200,
        maxBytes: 25 * 1024,
        ...spreadImports(memInfo.path, memInfo.content),
      });
    }
    for (const file of findMdFiles(dir)) {
      if (path.basename(file) === 'MEMORY.md') continue;
      const info = fileInfo(file);
      if (!info) continue;
      sources.push({
        id: `${idPrefix}-${path.basename(file, '.md')}`,
        name: path.basename(file),
        scope,
        load: 'ondemand',
        ...extraFields,
        ...info,
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 6. Auto memory (projects base honors `autoMemoryDirectory` user setting)
  const memoryDir = findMemoryDir(projectPath);
  if (memoryDir && fs.existsSync(memoryDir)) {
    pushMemoryDir(memoryDir, 'memory', 'memory');
  }

  // 7. Subagent persistent memory (https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)
  //    user:    ~/.claude/agent-memory/<agent>/
  //    project: <project>/.claude/agent-memory/<agent>/
  //    local:   <project>/.claude/agent-memory-local/<agent>/
  const agentMemoryRoots = [
    { root: path.join(CLAUDE_DIR, 'agent-memory'), agentScope: 'user' },
    { root: path.join(projectPath, '.claude', 'agent-memory'), agentScope: 'project' },
    { root: path.join(projectPath, '.claude', 'agent-memory-local'), agentScope: 'local' },
  ];
  for (const { root, agentScope } of agentMemoryRoots) {
    let agentDirs;
    try { agentDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of agentDirs) {
      if (!entry.isDirectory()) continue;
      const agentName = entry.name;
      const idPrefix = `agent-memory-${agentScope}-${agentName.replace(/[^a-zA-Z0-9]/g, '-')}`;
      pushMemoryDir(path.join(root, agentName), 'agent-memory', idPrefix, { agentScope, agentName });
    }
  }

  // Resolve imports recursively — add imported files as sources if not already present
  const seen = new Set(sources.map(s => s.path));
  const sourceByPath = Object.fromEntries(sources.map(s => [s.path, s]));
  // Hard imports (@) get load:'import'; soft imports (markdown links) just reparent
  const queue = sources.flatMap(s => [
    ...(s.imports || []).map(imp => ({ imp, parent: s, hard: true })),
    ...(s.softImports || []).map(imp => ({ imp, parent: s, hard: false })),
  ]);
  let depth = 0;
  while (queue.length && depth < 5) {
    const batch = queue.splice(0, queue.length);
    for (const { imp, parent, hard } of batch) {
      if (seen.has(imp)) {
        const existing = sourceByPath[imp];
        if (existing && !existing.parentId && (existing.scope === 'memory' || existing.scope === 'agent-memory')) {
          existing.parentId = parent.id;
          if (hard) existing.load = 'import';
        }
        continue;
      }
      seen.add(imp);
      const info = fileInfo(imp);
      if (!info) continue;
      const { resolved: imports, resolvedSoft: softImports, unresolved: unresolvedImports } = resolveAllImports(imp, info.content);
      const source = {
        id: `import-${imp.replace(/[^a-zA-Z0-9]/g, '-')}`,
        name: path.basename(imp),
        scope: parent.scope,
        load: hard ? 'import' : 'link',
        ...info,
        importedBy: parent.path,
        parentId: parent.id,
        imports,
        softImports,
        unresolvedImports,
      };
      sources.push(source);
      sourceByPath[imp] = source;
      for (const child of imports) queue.push({ imp: child, parent: source, hard: true });
      for (const child of softImports) queue.push({ imp: child, parent: source, hard: false });
    }
    depth++;
  }

  return sources;
}

function findSkillFiles(root) {
  return findMdFiles(root, { name: 'SKILL.md', maxDepth: 4 });
}

function findMdFiles(dir, opts = {}, depth = 0) {
  const { name = null, maxDepth = Infinity } = opts;
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) results.push(...findMdFiles(full, opts, depth + 1));
      } else if (entry.isFile() && (name ? entry.name === name : entry.name.endsWith('.md'))) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

function getAncestorDirs(projectPath) {
  const dirs = [];
  let current = path.resolve(projectPath);
  const root = path.parse(current).root;
  while (current !== root) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function findMemoryDir(projectPath) {
  const projectsDir = getProjectsBaseDir();
  if (!fs.existsSync(projectsDir)) return null;
  const encoded = encodeProjectPath(projectPath);
  const memDir = path.join(projectsDir, encoded, 'memory');
  if (fs.existsSync(memDir)) return memDir;
  const main = findMainWorktreePath(projectPath);
  if (main) {
    const mainMem = path.join(projectsDir, encodeProjectPath(main), 'memory');
    if (fs.existsSync(mainMem)) return mainMem;
  }
  return findMemoryDirBySubstring(projectPath);
}

function findMainWorktreePath(projectPath) {
  try {
    // cwd rather than `-C <path>`: a projectPath beginning with a dash would
    // otherwise be parsed by git as a flag instead of a directory.
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (!out) return null;
    const resolved = path.resolve(projectPath, out);
    if (path.basename(resolved) !== '.git') return null;
    const main = path.dirname(resolved);
    if (main === path.resolve(projectPath)) return null;
    return main;
  } catch {
    return null;
  }
}

function encodeProjectPath(projectPath) {
  // Claude Code encoding: `:` and `/` both become `-`, so `C:\Users\foo` → `C--Users-foo`
  return projectPath
    .replace(/\\/g, '/')
    .replace(/:/g, '-')
    .replace(/\//g, '-');
}

// User-scope `autoMemoryDirectory` only — Claude Code rejects this key from project/local settings for security.
function getProjectsBaseDir() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf-8')); } catch { /* no settings */ }
  const raw = settings.autoMemoryDirectory;
  if (typeof raw === 'string' && raw.trim()) return path.resolve(expandHome(raw));
  return path.join(CLAUDE_DIR, 'projects');
}

function findMemoryDirBySubstring(projectPath) {
  const projectsDir = getProjectsBaseDir();
  if (!fs.existsSync(projectsDir)) return null;
  // Match by last 2-3 path segments
  const segments = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const suffix = segments.slice(-2).join('-').toLowerCase();
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const d of dirs) {
      if (d.toLowerCase().endsWith(suffix)) {
        const candidate = path.join(projectsDir, d, 'memory');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch { /* skip */ }
  return null;
}

// #endregion FILESYSTEM_SCANNING

// #region API_ENDPOINTS

const micromatch = require('micromatch');

function getStack() {
  return cached('stack', () => discoverMemorySources(currentProjectPath));
}

function stripContent(source) {
  const { content, ...rest } = source;
  return rest;
}

// #endregion API_ENDPOINTS

// #region EXPRESS

const app = express();

// Mounted before express.json() so a rejected request never buffers a body.
const net = createNetGuard({ appName: 'Memory Diagnoser' });
app.use(net.hostGuard);
app.use(net.frameGuard);
app.use(net.originGuard);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/hub-config', (_req, res) => {
  res.json({
    name: 'Memory Diagnoser',
    icon: 'brain',
    description: 'Explore Claude Code memory sources',
    enabled: !!process.env.CLAUDE_HUB,
    url: process.env.HUB_URL || null,
  });
});

app.get('/api/project', (_req, res) => {
  res.json({ path: currentProjectPath, name: path.basename(currentProjectPath) });
});

app.put('/api/project', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(expandHome(dirPath));
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'directory not found' });
  if (resolved !== path.resolve(currentProjectPath)) {
    currentProjectPath = resolved;
    clearCache();
  }
  res.json({ path: currentProjectPath, name: path.basename(currentProjectPath) });
});

app.post('/api/refresh', (_req, res) => {
  clearCache();
  res.json({ ok: true });
});

function resolveAllowedPath(filePath) {
  if (!filePath) return { error: { status: 400, message: 'path required' } };
  const resolved = path.resolve(expandHome(filePath));
  const roots = [
    path.resolve(CLAUDE_DIR),
    path.resolve(currentProjectPath),
    getProjectsBaseDir(),
  ];
  const inRoot = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
  if (!inRoot) return { error: { status: 403, message: 'path outside allowed roots' } };
  return { resolved };
}

app.delete('/api/file', (req, res) => {
  const { resolved, error } = resolveAllowedPath(req.body?.path);
  if (error) return res.status(error.status).json({ error: error.message });
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
    fs.unlinkSync(resolved);
    clearCache();
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/cleanup-orphans', (req, res) => {
  const { resolved, error } = resolveAllowedPath(req.body?.path);
  if (error) return res.status(error.status).json({ error: error.message });
  if (path.basename(resolved) !== 'MEMORY.md') return res.status(400).json({ error: 'not a MEMORY.md file' });
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const dir = path.dirname(resolved);
    const lines = content.split('\n');
    const removed = [];
    const kept = [];
    const linkRe = /^\s*-\s*\[([^\]]+)\]\(([^)]+\.md)\)/;
    for (const line of lines) {
      const m = line.match(linkRe);
      if (m) {
        const target = path.resolve(dir, m[2]);
        if (!fs.existsSync(target)) {
          removed.push({ name: m[1], file: m[2] });
          continue;
        }
      }
      kept.push(line);
    }
    if (removed.length === 0) return res.json({ ok: true, removed: [] });
    fs.writeFileSync(resolved, kept.join('\n'), 'utf-8');
    clearCache();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// #region ANALYZER

// Auto-memory audit drafted by spawning Claude Code headlessly (`claude -p`), following
// the airun-coach-cockpit pattern: prompt via stdin (avoids the Windows arg-length cap),
// shape enforced by the CLI's native --json-schema flag, result read from the JSON
// envelope's structured_output field.
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['duplicate', 'contradiction', 'promote', 'merge', 'stale', 'invalidate', 'quality', 'override', 'shadow', 'demote'] },
          severity: { type: 'string', enum: ['high', 'med', 'low'] },
          scope: { type: 'string', enum: ['user', 'project', 'cross'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          suggestion: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['kind', 'severity', 'scope', 'title', 'detail', 'files', 'suggestion'],
      },
    },
  },
  required: ['summary', 'findings'],
};

// Analysis state lives in one file per project under ~/.claude/memory-analysis/,
// named by the same path encoding Claude Code uses for its projects dir. Disk is the
// single source of truth — in-flight runs are persisted as `pending` entries so they
// survive page reloads and are visible to other server instances (hub + standalone).
const ANALYSIS_DIR = path.join(CLAUDE_DIR, 'memory-analysis');

const EMPTY_ANALYSIS = { pending: [], result: null, error: null, hash: null, ts: null, ids: null, runs: [], dismissed: [] };
const MAX_ANALYSIS_RUNS = 10;

// Findings about the user-level CLAUDE.md are shared across projects: they live in
// their own entry so any project's view (and dismissals) sees the same audit.
// The sentinel contains ':' mid-string, which encodeProjectPath output never keeps,
// so it cannot collide with a real project file.
const USER_SCOPE = '::user::';

function analysisFile(project) {
  if (project === USER_SCOPE) return path.join(ANALYSIS_DIR, 'user-scope.json');
  return path.join(ANALYSIS_DIR, `${encodeProjectPath(project)}.json`);
}

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

function getAnalysisState(project) {
  let st = null;
  try {
    st = JSON.parse(fs.readFileSync(analysisFile(project), 'utf-8'));
  } catch {
    return { ...EMPTY_ANALYSIS };
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

function saveAnalysisState(project, st) {
  const { pending = [], error = null, runs = [], dismissed = [] } = st;
  try {
    if (!pending.length && !error && !runs.length && !dismissed.length) {
      fs.rmSync(analysisFile(project), { force: true });
      return;
    }
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    fs.writeFileSync(analysisFile(project), JSON.stringify({ pending, error, runs, dismissed }), 'utf-8');
  } catch { /* best-effort persistence */ }
}

function memoryContentHash(sources) {
  const h = crypto.createHash('sha1');
  for (const s of sources) h.update(s.path).update('\0').update(s.content).update('\0');
  return h.digest('hex');
}

// Distilled from the "writing-for-agents" skill — inlined so the audit never depends on
// that skill being installed on the machine running the analysis. Split into a shared
// core plus per-type rubrics: a good memory file, a good skill, and a good CLAUDE.md
// have different failure modes, so each type only gets the criteria that apply to it.
const RUBRIC_CORE = [
  'Shared criteria (all audited files):',
  '- Positive phrasing: state the target behavior, not a prohibition — negations make the banned behavior more salient.',
  '- No caches of the environment: do not restate what package.json, --help, or the directory layout already says; it goes stale. Record the unwritten convention, the why, the gotcha.',
  '- No no-ops: an instruction the model already does by default is dead weight.',
  '- Single source of truth: one meaning lives in one place; duplication costs maintenance and inflates prominence.',
].join('\n');

const RUBRIC_MEMORY = [
  'Memory-file criteria (auto memory and agent memory):',
  '- One fact per file, with the why: a memory missing its rationale ("**Why:**") cannot be applied correctly later.',
  '- Index earns its cost: MEMORY.md lines are always loaded — each line must be a sharp pointer (title + hook), never content.',
  '- Durable, not episodic: record the lesson or convention, not the story of one session; convert relative dates to absolute.',
  '- Still true: a memory naming a file, flag, or command that no longer matches its own description is stale.',
].join('\n');

const RUBRIC_SKILL = [
  'Skill criteria (SKILL.md files):',
  '- Pointer wording: the description must front-load its trigger words and list the distinct cases it handles; a weak description means the skill never fires.',
  '- Progressive disclosure: inline what every use needs; push branch-specific reference into sibling files behind pointers. A bloated top file buries its steps.',
  '- Completion criteria: steps should end on a checkable, demanding bound ("every X accounted for"), not a vague one ("understanding reached").',
].join('\n');

const RUBRIC_CLAUDE_MD = [
  'CLAUDE.md criteria (always-loaded project instructions):',
  '- Every word pays a per-turn cost, and non-universal content trains the model to ignore the whole file: flag task-specific or situational instructions that belong in a skill, slash command, rule file, or pointed-to doc.',
  '- Flag vague or no-op rules: unbounded adjectives ("format code properly", "be careful") and instructions the model already follows by default ("write clean code") — require specific, checkable directives.',
  '- Flag content the environment already answers cheaply (package.json scripts, --help output, what the code shows): it duplicates a source of truth and goes stale. Keep only unwritten conventions, gotchas, and the reasons behind choices.',
  '- Flag stale or wrong facts: commands that no longer exist, paths that do not match the repo, references to removed tools — verify against the repo.',
  '- Flag emphasis inflation: IMPORTANT/ALWAYS/NEVER/caps on routine guidance dilutes the few rules that genuinely need them.',
  '- Flag wrong scope: personal preferences in a shared project file (belong in the global CLAUDE.md or CLAUDE.local.md), subdirectory-only rules in the root file, project specifics in the global file.',
  '- Flag lint-shaped rules (formatting, import order, naming style) that a deterministic linter or hook should enforce instead of the model.',
  '- Flag surprising or restrictive rules with no WHY: a bare prohibition gets overridden when inconvenient; a one-clause reason makes it generalize.',
  '- Flag instructions Claude cannot act on: rules aimed at humans, tools or files it cannot access, conditions it cannot detect.',
  '- Flag long inlined code snippets or command output where a file pointer would do, and token-wasteful formatting (decorative headers, filler prose, deep nesting for a few bullets).',
  '- Missing high-value content is also a finding: the build/test/run commands, non-obvious architecture facts, and repo-specific gotchas are exactly what the file exists to carry.',
].join('\n');

// The user-level CLAUDE.md loads in every session of every project, so its rubric is
// project-blind: rules must hold everywhere, and verification runs against the machine
// (PATH, ~/.claude), never against whichever repo happens to be the working directory.
const RUBRIC_CLAUDE_MD_USER = [
  'User-level CLAUDE.md criteria (global instructions, loaded in every session of every project):',
  '- Universality: every rule must hold on any project. Flag rules referencing one specific repo, stack, tool chain, or project path — they belong in that project\'s CLAUDE.md (kind: demote).',
  '- Machine verification only: check that tools the file names exist on PATH (command -v / which / where) and that files, skills, or agents it references exist under ~/.claude. NEVER verify against the working directory\'s repository — it is an arbitrary project and proves nothing about a global rule.',
  '- Self-consistency: flag sections, tags, or mnemonics that contradict or duplicate each other within the file and its imports.',
  '- Executability: flag standards name-dropped without concrete behaviors ("follow style guide X") and rules the model cannot act on — require the 2-3 specific behaviors the user actually wants.',
  '- Flag emphasis inflation (all-caps, NEVER/ALWAYS without stakes) and vague or no-op rules the model cannot act on.',
  '- Preferences should carry their why: a bare prohibition gets overridden when inconvenient; a one-clause reason makes it generalize.',
].join('\n');

function buildAnalyzePrompt(memSources, skillSources, agentSources, claudeMdSources, userSrc, userAudited) {
  const fullSkills = skillSources || [];
  const fullAgent = agentSources || [];
  const fullClaudeMd = claudeMdSources || [];
  const audited = [];
  if (memSources.length) audited.push('the persistent auto-memory files (an index MEMORY.md plus topic files)');
  if (fullSkills.length) audited.push('project skills (SKILL.md files)');
  if (fullAgent.length) audited.push('agent memory files');
  if (fullClaudeMd.length) audited.push('CLAUDE.md instruction files');
  if (userAudited) audited.push('the user-level (global) CLAUDE.md');
  const crossScope = userAudited && fullClaudeMd.length;
  const parts = [
    `You are auditing what shapes Claude Code behavior in this project: ${audited.join(', ')}. Find real problems; an empty findings list is a valid answer. Do not pad.`,
    '',
    'Finding kinds:',
    '- duplicate: files that say the same thing in different words (memory vs memory, memory vs skill, skill vs skill).',
    '- contradiction: files that give conflicting guidance.',
    '- promote: a memory stating a general preference (not specific to this project) that belongs in the global CLAUDE.md. Skip it if the global CLAUDE.md already covers it.',
    '- merge: several small files on one theme that would be clearer as one.',
    '- stale: content that is outdated — verified against the repo when checkable, or judged from its own text otherwise.',
    '- invalidate: a rule or memory that verification shows no longer applies at all (the thing it guards against is gone, the file/tool it references was removed, the convention is now enforced elsewhere) — suggest deleting it.',
    '- quality: content that is vague, missing its why, or unlikely to change agent behavior — reported by the reviewers against their rubrics.',
  ];
  if (crossScope) {
    parts.push(
      '- override: a project rule that contradicts a user-level rule. This is often intentional (a project legitimately specializes global preferences) — suggest making the override explicit ("overrides global X because Y"), not deleting either side.',
      '- shadow: a project rule that restates a user-level rule near-verbatim; the project copy is the deletion candidate.',
    );
  }
  if (userAudited) {
    parts.push('- demote: a user-level rule that is specific to one project or stack and belongs in that project\'s CLAUDE.md — the inverse of promote.');
  }
  parts.push(
    '',
    'Rules:',
    `- You are the orchestrator; do not review files yourself. Your working directory is the project root. For every audited file, launch the type-matched reviewer subagent via your Agent tool — "memory-reviewer" for memory and agent-memory files, "skill-reviewer" for skills, "claude-md-reviewer" for project CLAUDE.md files${userAudited ? ', "claude-md-user-reviewer" for the user-level CLAUDE.md' : ''} — all in a single parallel batch of blocking calls (never background/async agents — you must hold your final report until every reviewer has returned). Pass each one only the file name and its full content; the reviewers carry their own criteria and verify claims against the repo${userAudited ? ' (the user-level reviewer verifies against the machine, never the repo)' : ''}.`,
    `- Your own job: merge the reviewers' per-file findings and add the cross-file kinds (duplicate, contradiction, merge, promote${crossScope ? ', override, shadow' : ''}) by comparing the files side by side.`,
    '- Verification is a filter: drop any finding a reviewer\'s claim checks disproved, and never report "likely outdated" for a claim a reviewer confirmed still HOLDS. Record what was checked in the finding\'s "evidence" field (one sentence, internal bookkeeping — it is not shown to the user). Omit "evidence" for judgment-only findings.',
    '- files: the exact file names involved as listed below (e.g. feedback_foo.md, MEMORY.md, or a skill name like my-skill). Bare names only — never append scope markers like "(user)"; scope is carried by the scope field.',
    '- scope: "user" if the finding only cites the user-level CLAUDE.md (demote findings are always "user"); "cross" if it cites both the user-level file and any project-side file (override, shadow, and promote findings are "cross"); "project" for everything else.',
    '- suggestion: one actionable sentence (what to merge, delete, rewrite, or promote).',
    '- severity: high = actively harmful (contradictions, wrong guidance), med = wasted context or confusion, low = polish.',
    '- summary: 1-2 sentences on the overall health of this set.',
    // The Sonnet orchestrator has been observed serializing findings as XML-ish text
    // inside "summary" (failing schema validation), then "probing" with placeholder
    // payloads until one passed — losing the real report. Spell the output contract out.
    '- Final structured output: every finding goes as an object in the top-level "findings" array; "summary" is a short plain string. Never embed findings inside the summary text, never use XML-style tags in any field, and never submit placeholder or probe output (e.g. "Test", or a truncated findings list) just to pass validation. If your output is rejected for a schema mismatch, resubmit the SAME complete set of findings as valid JSON matching the schema — do not shrink, drop, or simplify it.',
    '',
  );
  if (userAudited) {
    parts.push('USER CLAUDE.MD (audit this with claude-md-user-reviewer):', `=== FILE (user): ${userSrc.name} ===`, userSrc.content, '');
  } else {
    parts.push('GLOBAL CLAUDE.md (reference only, do not audit it):', '<<<', userSrc?.content || '(none)', '>>>', '');
  }
  if (memSources.length) {
    parts.push('MEMORY FILES:');
    for (const s of memSources) {
      parts.push(`=== FILE: ${s.name} ===`, s.content, '');
    }
  }
  if (fullSkills.length) {
    parts.push('PROJECT SKILLS (audit these):');
    for (const s of fullSkills) {
      parts.push(`=== SKILL: ${s.name} ===`, s.content, '');
    }
  }
  if (fullAgent.length) {
    parts.push('AGENT MEMORY FILES (audit these):');
    for (const s of fullAgent) {
      parts.push(`=== FILE (agent ${s.agentName || '?'}): ${s.name} ===`, s.content, '');
    }
  }
  if (fullClaudeMd.length) {
    parts.push('CLAUDE.MD FILES (audit these):');
    for (const s of fullClaudeMd) {
      parts.push(`=== FILE (${s.scope}): ${s.name} ===`, s.content, '');
    }
  }
  return parts.join('\n');
}

const ANALYSIS_MODELS = new Set(['sonnet', 'opus', 'fable']);

// Custom subagents for the per-file review fan-out (`claude --agents`). Each source
// type gets its own reviewer whose rubric and verification instructions live in the
// agent's system prompt — the parent orchestrator only passes file name + content.
const REVIEWER_COMMON = [
  'You review exactly one file that shapes Claude Code behavior; the parent passes its name and full content.',
  'Verify before judging: for every claim that references the repository in your working directory — a file, directory, command, script, flag, or path — check whether it still holds with your read-only tools. For tools the file expects on the machine, check existence with `command -v` / `which` / `where` (the only Bash commands you may run). Never call something "likely stale" when you can check it.',
  'Also judge whether the content is still needed at all: if the thing it guards against is gone (the tool was removed, the convention is enforced elsewhere, the referenced file no longer exists), say so explicitly.',
  'A check you could not run is not evidence of absence. If a probe is denied by permissions or errors out, report that claim as UNCHECKED and say why — never turn a failed check into a stale or invalidate finding.',
];

// The user reviewer swaps repo verification for machine verification — the working
// directory is an arbitrary project and must not influence a global-file audit.
const REVIEWER_COMMON_USER = [
  'You review the user-level (global) CLAUDE.md that loads in every session of every project; the parent passes its name and full content.',
  'Verify before judging, against the machine only: check tools the file names with `command -v` / `which` / `where` (the only Bash commands you may run), and check files, skills, or agents it references under ~/.claude with your read tools. NEVER read or judge against the repository in your working directory — it is one arbitrary project and proves nothing about a global rule.',
  'Also judge whether the content is still needed at all: if the tool it references is gone from the machine or the file it points to no longer exists, say so explicitly.',
  'A check you could not run is not evidence of absence. If a probe is denied by permissions or errors out, report that claim as UNCHECKED and say why — never turn a failed check into a stale or invalidate finding.',
];

const REVIEWER_REPORT = [
  'Report back compactly, nothing else:',
  '1. CLAIMS: each checkable claim — HOLDS / FAILS / UNCHECKED, with one line of evidence (what you looked at).',
  '2. FINDINGS: candidate findings for this file only (kind: stale, invalidate, or quality; severity high/med/low; title; detail; one-sentence fix). An empty list is a valid answer — do not pad.',
];

function reviewerAgent(description, rubric, common = REVIEWER_COMMON) {
  return {
    description,
    prompt: [common.join('\n'), RUBRIC_CORE, rubric, REVIEWER_REPORT.join('\n')].join('\n\n'),
    // Bash is permission-scoped to command -v / which / where by the spawn's
    // --allowedTools — anything else the reviewer tries is auto-denied in -p mode.
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  };
}

const ANALYSIS_AGENTS = {
  'memory-reviewer': reviewerAgent(
    'Reviews and verifies one auto-memory or agent-memory file against the memory rubric and the repository. One per file, in parallel.',
    RUBRIC_MEMORY,
  ),
  'skill-reviewer': reviewerAgent(
    'Reviews and verifies one SKILL.md file against the skill rubric and the repository. One per skill, in parallel.',
    RUBRIC_SKILL,
  ),
  'claude-md-reviewer': reviewerAgent(
    'Reviews and verifies one CLAUDE.md instruction file against the CLAUDE.md rubric and the repository. One per file, in parallel.',
    RUBRIC_CLAUDE_MD,
  ),
  'claude-md-user-reviewer': reviewerAgent(
    'Reviews and verifies the user-level (global) CLAUDE.md against the user rubric, PATH, and ~/.claude — never against the working repository.',
    RUBRIC_CLAUDE_MD_USER,
    REVIEWER_COMMON_USER,
  ),
};

// Tool-existence checks are the only Bash the reviewers get; everything else
// stays auto-denied by headless mode's default permissions.
const ANALYSIS_ALLOWED_TOOLS = ['Bash(command -v:*)', 'Bash(which:*)', 'Bash(where:*)'];

function runClaudeAnalysis(prompt, model, cwd) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(ANALYSIS_SCHEMA)];
    args.push('--agents', JSON.stringify(ANALYSIS_AGENTS));
    args.push('--allowedTools', ...ANALYSIS_ALLOWED_TOOLS);
    if (model) args.push('--model', model);
    let child;
    try {
      // cwd = the project root so the agent can verify claims against the actual
      // files with its read-only tools (Read/Glob/Grep need no permission grants).
      child = spawn('claude', args, { cwd: cwd || os.tmpdir(), windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: `Failed to spawn claude: ${e.message}` });
    }
    let out = '';
    let err = '';
    let done = false;
    // No timeout: a long run is never killed — it runs until claude exits on its
    // own. Past PENDING_STALL_MS the UI just shows it as stalled instead of spinning.
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `claude not found — is Claude Code installed? (${e.message})` }));
    child.on('close', () => {
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) return finish({ ok: false, error: String(envelope.result || 'Claude Code reported an error') });
        // A run can exit clean without structured_output (schema retries exhausted,
        // truncated stdout). Spreading that absence downstream yields an empty
        // findings list, which the UI cannot tell apart from a genuine all-clear —
        // so treat a missing payload as a failure rather than as "no problems".
        const data = envelope.structured_output;
        if (!data || !Array.isArray(data.findings)) {
          return finish({ ok: false, error: 'Claude Code returned no structured output — the audit did not complete, so no result is being shown.' });
        }
        finish({ ok: true, data, costUsd: envelope.total_cost_usd, durationMs: envelope.duration_ms });
      } catch {
        finish({ ok: false, error: `Claude Code returned an invalid JSON envelope${err ? `: ${err.slice(0, 300)}` : ''}` });
      }
    });
    child.stdin.end(prompt);
  });
}

const CLAUDE_MD_SCOPES = new Set(['project', 'local']);

// Everything the analyzer can audit: auto memory, top-level skills, agent memory, CLAUDE.md files.
function analyzableSources(stack) {
  return stack.filter(
    (s) =>
      s.scope === 'memory' ||
      s.scope === 'agent-memory' ||
      ((s.scope === 'skill' || s.scope === 'user' || CLAUDE_MD_SCOPES.has(s.scope)) && !s.parentId),
  );
}

// Resolve the analysis scope: explicit ids from the picker, or the default set
// (auto memory only — skills, agent memory, and CLAUDE.md files are opt-in).
function selectAnalysisSources(stack, ids) {
  const all = analyzableSources(stack);
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids);
    return all.filter((s) => wanted.has(s.id));
  }
  return all.filter((s) => s.scope === 'memory');
}

function scopeDescription(selected) {
  const parts = [];
  const n = (pred) => selected.filter(pred).length;
  const mem = n((s) => s.scope === 'memory');
  const skl = n((s) => s.scope === 'skill');
  const agt = n((s) => s.scope === 'agent-memory');
  const cmd = n((s) => CLAUDE_MD_SCOPES.has(s.scope));
  const usr = n((s) => s.scope === 'user');
  if (mem) parts.push(`${mem} memory`);
  if (skl) parts.push(`${skl} skill${skl === 1 ? '' : 's'}`);
  if (agt) parts.push(`${agt} agent`);
  if (cmd) parts.push(`${cmd} CLAUDE.md`);
  if (usr) parts.push('user CLAUDE.md');
  return parts.join(' + ');
}

app.get('/api/memory/analysis', (_req, res) => {
  const st = getAnalysisState(currentProjectPath);
  const running = st.pending.some((p) => !p.stalled);
  // The shared user-scope entry rides along on every project's payload; its
  // staleness tracks the user CLAUDE.md itself, independent of the project.
  const us = getAnalysisState(USER_SCOPE);
  // Staleness needs a full stack scan + content hash — skip it while a run is in
  // flight (the client polls every 2.5s and stale is meaningless mid-run anyway).
  let stale = false;
  let userStale = false;
  if (!running && (st.result || us.result)) {
    const stack = getStack();
    if (st.result) {
      const selected = selectAnalysisSources(stack, st.ids);
      const hash = selected.length ? memoryContentHash(selected) : null;
      stale = st.hash !== hash;
    }
    if (us.result) {
      const userSrc = stack.find((s) => s.id === 'user-claude-md');
      userStale = us.hash !== (userSrc ? memoryContentHash([userSrc]) : null);
    }
  }
  res.json({
    pending: st.pending,
    result: st.result,
    error: st.error,
    ts: st.ts,
    stale,
    project: currentProjectPath,
    runs: st.runs || [],
    dismissed: st.dismissed || [],
    user: { result: us.result, ts: us.ts, stale: userStale, runs: us.runs || [], dismissed: us.dismissed || [] },
  });
});

// scope:'user' targets the shared user-scope entry, so the action holds across
// projects; anything else targets the current project's entry.
function analysisTarget(req) {
  return req.body?.scope === 'user' ? USER_SCOPE : currentProjectPath;
}

app.post('/api/memory/analysis/delete-run', (req, res) => {
  const target = analysisTarget(req);
  const st = getAnalysisState(target);
  const ts = req.body?.ts;
  const runs = (st.runs || []).filter((run) => run.ts !== ts);
  if (runs.length === (st.runs || []).length) return res.status(404).json({ error: 'run not found' });
  saveAnalysisState(target, { ...st, error: null, runs });
  res.json({ ok: true, runs: runs.length });
});

// Dismissals persist per project so they survive reloads and re-runs.
// Body: {key} adds, {all:true} clears.
app.post('/api/memory/analysis/dismiss', (req, res) => {
  const target = analysisTarget(req);
  const st = getAnalysisState(target);
  const set = new Set(st.dismissed || []);
  if (req.body?.all) set.clear();
  else {
    const key = req.body?.key;
    if (typeof key !== 'string' || !key) return res.status(400).json({ error: 'key required' });
    set.add(key);
  }
  saveAnalysisState(target, { ...st, dismissed: [...set] });
  res.json({ ok: true, dismissed: [...set] });
});

app.post('/api/memory/analyze', (req, res) => {
  const prev = getAnalysisState(currentProjectPath);
  const stack = getStack();
  const ids = req.body?.ids;
  const selected = selectAnalysisSources(stack, ids);
  if (!selected.length) return res.status(404).json({ error: 'nothing to analyze for this scope' });
  const hash = memoryContentHash(selected);
  // The user CLAUDE.md is audited when picked; otherwise it stays reference
  // context for the 'promote' kind.
  const userSelected = selected.find((s) => s.scope === 'user');
  // A user-only run's result lives in the shared user-scope entry, so that is
  // where its cache hit must be checked.
  const userOnly = !!userSelected && selected.length === 1;
  const cacheEntry = userOnly ? getAnalysisState(USER_SCOPE) : prev;
  if (!req.body?.force && cacheEntry.result && cacheEntry.hash === hash) {
    return res.json({ cached: true });
  }
  const memSources = selected.filter((s) => s.scope === 'memory');
  const skills = selected.filter((s) => s.scope === 'skill');
  const agentSources = selected.filter((s) => s.scope === 'agent-memory');
  const claudeMdSources = selected.filter((s) => CLAUDE_MD_SCOPES.has(s.scope));
  const userSrc = userSelected || stack.find((s) => s.id === 'user-claude-md');
  const prompt = buildAnalyzePrompt(memSources, skills, agentSources, claudeMdSources, userSrc, !!userSelected);
  const stateIds = Array.isArray(ids) && ids.length ? ids : null;
  const model = ANALYSIS_MODELS.has(req.body?.model) ? req.body.model : null;
  // Capture the project now — the user may switch projects while the run is in flight,
  // and the result must land under the project it was computed for.
  const project = currentProjectPath;
  const runId = crypto.randomUUID();
  const scopeDesc = scopeDescription(selected);
  saveAnalysisState(project, {
    ...prev,
    // Starting a fresh run retires stalled leftovers — the user has moved on.
    pending: [...prev.pending.filter((p) => !p.stalled), { id: runId, startedAt: Date.now(), model, scopeDesc }],
  });
  const userHash = userSelected ? memoryContentHash([userSelected]) : null;
  // Snapshot the audited files into the run — the stack changes over time, so
  // historical runs must not re-derive their scope from the live stack. The user
  // file is owned by the user-scope entry's snapshot, not the project's.
  // Snapshotting up front also keeps `selected` (full file contents) out of the
  // completion closure, which can live for hours on a run that never returns.
  const audited = selected.filter((s) => s.scope !== 'user').map((s) => ({ id: s.id, name: s.name, scope: s.scope, lines: s.lines }));
  const userAudited = userSelected ? [{ id: userSelected.id, name: userSelected.name, scope: 'user', lines: userSelected.lines }] : null;
  const userId = userSelected?.id || null;
  // Prepend a run to an entry's history, newest first, capped.
  const withRun = (cur, run) => [run, ...(cur.runs || [])].slice(0, MAX_ANALYSIS_RUNS);
  runClaudeAnalysis(prompt, model, userOnly ? os.homedir() : project).then((r) => {
    const ts = Date.now();
    let result = r.ok ? { ...r.data, costUsd: r.costUsd, durationMs: r.durationMs, scopeDesc, model } : null;
    if (result) {
      // Reviewers sometimes copy the prompt's scope marker into file names
      // ("CLAUDE.md (user)") — canonicalize before persisting so no consumer sees it.
      const findings = (result.findings || []).map((f) => ({ ...f, files: (f.files || []).map((n) => n.replace(/\s*\((user|project|local)\)$/, '')) }));
      result = { ...result, findings };
    }
    // Findings about the user CLAUDE.md alone are shared across projects: split them
    // into the user-scope entry; project and cross findings stay with the project.
    if (result && userId) {
      const all = result.findings;
      const uCur = getAnalysisState(USER_SCOPE);
      const uRun = {
        result: { ...result, findings: all.filter((f) => f.scope === 'user'), scopeDesc: 'user CLAUDE.md' },
        ts,
        hash: userHash,
        ids: [userId],
        audited: userAudited,
      };
      saveAnalysisState(USER_SCOPE, { ...uCur, runs: withRun(uCur, uRun) });
      result = { ...result, findings: all.filter((f) => f.scope !== 'user') };
    }
    // Re-read from disk — parallel runs or another instance may have finished meanwhile.
    const cur = getAnalysisState(project);
    const runs = result && !userOnly ? withRun(cur, { result, ts, hash, ids: stateIds, audited }) : cur.runs || [];
    saveAnalysisState(project, {
      ...cur,
      pending: cur.pending.filter((p) => p.id !== runId),
      error: r.ok ? null : r.error,
      runs,
    });
  });
  res.status(202).json({ ok: true });
});

// #endregion ANALYZER

app.post('/api/open-in-editor', (req, res) => {
  try {
    openInEditor([assertOpenTarget(expandHome(req.body.path))]);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// A skill's name + description ride the system prompt every session (unless model
// invocation is disabled) — that is its standing cost, not the on-demand body.
function skillDescMeta(source) {
  const fm = source.frontmatter || {};
  if (fm['disable-model-invocation'] === 'true') return null;
  const desc = typeof fm.description === 'string' ? fm.description : '';
  return { chars: (source.skillName || source.name || '').length + desc.trim().length };
}

app.get('/api/summary', (_req, res) => {
  // Skill bodies load on invocation and markdown-linked docs load only when Claude
  // follows the link — neither is part of the memory footprint, only hard @imports are.
  const stack = getStack();
  // Memory topic files load on demand like skill bodies — only the startup MEMORY.md
  // index is standing cost, so ondemand memory-scope files stay out of the footprint.
  // Nested CLAUDE.md files (load:'tree') load progressively when Claude works in their
  // directory, so they and their import chains are not standing cost either.
  const treeIds = new Set(stack.filter(s => s.load === 'tree').map(s => s.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of stack) {
      if (s.parentId && treeIds.has(s.parentId) && !treeIds.has(s.id)) { treeIds.add(s.id); grew = true; }
    }
  }
  const sources = stack.filter(s => s.scope !== 'skill' && s.load !== 'link' && !treeIds.has(s.id)
    && !((s.scope === 'memory' || s.scope === 'agent-memory') && s.load === 'ondemand'));
  const totalFiles = sources.length;
  const totalLines = sources.reduce((s, f) => s + (f.lines || 0), 0);
  const totalBytes = sources.reduce((s, f) => s + (f.bytes || 0), 0);
  const alwaysLoaded = sources.filter(s => s.load === 'always' || s.load === 'startup').length;
  const conditional = sources.filter(s => s.load === 'conditional').length;
  const onDemand = sources.filter(s => s.load === 'ondemand').length;
  const skillDescs = stack.filter(s => s.scope === 'skill').map(skillDescMeta).filter(Boolean);
  const skillDesc = { count: skillDescs.length, chars: skillDescs.reduce((s, d) => s + d.chars, 0) };
  // Per-scope char totals so the client budget bar shares this exact footprint filter
  const scopeChars = {};
  for (const f of sources) scopeChars[f.scope] = (scopeChars[f.scope] || 0) + (f.chars || 0);
  const totalChars = sources.reduce((s, f) => s + (f.chars || 0), 0) + skillDesc.chars;
  // ids: which sources make up the footprint, so the client can highlight them
  res.json({ totalFiles, totalLines, totalBytes, totalChars, scopeChars, skillDesc, alwaysLoaded, conditional, onDemand, ids: sources.map(s => s.id) });
});

app.get('/api/stack', (_req, res) => {
  const sources = getStack();
  res.json(sources.map(stripContent));
});

app.get('/api/memory', (_req, res) => {
  const sources = getStack().filter(s => s.scope === 'memory');
  res.json(sources.map(stripContent));
});

app.get('/api/rules', (_req, res) => {
  const sources = getStack().filter(s => s.scope === 'rule');
  res.json(sources.map(stripContent));
});

app.get('/api/rules/match', (req, res) => {
  const filePath = req.query.file;
  if (!filePath) return res.status(400).json({ error: 'file query param required' });
  const rules = getStack().filter(s => s.scope === 'rule');
  const matched = rules.filter(r => {
    if (!r.frontmatter || !r.frontmatter.paths) return true;
    const patterns = Array.isArray(r.frontmatter.paths) ? r.frontmatter.paths : [r.frontmatter.paths];
    return micromatch.isMatch(filePath, patterns);
  });
  res.json(matched.map(stripContent));
});

app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  const sources = getStack();
  const source = sources.find(s => s.path === filePath);
  if (source) return res.json(source);
  const info = fileInfo(filePath);
  if (!info) return res.status(404).json({ error: 'file not found' });
  res.json({ ...info, imports: resolveExistingImports(filePath, info.content) });
});

app.get('/api/imports', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  const maxDepth = 5;
  const chain = [];
  const visited = new Set();

  function walk(fp, depth) {
    if (depth > maxDepth || visited.has(fp)) return;
    visited.add(fp);
    const info = fileInfo(fp);
    if (!info) { chain.push({ path: fp, error: 'not found' }); return; }
    const imports = parseImports(info.content);
    const node = { path: fp, lines: info.lines, bytes: info.bytes, imports: [] };
    chain.push(node);
    for (const imp of imports) {
      const resolved = resolveImport(imp, fp);
      node.imports.push(resolved);
      walk(resolved, depth + 1);
    }
  }

  walk(filePath, 0);
  res.json(chain);
});

// #endregion EXPRESS

// #region STARTUP

const onReady = (port) => {
  console.log(`Memory Diagnoser running at http://localhost:${port}`);
  console.log(`Project: ${currentProjectPath}`);
  const warning = net.exposureWarning();
  if (warning) console.log(warning);
  if (AUTO_OPEN) {
    import('open').then(m => m.default(`http://localhost:${port}`)).catch(() => {});
  }
};

const server = net.listenLoopback(app, PORT, onReady);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} busy, trying random port...`);
    net.listenLoopback(app, 0, onReady);
  }
});

// #endregion STARTUP
