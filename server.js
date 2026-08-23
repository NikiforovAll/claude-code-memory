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
          kind: { type: 'string', enum: ['duplicate', 'contradiction', 'promote', 'merge', 'stale', 'invalidate', 'quality'] },
          severity: { type: 'string', enum: ['high', 'med', 'low'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          suggestion: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['kind', 'severity', 'title', 'detail', 'files', 'suggestion'],
      },
    },
  },
  required: ['summary', 'findings'],
};

// Generous: the run fans out one verification subagent per audited file.
const ANALYZE_TIMEOUT_MS = 600_000;

// Analysis results keyed by project path — switching projects keeps each project's
// last result. Completed runs are persisted to disk so they survive server restarts.
const ANALYSIS_STORE = path.join(CLAUDE_DIR, 'claude-code-memory-analysis.json');
const analysisStates = new Map();

const EMPTY_ANALYSIS = { running: false, result: null, error: null, hash: null, ts: null, ids: null, runs: [] };
const MAX_ANALYSIS_RUNS = 10;

function hydrateAnalysisEntry(st) {
  const loaded = { ...EMPTY_ANALYSIS, ...st, running: false };
  // Migrate pre-runs entries: the stored latest result becomes the first history run.
  if (loaded.result && !(loaded.runs || []).length)
    loaded.runs = [{ result: loaded.result, ts: loaded.ts, hash: loaded.hash, ids: loaded.ids }];
  return loaded;
}

let analysisStoreCache = null; // { mtimeMs, data } — reparse only when the shared file changes
function readAnalysisStore() {
  try {
    const { mtimeMs } = fs.statSync(ANALYSIS_STORE);
    if (analysisStoreCache?.mtimeMs !== mtimeMs) {
      analysisStoreCache = { mtimeMs, data: JSON.parse(fs.readFileSync(ANALYSIS_STORE, 'utf-8')) };
    }
    return analysisStoreCache.data;
  } catch {
    return {}; // no store yet, or unreadable
  }
}

// The store file is shared between server instances (hub + standalone), so disk is
// the source of truth whenever this instance has no run in flight for the project.
function getAnalysisState(project) {
  const cur = analysisStates.get(project);
  if (cur?.running) return cur;
  const st = readAnalysisStore()[project];
  if (!st) {
    analysisStates.delete(project);
    return EMPTY_ANALYSIS;
  }
  const loaded = hydrateAnalysisEntry(st);
  analysisStates.set(project, loaded);
  return loaded;
}

// Write only this project's entry, merged over what is on disk — a blind full
// rewrite would clobber runs another instance saved since we last read.
function saveAnalysisState(project) {
  const disk = readAnalysisStore();
  const st = analysisStates.get(project);
  if (st && (st.result || st.error || (st.runs || []).length))
    disk[project] = { result: st.result, error: st.error, hash: st.hash, ts: st.ts, ids: st.ids, runs: st.runs || [] };
  else delete disk[project];
  try {
    fs.writeFileSync(ANALYSIS_STORE, JSON.stringify(disk), 'utf-8');
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

function buildAnalyzePrompt(memSources, userClaudeMd, skillSources, agentSources, claudeMdSources) {
  const fullSkills = skillSources || [];
  const fullAgent = agentSources || [];
  const fullClaudeMd = claudeMdSources || [];
  const audited = [];
  if (memSources.length) audited.push('the persistent auto-memory files (an index MEMORY.md plus topic files)');
  if (fullSkills.length) audited.push('project skills (SKILL.md files)');
  if (fullAgent.length) audited.push('agent memory files');
  if (fullClaudeMd.length) audited.push('CLAUDE.md instruction files');
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
    '',
    'Rules:',
    '- You are the orchestrator; do not review files yourself. Your working directory is the project root. For every audited file, launch the type-matched reviewer subagent via your Agent tool — "memory-reviewer" for memory and agent-memory files, "skill-reviewer" for skills, "claude-md-reviewer" for CLAUDE.md files — all in a single parallel batch. Pass each one only the file name and its full content; the reviewers carry their own criteria and verify claims against the repo.',
    '- Your own job: merge the reviewers\' per-file findings and add the cross-file kinds (duplicate, contradiction, merge, promote) by comparing the files side by side.',
    '- Verification is a filter: drop any finding a reviewer\'s claim checks disproved, and never report "likely outdated" for a claim a reviewer confirmed still HOLDS. Record what was checked in the finding\'s "evidence" field (one sentence, internal bookkeeping — it is not shown to the user). Omit "evidence" for judgment-only findings.',
    '- files: the exact file names involved as listed below (e.g. feedback_foo.md, MEMORY.md, or a skill name like my-skill).',
    '- suggestion: one actionable sentence (what to merge, delete, rewrite, or promote).',
    '- severity: high = actively harmful (contradictions, wrong guidance), med = wasted context or confusion, low = polish.',
    '- summary: 1-2 sentences on the overall health of this set.',
    '',
    'GLOBAL CLAUDE.md (reference only, do not audit it):',
    '<<<',
    userClaudeMd || '(none)',
    '>>>',
    '',
  ];
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
  'Verify before judging: for every claim that references the repository in your working directory — a file, directory, command, script, flag, or path — check whether it still holds with your read-only tools. Never call something "likely stale" when you can check it.',
  'Also judge whether the content is still needed at all: if the thing it guards against is gone (the tool was removed, the convention is enforced elsewhere, the referenced file no longer exists), say so explicitly.',
];

const REVIEWER_REPORT = [
  'Report back compactly, nothing else:',
  '1. CLAIMS: each checkable claim — HOLDS / FAILS / UNCHECKED, with one line of evidence (what you looked at).',
  '2. FINDINGS: candidate findings for this file only (kind: stale, invalidate, or quality; severity high/med/low; title; detail; one-sentence fix). An empty list is a valid answer — do not pad.',
];

function reviewerAgent(description, rubric) {
  return {
    description,
    prompt: [REVIEWER_COMMON.join('\n'), RUBRIC_CORE, rubric, REVIEWER_REPORT.join('\n')].join('\n\n'),
    tools: ['Read', 'Grep', 'Glob'],
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
};

function runClaudeAnalysis(prompt, model, cwd) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(ANALYSIS_SCHEMA)];
    args.push('--agents', JSON.stringify(ANALYSIS_AGENTS));
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
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: 'Claude Code timed out' }); }, ANALYZE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `claude not found — is Claude Code installed? (${e.message})` }));
    child.on('close', () => {
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) return finish({ ok: false, error: String(envelope.result || 'Claude Code reported an error') });
        finish({ ok: true, data: envelope.structured_output, costUsd: envelope.total_cost_usd, durationMs: envelope.duration_ms });
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
      ((s.scope === 'skill' || CLAUDE_MD_SCOPES.has(s.scope)) && !s.parentId),
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
  if (mem) parts.push(`${mem} memory`);
  if (skl) parts.push(`${skl} skill${skl === 1 ? '' : 's'}`);
  if (agt) parts.push(`${agt} agent`);
  if (cmd) parts.push(`${cmd} CLAUDE.md`);
  return parts.join(' + ');
}

