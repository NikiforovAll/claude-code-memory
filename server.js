#!/usr/bin/env node
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

// #region CLI_ARGS

function getArg(name) {
  const eqIdx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return null;
  const arg = process.argv[eqIdx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[eqIdx + 1] || null;
}

const PORT = getArg('port') || process.env.PORT || 3459;
const AUTO_OPEN = process.argv.includes('--open');
const claudeDirArg = getArg('dir');
const CLAUDE_DIR = claudeDirArg
  ? claudeDirArg.replace(/^~/, os.homedir())
  : path.join(os.homedir(), '.claude');
const projectDirArg = getArg('project');

// #endregion CLI_ARGS

// #region STATE

let currentProjectPath = projectDirArg
  ? path.resolve(projectDirArg.replace(/^~/, os.homedir()))
  : process.cwd();

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
    const frontmatter = parseFrontmatter(content);
    return { path: filePath, content, lines, bytes, frontmatter };
  } catch {
    return null;
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (kv) {
      const val = kv[2].trim();
      if (!val) {
        fm[kv[1]] = [];
      } else if (val.startsWith('[') || val.startsWith('"')) {
        try { fm[kv[1]] = JSON.parse(val.replace(/'/g, '"')); } catch { fm[kv[1]] = val; }
      } else {
        fm[kv[1]] = val;
      }
    }
    const arrItem = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
    if (arrItem) {
      const lastKey = Object.keys(fm).pop();
      if (lastKey && !Array.isArray(fm[lastKey])) fm[lastKey] = [];
      if (lastKey) fm[lastKey].push(arrItem[1]);
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
    resolved = resolved.replace(/^~/, os.homedir());
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
        load: 'conditional',
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
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const filePath = path.join(dir, name);
      if (seenPaths.has(filePath)) continue;
      const info = fileInfo(filePath);
      if (!info) continue;
      seenPaths.add(filePath);
      const isProjectRoot = path.resolve(dir) === path.resolve(projectPath);
      sources.push({
        id: `project-claude-md-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`,
        name: name.includes('/') ? '.claude/CLAUDE.md' : 'CLAUDE.md',
        scope: 'project',
        load: 'always',
        ...info,
        dir,
        isProjectRoot,
        ...spreadImports(info.path, info.content),
      });
      break;
    }

    const localPath = path.join(dir, 'CLAUDE.local.md');
    if (seenPaths.has(localPath)) continue;
    const localInfo = fileInfo(localPath);
    if (localInfo) {
      seenPaths.add(localPath);
      sources.push({
        id: `local-claude-md-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`,
        name: 'CLAUDE.local.md',
        scope: 'project',
        load: 'always',
        ...localInfo,
        dir,
        ...spreadImports(localInfo.path, localInfo.content),
      });
    }
  }

  // 4b. Scan subdirectories of projectPath for CLAUDE.md (tree-scoped)
  const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv']);
  function walkForClaudeMd(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const subdir = path.join(dir, entry.name);
      for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
        const filePath = path.join(subdir, name);
        if (seenPaths.has(filePath)) continue;
        const info = fileInfo(filePath);
        if (!info) continue;
        seenPaths.add(filePath);
        const rel = path.relative(projectPath, subdir).replace(/\\/g, '/');
        sources.push({
          id: `project-claude-md-${subdir.replace(/[^a-zA-Z0-9]/g, '-')}`,
          name: `${rel}/${name.includes('/') ? '.claude/CLAUDE.md' : 'CLAUDE.md'}`,
          scope: 'project',
          load: 'tree',
          ...info,
          dir: subdir,
          isProjectRoot: false,
          ...spreadImports(info.path, info.content),
        });
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
        load: 'conditional',
        ...info,
        ruleSource: 'project',
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 6. Auto memory
  const memoryDir = findMemoryDir(projectPath);
  if (memoryDir && fs.existsSync(memoryDir)) {
    const memoryMd = path.join(memoryDir, 'MEMORY.md');
    const memInfo = fileInfo(memoryMd);
    if (memInfo) {
      sources.push({
        id: 'memory-index',
        name: 'MEMORY.md',
        scope: 'memory',
        load: 'startup',
        ...memInfo,
        maxLines: 200,
        maxBytes: 25 * 1024,
        ...spreadImports(memInfo.path, memInfo.content),
      });
    }
    for (const file of findMdFiles(memoryDir)) {
      if (path.basename(file) === 'MEMORY.md') continue;
      const info = fileInfo(file);
      if (!info) continue;
      sources.push({
        id: `memory-${path.basename(file, '.md')}`,
        name: path.basename(file),
        scope: 'memory',
        load: 'ondemand',
        ...info,
        ...spreadImports(info.path, info.content),
      });
    }
  }

  // 7. User-level memory (~/.claude/memory/)
  const userMemoryDir = path.join(os.homedir(), '.claude', 'memory');
  if (fs.existsSync(userMemoryDir)) {
    const userMemoryMd = path.join(userMemoryDir, 'MEMORY.md');
    const userMemInfo = fileInfo(userMemoryMd);
    if (userMemInfo) {
      sources.push({
        id: 'user-memory-index',
        name: 'MEMORY.md',
        scope: 'user-memory',
        load: 'startup',
        ...userMemInfo,
        maxLines: 200,
        maxBytes: 25 * 1024,
        ...spreadImports(userMemInfo.path, userMemInfo.content),
      });
    }
    for (const file of findMdFiles(userMemoryDir)) {
      if (path.basename(file) === 'MEMORY.md') continue;
      const info = fileInfo(file);
      if (!info) continue;
      sources.push({
        id: `user-memory-${path.basename(file, '.md')}`,
        name: path.basename(file),
        scope: 'user-memory',
        load: 'ondemand',
        ...info,
        ...spreadImports(info.path, info.content),
      });
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
        if (existing && !existing.parentId && existing.scope === 'memory') {
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
        id: `import-${path.basename(imp, '.md')}-${depth}`,
        name: path.basename(imp),
        scope: parent.scope,
        load: 'import',
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

function findMdFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
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
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const encoded = encodeProjectPath(projectPath);
  const memDir = path.join(projectsDir, encoded, 'memory');
  if (fs.existsSync(memDir)) return memDir;
  return findMemoryDirBySubstring(projectPath);
}

function encodeProjectPath(projectPath) {
  // Claude Code uses double-dash encoding: C--Users-nikiforovall-dev-foo
  return projectPath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1')  // strip colon but keep drive letter
    .replace(/\//g, '-');           // slashes become single dash; drive letter boundary becomes double dash naturally
}

function findMemoryDirBySubstring(projectPath) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/hub-config', (_req, res) => {
  res.json({
    name: 'Claude Code Memory',
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
  const resolved = path.resolve(dirPath.replace(/^~/, os.homedir()));
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'directory not found' });
  currentProjectPath = resolved;
  clearCache();
  res.json({ path: currentProjectPath, name: path.basename(currentProjectPath) });
});

app.post('/api/refresh', (_req, res) => {
  clearCache();
  res.json({ ok: true });
});

app.post('/api/open-in-editor', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const resolved = filePath.replace(/^~/, os.homedir());
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'file not found' });
  const { exec } = require('child_process');
  exec(`code "${resolved}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/summary', (_req, res) => {
  const sources = getStack();
  const totalFiles = sources.length;
  const totalLines = sources.reduce((s, f) => s + (f.lines || 0), 0);
  const totalBytes = sources.reduce((s, f) => s + (f.bytes || 0), 0);
  const alwaysLoaded = sources.filter(s => s.load === 'always' || s.load === 'startup').length;
  const conditional = sources.filter(s => s.load === 'conditional').length;
  const onDemand = sources.filter(s => s.load === 'ondemand').length;
  res.json({ totalFiles, totalLines, totalBytes, alwaysLoaded, conditional, onDemand });
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

const server = app.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port : PORT;
  console.log(`Claude Code Memory running at http://localhost:${port}`);
  console.log(`Project: ${currentProjectPath}`);
  if (AUTO_OPEN) {
    import('open').then(m => m.default(`http://localhost:${port}`)).catch(() => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} busy, trying random port...`);
    const retry = app.listen(0, () => {
      const addr = retry.address();
      const port = typeof addr === 'object' ? addr.port : '?';
      console.log(`Claude Code Memory running at http://localhost:${port}`);
      if (AUTO_OPEN) {
        import('open').then(m => m.default(`http://localhost:${port}`)).catch(() => {});
      }
    });
  }
});

// #endregion STARTUP