app.get('/api/memory/analysis', (_req, res) => {
  const st = getAnalysisState(currentProjectPath);
  // Staleness needs a full stack scan + content hash — skip it while a run is in
  // flight (the client polls every 2.5s and stale is meaningless mid-run anyway).
  let stale = false;
  if (!st.running && st.result) {
    const selected = selectAnalysisSources(getStack(), st.ids);
    const hash = selected.length ? memoryContentHash(selected) : null;
    stale = st.hash !== hash;
  }
  res.json({
    running: st.running,
    result: st.result,
    error: st.error,
    ts: st.ts,
    stale,
    project: currentProjectPath,
    runs: st.runs || [],
  });
});

app.post('/api/memory/analysis/delete-run', (req, res) => {
  const st = getAnalysisState(currentProjectPath);
  if (st.running) return res.status(409).json({ error: 'analysis running' });
  const ts = req.body?.ts;
  const runs = (st.runs || []).filter((run) => run.ts !== ts);
  if (runs.length === (st.runs || []).length) return res.status(404).json({ error: 'run not found' });
  const latest = runs[0] || null;
  analysisStates.set(currentProjectPath, {
    ...st,
    result: latest?.result || null,
    ts: latest?.ts || null,
    hash: latest?.hash || null,
    ids: latest ? latest.ids : null,
    error: null,
    runs,
  });
  saveAnalysisState(currentProjectPath);
  res.json({ ok: true, runs: runs.length });
});

app.post('/api/memory/analyze', (req, res) => {
  const prev = getAnalysisState(currentProjectPath);
  if (prev.running) return res.status(409).json({ error: 'analysis already running' });
  const stack = getStack();
  const ids = req.body?.ids;
  const selected = selectAnalysisSources(stack, ids);
  if (!selected.length) return res.status(404).json({ error: 'nothing to analyze for this scope' });
  const hash = memoryContentHash(selected);
  if (!req.body?.force && prev.result && prev.hash === hash) {
    return res.json({ running: false, cached: true });
  }
  const memSources = selected.filter((s) => s.scope === 'memory');
  const skills = selected.filter((s) => s.scope === 'skill');
  const agentSources = selected.filter((s) => s.scope === 'agent-memory');
  const claudeMdSources = selected.filter((s) => CLAUDE_MD_SCOPES.has(s.scope));
  // The global CLAUDE.md is reference context for the 'promote' kind (never audited itself).
  const userClaudeMd = stack.find((s) => s.id === 'user-claude-md');
  const prompt = buildAnalyzePrompt(memSources, userClaudeMd?.content, skills, agentSources, claudeMdSources);
  const stateIds = Array.isArray(ids) && ids.length ? ids : null;
  const model = ANALYSIS_MODELS.has(req.body?.model) ? req.body.model : null;
  // Capture the project now — the user may switch projects while the run is in flight,
  // and the result must land under the project it was computed for.
  const project = currentProjectPath;
  const prevRuns = prev.runs || [];
  analysisStates.set(project, { running: true, result: null, error: null, hash, ts: null, ids: stateIds, runs: prevRuns });
  runClaudeAnalysis(prompt, model, project).then((r) => {
    const ts = Date.now();
    const result = r.ok ? { ...r.data, costUsd: r.costUsd, durationMs: r.durationMs, scopeDesc: scopeDescription(selected), model } : null;
    // Another instance may have added runs while this one was in flight — merge by ts.
    const diskRuns = readAnalysisStore()[project]?.runs || [];
    const baseRuns = [...new Map([...prevRuns, ...diskRuns].map((run) => [run.ts, run])).values()].sort((a, b) => b.ts - a.ts);
    // Snapshot the audited files into the run — the stack changes over time, so
    // historical runs must not re-derive their scope from the live stack.
    const audited = selected.map((s) => ({ id: s.id, name: s.name, scope: s.scope, lines: s.lines }));
    const runs = (result ? [{ result, ts, hash, ids: stateIds, audited }, ...baseRuns] : baseRuns).slice(0, MAX_ANALYSIS_RUNS);
    analysisStates.set(project, {
      running: false,
      result,
      error: r.ok ? null : r.error,
      hash,
      ts,
      ids: stateIds,
      runs,
    });
    saveAnalysisState(project);
  });
  res.status(202).json({ running: true });
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
