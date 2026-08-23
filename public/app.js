// #region STATE

let projectData = null;
let stackData = [];
let summaryData = null;
let selectedFileId = null;
let healthViewOpen = true; // health dashboard is the default view; selecting a file exits it

// #endregion STATE

// #region UTILS

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

// For a value landing inside a quoted JS string inside an HTML attribute —
// onclick="fn('${escAttrJs(x)}')". The browser HTML-decodes the attribute before
// the JS parser sees it, so the JS escape must happen first and be escaped in turn.
function escAttrJs(value) {
  const js = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return esc(js);
}

// #endregion UTILS

// #region HIGHLIGHT

const EXT_TO_LANG = {
  md: 'markdown',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  toml: 'ini',
};

function highlightSource(text, fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const lang = EXT_TO_LANG[ext];
  if (typeof hljs === 'undefined' || !lang) return esc(text);
  try {
    if (lang === 'markdown') {
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (fm) {
        const fmHtml = hljs.highlight(fm[1], { language: 'yaml' }).value;
        const bodyHtml = hljs.highlight(fm[2], { language: 'markdown' }).value;
        return `<span class="hl-fm-block"><span class="hl-frontmatter">---</span>\n${fmHtml}\n<span class="hl-frontmatter">---</span></span>\n${bodyHtml}`;
      }
    }
    return hljs.highlight(text, { language: lang }).value;
  } catch {
    /* fallback */
  }
  return esc(text);
}

function linkifyImports(text, _sourceId) {
  if (!stackData.length) return { text, placeholders: [] };
  const byName = Object.fromEntries(stackData.map((c) => [c.name, c]));
  const placeholders = [];
  const ph = (child, display) => {
    const token = `\x00LINK${placeholders.length}\x00`;
    placeholders.push(
      `<a class="inline-import" href="#" onclick="selectFile('${escAttrJs(child.id)}');return false" title="${esc(child.path)}">${esc(display)}</a>`,
    );
    return token;
  };
  // Replace @path refs with placeholders
  text = text.replace(/@([\w./-]+\.md)\b/g, (_m, ref) => {
    const child = byName[ref.split('/').pop()];
    return child ? `@${ph(child, ref)}` : _m;
  });
  // Replace markdown [text](file.md) link targets with placeholders
  text = text.replace(/(\[[^\]]*\]\()((?!https?:\/\/)[^)]+\.md)(\))/g, (_m, pre, ref, post) => {
    const child = byName[ref.split('/').pop()];
    return child ? `${pre}${ph(child, ref)}${post}` : _m;
  });
  return { text, placeholders };
}

function restorePlaceholders(html, placeholders) {
  for (let i = 0; i < placeholders.length; i++) {
    html = html.replaceAll(`\x00LINK${i}\x00`, placeholders[i]);
  }
  return html;
}

// #endregion HIGHLIGHT

// #region THEME

const COLOR_THEMES = [
  ['ember', 'Ember'],
  ['gruvbox', 'Gruvbox'],
  ['catppuccin', 'Catppuccin'],
  ['tokyo-night', 'Tokyo Night'],
  ['solarized', 'Solarized'],
  ['dracula', 'Dracula'],
  ['nord', 'Nord'],
  ['rose-pine', 'Rosé Pine'],
  ['everforest', 'Everforest'],
  ['kanagawa', 'Kanagawa'],
  ['one-dark', 'One Dark'],
  ['night-owl', 'Night Owl'],
  ['monokai', 'Monokai Pro'],
  ['github', 'GitHub'],
  ['ayu', 'Ayu'],
  ['vitesse', 'Vitesse'],
  ['synthwave', "Synthwave '84"],
];

function loadTheme() {
  if (localStorage.getItem('theme') === 'light') document.body.classList.add('light');
  buildThemeMenu();
  const colorTheme = localStorage.getItem('color-theme');
  if (colorTheme) document.body.dataset.colorTheme = colorTheme;
  syncColorThemeMenu(colorTheme || 'ember');
  syncHljsTheme();
}

// 'ember' (the :root default) has no override block — selecting it clears the attribute.
function setColorTheme(id) {
  if (!id || id === 'ember') {
    delete document.body.dataset.colorTheme;
    localStorage.removeItem('color-theme');
  } else {
    document.body.dataset.colorTheme = id;
    localStorage.setItem('color-theme', id);
  }
  syncColorThemeMenu(id);
}

function buildThemeMenu() {
  const menu = document.getElementById('themeMenu');
  menu.innerHTML = COLOR_THEMES.map(
    ([id, label]) =>
      `<button type="button" class="theme-menu-item theme-swatch-${id}" data-theme-id="${id}"
         onclick="event.stopPropagation(); setColorTheme('${id}'); toggleThemeMenu()">
         <span class="theme-swatch theme-swatch-${id}"><i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-ink"></i></span>${label}
       </button>`,
  ).join('');
}

// biome-ignore lint/correctness/noUnusedVariables: called from topbar markup
function toggleThemeMenu(e) {
  e?.stopPropagation();
  const menu = document.getElementById('themeMenu');
  const open = menu.classList.toggle('open');
  if (open) {
    document.addEventListener('click', () => menu.classList.remove('open'), { once: true });
  }
}

function syncColorThemeMenu(id) {
  document.querySelectorAll('.theme-menu-item').forEach((el) => {
    el.classList.toggle('on', el.dataset.themeId === (id || 'ember'));
  });
}

function toggleTheme() {
  document.body.classList.toggle('light');
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark');
  syncHljsTheme();
}

function syncHljsTheme() {
  const isLight = document.body.classList.contains('light');
  const dark = document.getElementById('hljsDark');
  const light = document.getElementById('hljsLight');
  if (dark) dark.disabled = isLight;
  if (light) light.disabled = !isLight;
}

// #endregion THEME

// #region FETCH

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// #endregion FETCH

// #region PROJECT

async function loadProject() {
  projectData = await fetchJSON('/api/project');
  document.getElementById('projectName').textContent = projectData.name;
  document.getElementById('projectBtn').title = projectData.path;
}

// Shared by the project picker, the boot restore, and the hub project shim. Throws with the
// server's error message so callers can surface it directly.
async function putProject(dirPath) {
  const res = await fetch('/api/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status}`);
  }
}

function changeProject() {
  const current = document.getElementById('projectBtn').title;
  document.getElementById('projectPathInput').value = current;
  renderRecentProjects();
  document.getElementById('projectPickerModal').classList.add('open');
  setTimeout(() => document.getElementById('projectPathInput').focus(), 100);
}

async function submitProjectPicker() {
  const dirPath = document.getElementById('projectPathInput').value.trim();
  if (!dirPath) return;
  const btn = document.getElementById('projectPickerSubmit');
  btn.disabled = true;
  btn.textContent = 'Switching...';
  try {
    await putProject(dirPath);
    closeModal('projectPickerModal');
    addRecentProject(dirPath);
    await Promise.all([loadProject(), loadData()]);
    showToast('Project switched', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Switch';
  }
}

function getRecentProjects() {
  try {
    return JSON.parse(localStorage.getItem('recentProjects') || '[]');
  } catch {
    return [];
  }
}

function addRecentProject(p) {
  const recent = getRecentProjects().filter((r) => r !== p);
  recent.unshift(p);
  localStorage.setItem('recentProjects', JSON.stringify(recent.slice(0, 10)));
}

function _removeRecentProject(p, e) {
  e.stopPropagation();
  const recent = getRecentProjects().filter((r) => r !== p);
  localStorage.setItem('recentProjects', JSON.stringify(recent));
  renderRecentProjects();
}

function _selectRecentProject(p) {
  document.getElementById('projectPathInput').value = p;
}

function renderRecentProjects() {
  const container = document.getElementById('recentProjectsList');
  const recent = getRecentProjects();
  if (!recent.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML =
    '<div class="recent-projects-label">Recent</div>' +
    recent
      .map(
        (p) =>
          `<div class="recent-project-item" onclick="_selectRecentProject('${escAttrJs(p)}')">` +
          `<span>${esc(p)}</span>` +
          `<button class="recent-project-remove" onclick="_removeRecentProject('${escAttrJs(p)}', event)" title="Remove">&#10005;</button>` +
          `</div>`,
      )
      .join('');
}

// #endregion PROJECT

// #region MODAL

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function toggleHelpModal() {
  document.getElementById('helpModal').classList.toggle('open');
}

function openHealthView() {
  healthViewOpen = !healthViewOpen;
  document.getElementById('analyzeBtn')?.classList.toggle('active', healthViewOpen);
  renderPreview();
  if (healthViewOpen) refreshAnalysis();
}

function bindModalKeys(inputId, modalId, submitFn) {
  document.getElementById(inputId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitFn();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(modalId);
    }
  });
}

// #endregion MODAL

// #region RENDER_TREE

const SCOPE_ORDER = ['policy', 'user', 'project', 'rule', 'memory', 'skill', 'agent-memory'];
const SCOPE_LABELS = {
  policy: 'Managed Policy',
  user: 'User',
  project: 'Project',
  rule: 'Rules',
  skill: 'Skills',
  memory: 'Auto Memory',
  'agent-memory': 'Agent Memory',
};
const LOAD_ICONS = {
  always: '\u25CF',
  startup: '\u25D2',
  conditional: '\u25CB',
  ondemand: '\u25CC',
  tree: '\u25CE',
  import: '@',
  link: '\u2197',
};
const LOAD_TITLES = {
  always: 'Always loaded',
  startup: 'Loaded at startup (partial)',
  conditional: 'Conditional (path-scoped)',
  ondemand: 'On-demand',
  tree: 'Loaded progressively (when Claude works in its directory)',
  import: 'Imported by parent file',
  link: 'Referenced via markdown link (not auto-loaded)',
};

let treeIndex = null;

function getTreeIndex() {
  if (treeIndex) return treeIndex;
  const groups = {};
  const childrenOf = {};
  for (const s of stackData) {
    if (s.parentId) {
      if (!childrenOf[s.parentId]) childrenOf[s.parentId] = [];
      childrenOf[s.parentId].push(s);
    } else {
      if (!groups[s.scope]) groups[s.scope] = [];
      groups[s.scope].push(s);
    }
  }
  // Default-expand parents whose children are real discovered files (e.g. auto-memory
  // dirs indexed by MEMORY.md). Pure @import/link references (importedBy set) stay collapsed.
  for (const parentId in childrenOf) {
    if (childrenOf[parentId].some((c) => !c.importedBy)) expandedItems.add(parentId);
  }
  treeIndex = { groups, childrenOf };
  return treeIndex;
}

function invalidateTreeIndex() {
  treeIndex = null;
}

function renderTree() {
  const container = document.getElementById('treeContent');
  if (!stackData.length) {
    container.innerHTML =
      '<div class="loading-state" style="padding:20px;font-size:11px;color:var(--text-muted)">No memory sources found</div>';
    return;
  }

  const { groups, childrenOf } = getTreeIndex();

  function renderItem(item, indent) {
    const sel = selectedFileId === item.id ? ' selected' : '';
    const loadIcon = LOAD_ICONS[item.load] || '';
    const loadTitle = LOAD_TITLES[item.load] || item.load;
    const meta = `${item.lines}L`;
    const isConditional =
      item.load === 'conditional' || item.load === 'ondemand' || item.load === 'link' || item.load === 'tree';
    const pad = indent ? ` style="padding-left:${12 + indent * 16}px"` : '';
    const muted = item.scope === 'agent-memory' ? ' tree-agent-item' : '';
    const children = childrenOf[item.id];
    const expanded = children && isItemExpanded(item.id);
    const chevron = children
      ? `<span class="tree-chevron" onclick="_toggleItem(event,'${escAttrJs(item.id)}')" title="${children.length} referenced">${expanded ? '▾' : '▸'}</span>`
      : '<span class="tree-chevron-spacer"></span>';
    const fp = footprintHighlight && footprintHit(item) ? ' fp-hit' : '';
    let h = `<div class="tree-item${sel}${indent ? ' tree-child' : ''}${isConditional ? ' tree-conditional' : ''}${muted}${fp}" data-id="${esc(item.id)}" title="${esc(item.path)}" onclick="selectFile('${escAttrJs(item.id)}')"${pad}>`;
    h += chevron;
    h += `<span class="load-icon" title="${loadTitle}" style="color:var(--scope-${item.scope})">${loadIcon}</span>`;
    h += `<span class="file-name">${esc(item.name)}</span>`;
    const hs = treeHealth.get(item.id);
    if (hs) {
      const sev = hs.high ? 'high' : hs.med ? 'med' : 'low';
      const n = hs.high || hs.med || hs.low;
      h += `<span class="tree-health th-${esc(sev)}" title="${esc(hs.high)} high · ${esc(hs.med)} med · ${esc(hs.low)} low — open Health for details">${n}</span>`;
    } else if (auditedIds.has(item.id)) {
      h += '<span class="tree-health th-clean" title="Audited — no findings"></span>';
    }
    h += `<span class="file-meta">${meta}</span>`;
    h += '</div>';
    if (expanded) {
      for (const child of children) h += renderItem(child, (indent || 0) + 1);
    }
    return h;
  }

  let html = '';
  for (const scope of SCOPE_ORDER) {
    const items = groups[scope];
    if (!items) continue;
    const label = SCOPE_LABELS[scope] || scope;
    const collapsible = scope === 'agent-memory';
    const collapsed = collapsible && isGroupCollapsed(scope);
    const chevron = collapsible ? `<span class="group-chevron">${collapsed ? '\u25B8' : '\u25BE'}</span>` : '';
    const headerClass = collapsible ? 'tree-group-header tree-group-clickable' : 'tree-group-header';
    const onclick = collapsible ? ` onclick="_toggleGroup('${escAttrJs(scope)}')"` : '';
    html += `<div class="${headerClass}" data-scope="${esc(scope)}"${onclick}>${chevron}<span class="scope-dot" style="color:var(--scope-${scope})">\u25CF</span> ${esc(label)} <span style="opacity:0.5">${items.length}</span></div>`;
    if (collapsed) continue;
    if (scope === 'agent-memory') {
      const sorted = [...items].sort((a, b) => {
        const so = ['user', 'project', 'local'];
        return (
          so.indexOf(a.agentScope) - so.indexOf(b.agentScope) ||
          a.agentName.localeCompare(b.agentName) ||
          (a.name === 'MEMORY.md' ? -1 : 1)
        );
      });
      let lastKey = null;
      for (const item of sorted) {
        const key = `${item.agentScope}/${item.agentName}`;
        if (key !== lastKey) {
          html += `<div class="tree-subgroup-header" title="${esc(item.agentScope)} scope"><span class="agent-name">${esc(item.agentName)}</span><span class="agent-scope-tag">${esc(item.agentScope)}</span></div>`;
          lastKey = key;
        }
        html += renderItem(item, 1);
      }
    } else {
      for (const item of items) html += renderItem(item, 0);
    }
  }
  container.innerHTML = html;
}

const COLLAPSED_DEFAULTS = ['agent-memory'];
function getCollapsedGroups() {
  try {
    const stored = localStorage.getItem('collapsedGroups');
    if (stored !== null) return new Set(JSON.parse(stored));
  } catch {}
  return new Set(COLLAPSED_DEFAULTS);
}
function isGroupCollapsed(scope) {
  return getCollapsedGroups().has(scope);
}
function setGroupCollapsed(scope, collapsed) {
  const set = getCollapsedGroups();
  if (collapsed) set.add(scope);
  else set.delete(scope);
  localStorage.setItem('collapsedGroups', JSON.stringify([...set]));
}
function _toggleGroup(scope) {
  setGroupCollapsed(scope, !isGroupCollapsed(scope));
  renderTree();
}
function getItemScope(item) {
  return item?.parentId ? stackData.find((s) => s.id === item.parentId)?.scope : item?.scope;
}
function expandGroupForItem(item) {
  const scope = getItemScope(item);
  if (scope && isGroupCollapsed(scope)) setGroupCollapsed(scope, false);
}

// Referenced/child files are collapsed by default; expand on click. Only top-level
// "root" files (those not pulled in via an import/link) are shown until expanded.
const expandedItems = new Set();
function isItemExpanded(id) {
  return expandedItems.has(id);
}
function _toggleItem(event, id) {
  event.stopPropagation();
  if (expandedItems.has(id)) expandedItems.delete(id);
  else expandedItems.add(id);
  renderTree();
}
function expandItemAncestors(item) {
  let cur = item;
  while (cur?.parentId) {
    expandedItems.add(cur.parentId);
    cur = stackData.find((s) => s.id === cur.parentId);
  }
}

function pushFileState(id) {
  const url = id ? `#${encodeURIComponent(id)}` : location.pathname;
  history.pushState({ fileId: id }, '', url);
}

function selectFile(id, pushState = true) {
  if (healthViewOpen) {
    healthViewOpen = false;
    document.getElementById('analyzeBtn')?.classList.remove('active');
  }
  selectedFileId = selectedFileId === id ? null : id;
  if (selectedFileId) {
    const item = stackData.find((s) => s.id === selectedFileId);
    if (item) {
      expandGroupForItem(item);
      expandItemAncestors(item);
    }
  }
  if (pushState) pushFileState(selectedFileId);
  renderTree();
  renderPreview();
}

function scrollToSelected() {
  const el = document.querySelector(`.tree-item[data-id="${CSS.escape(selectedFileId ?? '')}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function currentItem() {
  return stackData.find((s) => s.id === selectedFileId) || null;
}

function selectNav(id) {
  selectedFileId = id;
  pushFileState(id);
  renderTree();
  renderPreview();
  scrollToSelected();
}

// Visible traversal order: collapsed subtrees and collapsed groups are skipped.
function getVisibleOrder() {
  const { groups, childrenOf } = getTreeIndex();
  const order = [];
  const walk = (item) => {
    order.push(item);
    if (isItemExpanded(item.id)) {
      const children = childrenOf[item.id];
      if (children) for (const c of children) walk(c);
    }
  };
  for (const scope of SCOPE_ORDER) {
    if (isGroupCollapsed(scope)) continue;
    const items = groups[scope];
    if (items) for (const item of items) walk(item);
  }
  return order;
}

function navigateTree(direction) {
  const order = getVisibleOrder();
  if (!order.length) return;
  let idx = order.findIndex((s) => s.id === selectedFileId);
  if (idx === -1) {
    idx = direction > 0 ? 0 : order.length - 1;
  } else {
    idx += direction;
    if (idx < 0) idx = order.length - 1;
    if (idx >= order.length) idx = 0;
  }
  selectNav(order[idx].id);
}

// l / Right: expand a collapsed node, descend into an expanded one, leaf = no-op.
function expandOrDescend() {
  const item = currentItem();
  if (!item) return navigateTree(1);
  const children = getTreeIndex().childrenOf[item.id];
  if (!children?.length) return;
  if (!isItemExpanded(item.id)) {
    expandedItems.add(item.id);
    renderTree();
  } else {
    selectNav(children[0].id);
  }
}

// h / Left: collapse an expanded node, otherwise ascend to its parent.
function collapseOrAscend() {
  const item = currentItem();
  if (!item) return navigateTree(-1);
  const children = getTreeIndex().childrenOf[item.id];
  if (children?.length && isItemExpanded(item.id)) {
    expandedItems.delete(item.id);
    renderTree();
  } else if (item.parentId) {
    selectNav(item.parentId);
  }
}

// #endregion RENDER_TREE

// #region MEMORY_INDEX

function isMemoryIndex(source) {
  return (source.scope === 'memory' || source.scope === 'agent-memory') && source.name === 'MEMORY.md';
}

function parseMemoryIndex(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+\.md)\)\s*[—–-]\s*(.+)$/);
    if (m) entries.push({ name: m[1], file: m[2], desc: m[3].trim() });
  }
  return entries;
}

function renderMemoryIndexTable(entries) {
  const TYPE_COLORS = { feedback: 'rule', user: 'user', project: 'project', reference: 'local' };
  const byName = Object.fromEntries(stackData.map((s) => [s.name, s]));
  let html = '<div class="memory-index">';
  for (const entry of entries) {
    const child = byName[entry.file];
    const typeMatch = entry.file.match(/^([a-z]+)_/);
    const type = typeMatch ? typeMatch[1] : 'memory';
    const scopeColor = TYPE_COLORS[type] || 'memory';
    const nameHtml = child
      ? `<a class="import-link" href="#" onclick="selectFile('${escAttrJs(child.id)}');return false" title="${esc(child.path)}">${esc(entry.name)}</a>`
      : `<span class="import-link unresolved" title="Not found: ${esc(entry.file)}">⚠ ${esc(entry.name)}</span>`;
    html += `<div class="memory-index-row">`;
    html += `<span class="scope-badge scope-${scopeColor} memory-index-type">${esc(type)}</span>`;
    html += `<span class="memory-index-name">${nameHtml}</span>`;
    html += `<span class="memory-index-desc">${esc(entry.desc)}</span>`;
    html += `</div>`;
  }
  html += '</div>';
  return html;
}

// #endregion MEMORY_INDEX

// #region RENDER_PREVIEW

async function renderPreview() {
  const panel = document.getElementById('previewPanel');
  if (healthViewOpen) {
    document.getElementById('analyzeBtn')?.classList.add('active');
    panel.innerHTML = '<div class="health-view"><div id="analysisSection"></div></div>';
    if (lastAnalysisSt) rerenderAnalysis();
    return;
  }
  const source = stackData.find((s) => s.id === selectedFileId);
  if (!source) {
    panel.innerHTML =
      '<div class="preview-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/><path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4"/></svg><span>Select a file to preview</span></div>';
    return;
  }

  let fileData;
  try {
    fileData = await fetchJSON(`/api/file?path=${encodeURIComponent(source.path)}`);
  } catch {
    panel.innerHTML = '<div class="preview-empty"><span>Failed to load file</span></div>';
    return;
  }

  let html = '<div class="preview-header">';
  html += '<div class="preview-title">';
  html += `<span class="scope-badge scope-${source.scope}">${esc(source.scope)}</span>`;
  html += `<span class="file-path">${esc(source.name)}</span>`;
  html += '<div class="preview-actions">';
  if (isMemoryIndex(source)) {
    const broken = (source.unresolvedImports || []).length;
    if (broken) {
      html += `<button class="action-btn small" onclick="_cleanupOrphans('${escAttrJs(source.path)}')" title="Cleanup ${broken} orphaned refs"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M12 11v6"/></svg><span style="margin-left:3px">${broken}</span></button>`;
    }
  }
  html += `<button class="action-btn small" onclick="openInEditor('${escAttrJs(source.path)}')" title="Open in VS Code"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M17.583 2.207a1.1 1.1 0 0 1 1.541.033l2.636 2.636a1.1 1.1 0 0 1 .033 1.541L10.68 17.53a1.1 1.1 0 0 1-.345.247l-4.56 1.903a.55.55 0 0 1-.725-.725l1.903-4.56a1.1 1.1 0 0 1 .247-.345zm.902 1.87-8.794 8.793-.946 2.268 2.268-.946 8.794-8.793z"/></svg></button>`;
  html += `<button class="action-btn small" onclick="_confirmDeleteFile('${escAttrJs(source.path)}','${escAttrJs(source.name)}')" title="Delete file"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>`;
  html += '</div></div>';

  // Description gets its own full-width line; the rest stay as key:value chips
  const fmDesc =
    fileData.frontmatter && typeof fileData.frontmatter.description === 'string'
      ? fileData.frontmatter.description.replace(/\s+/g, ' ')
      : '';
  if (fmDesc)
    html += `<div class="preview-desc" title="Click to expand" onclick="this.classList.toggle('expanded')">${esc(fmDesc)}</div>`;

  // Badges row
  html += '<div class="preview-badges">';
  html += `<span class="load-badge load-${source.load}">${esc(source.load)}</span>`;
  html += `<span class="tag-badge">${source.lines}L / ${formatBytes(source.bytes)}</span>`;
  if (fileData.frontmatter) {
    for (const [k, v] of Object.entries(fileData.frontmatter)) {
      if (k === 'description' && fmDesc) continue;
      let val;
      if (Array.isArray(v)) val = v.join(', ');
      else if (v && typeof v === 'object')
        val = Object.entries(v)
          .map(([ck, cv]) => `${ck}=${cv}`)
          .join(', ');
      else val = String(v).replace(/\s+/g, ' ');
      const shown = val.length > 72 ? `${val.slice(0, 69)}…` : val;
      html += `<span class="tag-badge" title="${esc(`${k}: ${val}`)}"><span class="tag-k">${esc(k)}</span>${esc(shown)}</span>`;
    }
  }
  html += '</div>';

  const content = fileData.content || '';
  const memoryEntries = isMemoryIndex(source) ? parseMemoryIndex(content) : [];
  const showMemoryTable = memoryEntries.length > 0;

  const children = stackData.filter((s) => s.parentId === source.id);
  const unresolved = source.unresolvedImports || [];
  if (!showMemoryTable && (children.length || unresolved.length)) {
    html += '<div class="preview-imports">';
    for (const child of children) {
      html += `<a class="import-link" href="#" onclick="selectFile('${escAttrJs(child.id)}');return false" title="${esc(child.path)}">${esc(child.name)}</a>`;
    }
    for (const u of unresolved) {
      html += `<span class="import-link unresolved" title="Not found: ${esc(u)}">⚠ ${esc(u)}</span>`;
    }
    html += '</div>';
  }

  // File path lives inside the header as a muted line instead of its own band
  html += `<div class="preview-filepath" title="${esc(source.path)}">${esc(source.path)}</div>`;
  html += '</div>';

  html += renderFileFindings(source);

  const hl = (text) => {
    const { text: processed, placeholders } = linkifyImports(text, source.id);
    // Skill names aren't filenames (e.g. "aspire") — derive the language from the real file
    const fileName = source.path ? source.path.split(/[\\/]/).pop() : source.name;
    return restorePlaceholders(highlightSource(processed, fileName), placeholders);
  };

  if (showMemoryTable) {
    html += renderMemoryIndexTable(memoryEntries);
    html += `<pre class="preview-code"><code>${hl(content)}</code></pre>`;
    panel.innerHTML = html;
    return;
  }

  if ((source.scope === 'memory' || source.scope === 'agent-memory') && source.load === 'startup' && source.maxLines) {
    const lines = content.split('\n');
    const cutoff = source.maxLines;
    if (lines.length > cutoff) {
      const before = lines.slice(0, cutoff).join('\n');
      const after = lines.slice(cutoff).join('\n');
      html += `<pre class="preview-code"><code>${hl(before)}</code></pre>`;
      html += `<div class="cutoff-line"><span class="cutoff-label">Cutoff: ${cutoff} lines / loaded at startup</span></div>`;
      html += `<pre class="preview-code preview-code-faded"><code>${hl(after)}</code></pre>`;
    } else {
      html += `<pre class="preview-code"><code>${hl(content)}</code></pre>`;
    }
  } else {
    html += `<pre class="preview-code"><code>${hl(content)}</code></pre>`;
  }

  panel.innerHTML = html;
}

function formatBytes(b) {
  if (b < 1024) return `${b}B`;
  return `${(b / 1024).toFixed(1)}KB`;
}

function _confirmDeleteFile(filePath, fileName) {
  const modal = document.getElementById('deleteConfirmModal');
  modal.dataset.filePath = filePath;
  document.getElementById('deleteFileName').textContent = fileName;
  document.getElementById('deleteFilePath').textContent = filePath;
  modal.classList.add('open');
}

async function _submitDeleteFile() {
  const modal = document.getElementById('deleteConfirmModal');
  const filePath = modal.dataset.filePath;
  if (!filePath) return;
  const btn = document.getElementById('deleteConfirmSubmit');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    const res = await fetch('/api/file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const msg = await res
        .json()
        .then((e) => e.error)
        .catch(() => `Delete failed (${res.status})`);
      showToast(msg, 'error');
      return;
    }
    closeModal('deleteConfirmModal');
    delete modal.dataset.filePath;
    selectedFileId = null;
    await loadData();
    showToast('File deleted', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

function _cleanupOrphans(filePath) {
  const source = stackData.find((s) => s.path === filePath);
  const broken = source?.unresolvedImports || [];
  if (!broken.length) {
    showToast('No orphaned refs', 'info');
    return;
  }
  const modal = document.getElementById('cleanupOrphansModal');
  modal.dataset.filePath = filePath;
  document.getElementById('cleanupOrphansCount').textContent = broken.length;
  document.getElementById('cleanupOrphansList').innerHTML = broken.map((r) => `<li>${esc(r)}</li>`).join('');
  modal.classList.add('open');
}

async function _submitCleanupOrphans() {
  const modal = document.getElementById('cleanupOrphansModal');
  const filePath = modal.dataset.filePath;
  if (!filePath) return;
  const btn = document.getElementById('cleanupOrphansSubmit');
  btn.disabled = true;
  btn.textContent = 'Cleaning...';
  try {
    const res = await fetch('/api/memory/cleanup-orphans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const msg = await res
        .json()
        .then((e) => e.error)
        .catch(() => `Cleanup failed (${res.status})`);
      showToast(msg, 'error');
      return;
    }
    const data = await res.json();
    closeModal('cleanupOrphansModal');
    delete modal.dataset.filePath;
    await loadData();
    showToast(`Removed ${data.removed.length} orphaned ref${data.removed.length === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Remove';
  }
}

async function openInEditor(filePath) {
  showToast('Opening...', 'info');
  try {
    const res = await fetch('/api/open-in-editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error, 'error');
    } else {
      showToast('Opened in editor', 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// #endregion RENDER_PREVIEW

// #region ANALYZER

let analysisPollTimer = null;
let lastAnalysisSt = null;
let analysisFindings = []; // findings of the rendered result, addressed by index from handlers
let analysisFilter = 'all';
let analysisDismissed = new Set(); // server-persisted per project; keys are `${kind}|${title}`
let dismissWrites = 0; // dismiss POSTs in flight — polls must not clobber the local set meanwhile
let lastPollKey = null; // fingerprint of the last rendered analysis state
let analysisTs = null; // reset filters when a new result lands
let analysisRunIdx = -1; // shown run: -1 = merged current state (default), 0+ = single run
let fixSelected = new Set(); // finding keys queued for the copyable fix plan
let analysisFileFilter = null; // {id, name} from a memory-map cell click; narrows the findings list
let treeHealth = new Map(); // source id -> {high, med, low} from the latest run
let auditedIds = new Set(); // ids covered by the latest run (clean files get a hollow dot)

// Identity of a finding, used by dismiss/copy/render alike
function findingKey(f) {
  return `${f.kind}|${f.title}`;
}

function resetAnalysisView(runIdx = -1) {
  analysisRunIdx = runIdx;
  analysisFilter = 'all';
  fixSelected = new Set();
  analysisFileFilter = null;
}

// Findings name files by bare name while map cells carry display names (e.g.
// skills), so matching goes through ids — the same resolution as findingFileIds.
function _setFileFilter(id, name) {
  analysisFileFilter = analysisFileFilter?.id === id ? null : { id, name };
  rerenderAnalysis();
}

function findingMatchesFileFilter(f) {
  if (!analysisFileFilter) return true;
  return (f.files || []).some(
    (n) => n === analysisFileFilter.name || findingFileIds(n).includes(analysisFileFilter.id),
  );
}

// Health annotations on the tree always reflect the merged current state,
// regardless of which historical run the health view is showing.
function computeTreeHealth(st) {
  treeHealth = new Map();
  auditedIds = new Set();
  const run = mergedRunView(st);
  if (!run) return;
  for (const s of runAuditedSources(run)) auditedIds.add(s.id);
  for (const f of run.result?.findings || []) {
    if (analysisDismissed.has(findingKey(f))) continue;
    for (const name of f.files || []) {
      for (const id of findingFileIds(name)) {
        const cur = treeHealth.get(id) || { high: 0, med: 0, low: 0 };
        cur[f.severity] = (cur[f.severity] || 0) + 1;
        treeHealth.set(id, cur);
      }
    }
  }
}

// Dismissals change what the tree badges should show — recompute and repaint.
function syncTreeHealth() {
  computeTreeHealth(lastAnalysisSt);
  renderTree();
}
let scopePanelOpen = false;
let scopeChecked = null; // Set of source ids; seeded with the default scope on first open
const scopeCollapsed = new Set();
const ANALYSIS_MODELS = ['sonnet', 'opus', 'fable'];
let analysisModel = ANALYSIS_MODELS.includes(localStorage.getItem('analysisModel'))
  ? localStorage.getItem('analysisModel')
  : 'sonnet';

function _setAnalysisModel(m) {
  if (!ANALYSIS_MODELS.includes(m)) return;
  analysisModel = m;
  try {
    localStorage.setItem('analysisModel', m);
  } catch {}
  rerenderAnalysis();
}

async function _runAnalysis(force, ids) {
  try {
    const body = { force: !!force, model: analysisModel };
    if (Array.isArray(ids) && ids.length) body.ids = ids;
    const res = await fetch('/api/memory/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res
        .json()
        .then((e) => e.error)
        .catch(() => `Analyze failed (${res.status})`);
      showToast(msg, 'error');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data.cached) showToast('Memory unchanged — showing cached analysis. Use Re-run to force.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  refreshAnalysis();
}

async function refreshAnalysis() {
  let st;
  try {
    st = await fetchJSON('/api/memory/analysis');
  } catch {
    return;
  }
  const isNew = st.ts !== analysisTs;
  if (isNew) {
    analysisTs = st.ts;
    resetAnalysisView();
  }
  // A dismiss POST in flight owns the set — adopting the server's (older) copy here
  // would briefly resurrect the finding the user just dismissed.
  if (!dismissWrites) analysisDismissed = new Set(st.dismissed || []);
  lastAnalysisSt = st;
  // Polls where only the banner clock changed must not rebuild the review DOM —
  // that would tear down the cards mid-interaction every 2.5s while a run is in flight.
  const pollKey = JSON.stringify([st.ts, st.error, [...analysisDismissed], (st.pending || []).map((p) => p.id)]);
  const banner = document.getElementById('runningBanner');
  if (pollKey === lastPollKey && banner) {
    banner.innerHTML = renderRunningBanner(st);
  } else {
    computeTreeHealth(st);
    renderTree();
    if (isNew && !healthViewOpen && selectedFileId) renderPreview();
    const el = document.getElementById('analysisSection');
    if (el) {
      el.innerHTML = renderAnalysis(st);
      applyScopeIndeterminate(el);
    }
  }
  lastPollKey = pollKey;
  clearTimeout(analysisPollTimer);
  if ((st.pending || []).length) analysisPollTimer = setTimeout(refreshAnalysis, 2500);
}

// Re-render from the cached state — used by scope/filter/dismiss handlers so a
// checkbox click never triggers a server round-trip.
function rerenderAnalysis() {
  const el = document.getElementById('analysisSection');
  if (!el || !lastAnalysisSt) return;
  el.innerHTML = renderAnalysis(lastAnalysisSt);
  applyScopeIndeterminate(el);
}

// `indeterminate` is a DOM property, not an attribute — set it after every innerHTML render.
function applyScopeIndeterminate(el) {
  for (const box of el.querySelectorAll('input[data-ind]')) box.indeterminate = true;
}

// #region ANALYZER_SCOPE

const CLAUDE_MD_SCOPES = new Set(['project', 'local']);

function analysisScopeGroups() {
  return [
    {
      key: 'memory',
      label: 'Auto memory',
      cls: 't-memory',
      tag: 'memory',
      items: stackData.filter((s) => s.scope === 'memory'),
    },
    {
      key: 'skill',
      label: 'Skills',
      cls: 't-skill',
      tag: 'skill',
      items: stackData.filter((s) => s.scope === 'skill' && !s.parentId),
    },
    {
      key: 'claudemd',
      label: 'CLAUDE.md',
      cls: 't-claudemd',
      tag: 'md',
      items: stackData.filter((s) => CLAUDE_MD_SCOPES.has(s.scope) && !s.parentId),
    },
    {
      key: 'agent',
      label: 'Agent memory',
      cls: 't-agent',
      tag: 'agent',
      items: stackData.filter((s) => s.scope === 'agent-memory'),
    },
  ].filter((g) => g.items.length);
}

function _toggleScopePanel() {
  scopePanelOpen = !scopePanelOpen;
  if (scopePanelOpen && !scopeChecked) {
    // default scope = auto memory only (skills, agent memory, CLAUDE.md are opt-in)
    scopeChecked = new Set(stackData.filter((s) => s.scope === 'memory').map((s) => s.id));
  }
  rerenderAnalysis();
}

function _toggleScopeGroup(key) {
  const g = analysisScopeGroups().find((x) => x.key === key);
  if (!g) return;
  const allOn = g.items.every((s) => scopeChecked.has(s.id));
  for (const s of g.items) {
    if (allOn) scopeChecked.delete(s.id);
    else scopeChecked.add(s.id);
  }
  rerenderAnalysis();
}

function _toggleScopeLeaf(id) {
  if (scopeChecked.has(id)) scopeChecked.delete(id);
  else scopeChecked.add(id);
  rerenderAnalysis();
}

function _toggleScopeCollapse(key, e) {
  e.stopPropagation();
  if (scopeCollapsed.has(key)) scopeCollapsed.delete(key);
  else scopeCollapsed.add(key);
  rerenderAnalysis();
}

function _runScopedAnalysis() {
  if (!scopeChecked?.size) return;
  scopePanelOpen = false;
  _runAnalysis(true, [...scopeChecked]);
}

function renderScopePanel() {
  if (!scopePanelOpen || !scopeChecked) return '';
  let html = '<div class="scope-panel open">';
  html += '<div class="scope-panel-title">Select what to analyze</div>';
  html += '<div class="scope-tree">';
  for (const g of analysisScopeGroups()) {
    const on = g.items.filter((s) => scopeChecked.has(s.id)).length;
    const collapsed = scopeCollapsed.has(g.key);
    html += `<div class="scope-group${collapsed ? ' collapsed' : ''}">`;
    html += `<div class="scope-row" onclick="_toggleScopeGroup('${escAttrJs(g.key)}')">`;
    html += `<span class="scope-caret" onclick="_toggleScopeCollapse('${escAttrJs(g.key)}', event)">${collapsed ? '▸' : '▾'}</span>`;
    html += `<input type="checkbox" ${on === g.items.length ? 'checked' : ''} ${on > 0 && on < g.items.length ? 'data-ind="1"' : ''} onclick="event.preventDefault()">`;
    html += `<span class="scope-tag ${esc(g.cls)}">${g.tag}</span>`;
    html += `<span>${esc(g.label)}</span>`;
    html += `<span class="scope-meta">${on}/${g.items.length}</span>`;
    html += '</div>';
    html += '<div class="scope-children">';
    for (const s of g.items) {
      html += `<div class="scope-row" onclick="_toggleScopeLeaf('${escAttrJs(s.id)}')">`;
      html += `<input type="checkbox" ${scopeChecked.has(s.id) ? 'checked' : ''} onclick="event.preventDefault()">`;
      html += `<span>${esc(s.name)}</span>`;
      html += `<span class="scope-meta">${s.lines}L</span>`;
      html += '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  const n = scopeChecked.size;
  html += '<div class="scope-footer">';
  html += `<span class="scope-hint">${n} file${n === 1 ? '' : 's'} selected</span>`;
  html += '<div class="scope-model" title="Model for this analysis">';
  for (const m of ANALYSIS_MODELS)
    html += `<button class="scope-model-opt${m === analysisModel ? ' active' : ''}" onclick="_setAnalysisModel('${escAttrJs(m)}')">${m}</button>`;
  html += '</div>';
  html += '<button class="action-btn small" onclick="_toggleScopePanel()">Cancel</button>';
  html += `<button class="action-btn small primary" ${n ? '' : 'disabled'} onclick="_runScopedAnalysis()">Run analysis (${n})</button>`;
  html += '</div></div>';
  return html;
}

// #endregion ANALYZER_SCOPE

// #region ANALYZER_ACTIONS

function memoryDirPath() {
  const idx = stackData.find((s) => s.scope === 'memory' && s.name === 'MEMORY.md');
  return idx ? idx.path.replace(/[\\/][^\\/]+$/, '') : null;
}

function findingPrompt(f) {
  const dir = memoryDirPath();
  const lines = [
    dir
      ? `In the Claude Code auto-memory at ${dir}, apply this fix:`
      : "In this project's Claude Code auto-memory, apply this fix:",
    '',
    `Finding (${f.kind}, ${f.severity}): ${f.title}`,
    f.detail,
    '',
    `Action: ${f.suggestion}`,
  ];
  if ((f.files || []).length) lines.push(`Files: ${f.files.join(', ')}`);
  lines.push('', 'Update MEMORY.md index lines if files are added, renamed, or removed.');
  return lines.join('\n');
}

function copyText(text, okMsg) {
  navigator.clipboard
    .writeText(text)
    .then(() => showToast(okMsg, 'info'))
    .catch(() => showToast('Clipboard unavailable', 'error'));
}

function _copyFindingPrompt(idx) {
  const f = analysisFindings[idx];
  if (f) copyText(findingPrompt(f), 'Prompt copied — paste into any Claude Code session');
}

function _copyAllFindings() {
  const live = analysisFindings.filter((f) => !analysisDismissed.has(findingKey(f)));
  if (!live.length) return;
  copyText(live.map(findingPrompt).join('\n\n---\n\n'), `${live.length} prompts copied`);
}

// The local set already changed, so the UI never waits; the response's authoritative
// list is adopted once no other write is racing it.
function persistDismissed(body) {
  dismissWrites++;
  fetch('/api/memory/analysis/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .then((d) => {
      if (dismissWrites === 1 && Array.isArray(d.dismissed)) analysisDismissed = new Set(d.dismissed);
    })
    .catch(() => {})
    .finally(() => dismissWrites--);
}

// Shared by the health view and the file-preview cards — collapse the card,
// persist the dismissal, then repaint whichever surface hosted it.
function dismissFinding(btn, f, repaint) {
  const card = btn.closest('.analysis-card');
  card.style.maxHeight = `${card.offsetHeight}px`;
  requestAnimationFrame(() => card.classList.add('leaving'));
  setTimeout(() => {
    analysisDismissed.add(findingKey(f));
    persistDismissed({ key: findingKey(f) });
    fixSelected.delete(findingKey(f)); // a dismissed finding can't stay queued in the fix plan
    syncTreeHealth();
    repaint();
  }, 280);
}

function _dismissFinding(btn, idx) {
  const f = analysisFindings[idx];
  if (f) dismissFinding(btn, f, rerenderAnalysis);
}

function _restoreDismissed() {
  analysisDismissed = new Set();
  persistDismissed({ all: true });
  syncTreeHealth();
  rerenderAnalysis();
}

function _setAnalysisFilter(sev) {
  analysisFilter = sev;
  rerenderAnalysis();
}

// #endregion ANALYZER_ACTIONS

function analysisTimeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const DISMISS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

function fileChipScope(source) {
  if (!source) return '';
  return source.scope === 'agent-memory' ? 'agent' : source.scope;
}

// Mirrors the server's analyzableSources: the user CLAUDE.md and rules are
// reference-only context for the analyzer, never audited, even when their ids
// ride along in the run's scope.
function analyzableSource(s) {
  return (
    s.scope === 'memory' ||
    s.scope === 'agent-memory' ||
    ((s.scope === 'skill' || s.scope === 'project' || s.scope === 'local') && !s.parentId)
  );
}

// Files covered by a run. Runs carry an `audited` snapshot taken at analysis
// time — the authoritative list even after the stack changes. Older runs
// predate the snapshot and fall back to re-deriving from the live stack.
function runAuditedSources(run) {
  if (!run) return [];
  if (run.audited) return run.audited;
  // Soft-linked (@import) children never go into the analysis, so keep them out
  // of every health annotation even when their parent's id is in the run scope.
  const own = stackData.filter((s) => !s.parentId && analyzableSource(s));
  return run.ids ? own.filter((s) => run.ids.includes(s.id)) : own.filter((s) => s.scope === 'memory');
}

// Findings name files by bare name, which collides across scopes (user vs
// project CLAUDE.md). Attribute to audit-eligible sources first; fall back to
// any source with that name only when none are eligible — the agent may report
// out-of-scope files it read recursively, and those still deserve a badge.
function findingFileIds(name) {
  // The agent sometimes reports a relative path instead of the display name
  // (e.g. "dev-tools/bonya/.claude/skills/bonya/SKILL.md" for skill
  // "dev-tools/bonya:bonya") — match those by path suffix. Only slash-bearing
  // names qualify: a bare "SKILL.md" would suffix-match every skill.
  const n = name.replace(/\\/g, '/');
  const byPath = (s) => {
    if (!n.includes('/')) return false;
    const p = (s.path || '').replace(/\\/g, '/');
    return p === n || p.endsWith(`/${n}`);
  };
  const matches = stackData.filter((s) => s.name === name || byPath(s));
  const eligible = matches.filter((s) => !s.parentId && analyzableSource(s));
  return (eligible.length ? eligible : matches).map((s) => s.id);
}

// The default health view merges runs: each file carries the verdict of the
// newest run that audited it, so a narrow re-run (say, one skill) overlays the
// wider picture instead of replacing it. Run chips still show single runs.
function mergedRunView(st) {
  const runs = st?.runs || [];
  if (runs.length <= 1) return runs[0] || null;
  const owner = new Map(); // file id -> newest run that audited it
  const audited = [];
  for (const run of runs) {
    for (const s of runAuditedSources(run)) {
      if (owner.has(s.id)) continue;
      owner.set(s.id, run);
      audited.push(s);
    }
  }
  const findings = [];
  const seen = new Set();
  for (const run of runs) {
    for (const f of run.result?.findings || []) {
      if (seen.has(findingKey(f))) continue;
      const ids = (f.files || []).flatMap(findingFileIds);
      // A finding survives while its run still owns a file it touches — a newer
      // run that re-audited the file supersedes the old verdict. File-less
      // findings (suggested new memories) belong to the latest run only.
      const owns = ids.length ? ids.some((id) => owner.get(id) === run) : run === runs[0];
      if (!owns) continue;
      seen.add(findingKey(f));
      findings.push(f);
    }
  }
  const latest = runs[0];
  return {
    ...latest,
    audited,
    // The latest run's summary describes only its own scope — misleading when
    // merged, so it is dropped here.
    result: { ...latest.result, findings, summary: null, scopeDesc: `${runs.length} runs merged` },
  };
}

const SEV_WEIGHT = { high: 10, med: 3, low: 1 };

// Start at 100, subtract per finding by severity. Blunt but explainable.
function healthScore(findings) {
  const penalty = findings.reduce((s, f) => s + (SEV_WEIGHT[f.severity] || 1), 0);
  return Math.max(2, 100 - penalty);
}

function sevCounts(findings) {
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

function renderHealthDash(st, shown) {
  // Score, tiles, and clean count track the live (non-dismissed) list they sit above.
  const findings = (shown.result?.findings || []).filter((f) => !analysisDismissed.has(findingKey(f)));
  const c = sevCounts(findings);
  const audited = runAuditedSources(shown);
  const dirty = new Set(findings.flatMap((f) => (f.files || []).flatMap(findingFileIds)));
  const clean = audited.filter((s) => !dirty.has(s.id)).length;
  const score = healthScore(findings);
  const scoreColor = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--error)';
  const CIRC = 163.4; // 2πr for r=26
  let html = '<div class="hv-tiles">';
  html += '<div class="hv-tile hv-ring-tile">';
  html += `<div class="hv-ring"><svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="var(--bg-hover)" stroke-width="6"/><circle cx="32" cy="32" r="26" fill="none" stroke="${esc(scoreColor)}" stroke-width="6" stroke-linecap="round" transform="rotate(-90 32 32)" stroke-dasharray="${CIRC}" stroke-dashoffset="${esc((CIRC * (100 - score)) / 100)}"/></svg><span class="hv-ring-val" style="color:${scoreColor}">${score}</span></div>`;
  html += `<div class="hv-tile-txt" title="Score = 100 − 10/high − 3/med − 1/low"><span class="hv-lbl">Health</span><span class="hv-sub">of 100</span></div></div>`;
  for (const [sev, label] of [
    ['high', 'High'],
    ['med', 'Medium'],
    ['low', 'Low'],
  ]) {
    html += `<div class="hv-tile"><span class="hv-lbl"><span class="dot sev-dot-${esc(sev)}"></span>${label}</span><span class="hv-num hv-num-${esc(sev)}">${c[sev]}</span></div>`;
  }
  html += `<div class="hv-tile"><span class="hv-lbl">Clean</span><span class="hv-num hv-num-clean">${clean}<i>/${audited.length}</i></span><span class="hv-sub">audited files</span></div>`;
  html += renderTrend(st);
  html += '</div>';
  return html;
}

// Findings per run as stacked mini-columns, oldest to newest; click switches the shown run.
function renderTrend(st) {
  const runs = st.runs || [];
  if (runs.length < 2) return '';
  let html = '<div class="hv-tile hv-trend-tile"><span class="hv-lbl">Trend</span><div class="hv-trend">';
  for (let i = runs.length - 1; i >= 0; i--) {
    const c = sevCounts(runs[i].result?.findings || []);
    const px = (n) => (n ? Math.max(3, n * 4) : 0);
    html += `<div class="hv-trun${i === analysisRunIdx ? ' cur' : ''}" onclick="_setAnalysisRun(${i})" title="${esc(analysisTimeAgo(runs[i].ts))} — ${c.high} high · ${c.med} med · ${c.low} low">`;
    if (c.low) html += `<i class="tl" style="height:${px(c.low)}px"></i>`;
    if (c.med) html += `<i class="tm" style="height:${px(c.med)}px"></i>`;
    if (c.high) html += `<i class="th" style="height:${px(c.high)}px"></i>`;
    if (!c.high && !c.med && !c.low) html += '<i class="tz"></i>';
    html += '</div>';
  }
  html += '</div></div>';
  return html;
}

// Every audited file sized by line count, colored by its worst finding.
function renderMemoryMap(shown) {
  const audited = runAuditedSources(shown);
  if (!audited.length) return '';
  const findings = (shown.result?.findings || []).filter((f) => !analysisDismissed.has(findingKey(f)));
  const perFile = new Map();
  for (const f of findings) {
    for (const name of f.files || []) {
      for (const id of findingFileIds(name)) {
        const cur = perFile.get(id) || { high: 0, med: 0, low: 0 };
        cur[f.severity]++;
        perFile.set(id, cur);
      }
    }
  }
  const sevRank = { high: 0, med: 1, low: 2, clean: 3 };
  const cellSev = (s) => {
    const c = perFile.get(s.id);
    return c ? (c.high ? 'high' : c.med ? 'med' : 'low') : 'clean';
  };
  let html = '<div class="hv-map-label">Memory map — colored by worst finding</div><div class="hv-map">';
  for (const s of [...audited].sort(
    (a, b) => sevRank[cellSev(a)] - sevRank[cellSev(b)] || a.name.localeCompare(b.name),
  )) {
    const c = perFile.get(s.id);
    const sev = cellSev(s);
    const n = c ? c.high + c.med + c.low : 0;
    const title = `${s.name} — ${s.lines}L${n ? ` · ${n} finding${n > 1 ? 's' : ''} (worst: ${sev})` : ' · clean'}`;
    html += `<div class="hv-cell hv-${esc(sev)}${analysisFileFilter?.id === s.id ? ' active' : ''}" onclick="_setFileFilter('${escAttrJs(s.id)}','${escAttrJs(s.name)}')" title="${esc(title)} — click to filter findings">`;
    if (n) html += `<span class="hv-cell-n hv-cn-${esc(sev)}">${n}</span>`;
    html += `<span class="hv-cell-name">${esc(s.name)}</span><span class="hv-cell-meta">${s.lines}L</span></div>`;
  }
  html += '</div>';
  return html;
}

// Findings for one file from the merged current state, shown inline in the file preview.
function renderFileFindings(source) {
  const run = mergedRunView(lastAnalysisSt);
  if (!run) return '';
  const hits = (run.result?.findings || [])
    .map((f, i) => [f, i])
    .filter(
      ([f]) =>
        (f.files || []).some((n) => findingFileIds(n).includes(source.id)) && !analysisDismissed.has(findingKey(f)),
    );
  if (!hits.length) return '';
  let html = `<div class="preview-findings"><div class="pf-label">Claude analysis — ${hits.length} finding${hits.length > 1 ? 's' : ''} for this file</div>`;
  for (const [f, i] of hits) {
    html += `<div class="analysis-card pf-card ${esc(`sev-${f.severity}`)}">`;
    html += `<div class="analysis-card-head" onclick="this.parentElement.classList.toggle('expanded')">`;
    html += `<span class="kind-badge ${esc(`kind-${f.kind}`)}">${esc(f.kind)}</span>`;
    html += `<span class="analysis-card-title">${esc(f.title)}</span>`;
    html += '<span class="card-actions">';
    html += `<button class="card-btn" onclick="event.stopPropagation();_copyLatestFindingPrompt(${i})" title="Copy an agent-ready instruction for this finding">${COPY_ICON}Copy prompt</button>`;
    html += `<button class="card-btn" onclick="event.stopPropagation();_dismissLatestFinding(this, ${i})" title="Drop this finding from the list">${DISMISS_ICON}Dismiss</button>`;
    html += '</span></div>';
    html += `<div class="analysis-card-detail">${esc(f.detail)}</div>`;
    html += `<div class="analysis-card-suggestion">${esc(f.suggestion)}</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// Indexes into the merged current state — the same list renderFileFindings
// draws from, unlike the health view, which can show a historical run.
function _copyLatestFindingPrompt(i) {
  const f = mergedRunView(lastAnalysisSt)?.result?.findings?.[i];
  if (f) copyText(findingPrompt(f), 'Prompt copied — paste into any Claude Code session');
}

// Dismissals share the health view's set, so a finding dropped here
// disappears there too (and vice versa).
function _dismissLatestFinding(btn, i) {
  const f = mergedRunView(lastAnalysisSt)?.result?.findings?.[i];
  if (f) dismissFinding(btn, f, renderPreview);
}

function _toggleFixSelect(idx) {
  const f = analysisFindings[idx];
  if (!f) return;
  const key = findingKey(f);
  if (fixSelected.has(key)) fixSelected.delete(key);
  else fixSelected.add(key);
  rerenderAnalysis();
}

function _copyFixPlan() {
  const order = { high: 0, med: 1, low: 2 };
  const picked = analysisFindings
    .filter((f) => fixSelected.has(findingKey(f)))
    .sort((a, b) => order[a.severity] - order[b.severity]);
  if (!picked.length) return;
  const plan = [
    `Fix plan — ${picked.length} finding${picked.length > 1 ? 's' : ''} from a Claude Code memory audit, ordered by severity. Apply each in order.`,
    '',
    ...picked.map((f, i) => `## ${i + 1}. ${findingPrompt(f)}`),
  ].join('\n\n');
  copyText(
    plan,
    `Fix plan copied — ${picked.length} finding${picked.length > 1 ? 's' : ''}, paste into any Claude Code session`,
  );
}

function renderAnalysisHead(st, r, ts) {
  const meta = [];
  if (ts) meta.push(analysisTimeAgo(ts));
  if (r?.costUsd != null) meta.push(`$${r.costUsd.toFixed(2)}`);
  if (r?.durationMs != null) meta.push(`${Math.round(r.durationMs / 1000)}s`);
  if (r?.model) meta.push(r.model);
  if (r?.scopeDesc) meta.push(`scope: ${r.scopeDesc}`);
  if (st.stale && analysisRunIdx <= 0) meta.push('memory changed since');
  let html = '<div class="analysis-head">';
  html += '<span class="analysis-title">Claude analysis</span>';
  html += `<span class="analysis-meta">${esc(meta.join(' · '))}</span>`;
  if (r && (r.findings || []).length)
    html += '<button class="action-btn small" onclick="_copyAllFindings()">Copy all</button>';
  html += `<button class="action-btn small primary" onclick="_toggleScopePanel()">New analysis…</button>`;
  html += '</div>';
  html += renderRunsStrip(st);
  html += renderScopePanel();
  return html;
}

function _setAnalysisRun(i) {
  resetAnalysisView(i); // clears the file filter, so the tree badges must be restored too
  syncTreeHealth();
  rerenderAnalysis();
}

async function _deleteAnalysisRun(ev, ts) {
  ev.stopPropagation();
  await fetch('/api/memory/analysis/delete-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts }),
  });
  resetAnalysisView();
  analysisTs = null; // force refreshAnalysis to re-adopt the new latest run
  refreshAnalysis();
}

// Past runs for this project (newest first).
function renderRunsStrip(st) {
  const runs = st.runs || [];
  if (!runs.length) return '';
  let html = '<div class="runs-strip"><span class="runs-label">runs</span>';
  if (runs.length > 1) {
    html += `<span class="run-chip${analysisRunIdx < 0 ? ' active' : ''}" onclick="_setAnalysisRun(-1)" title="Each file shows the newest run that audited it">current · ${runs.length} runs merged</span>`;
  }
  runs.forEach((run, i) => {
    const r = run.result || {};
    const bits = [analysisTimeAgo(run.ts)];
    if (r.model) bits.push(r.model);
    if (r.costUsd != null) bits.push(`$${r.costUsd.toFixed(2)}`);
    html += `<span class="run-chip${i === analysisRunIdx ? ' active' : ''}" onclick="_setAnalysisRun(${i})" title="${esc(r.scopeDesc || '')}">${esc(bits.join(' · '))}<button class="run-chip-x" onclick="_deleteAnalysisRun(event, ${escAttrJs(run.ts)})" title="Delete this run">×</button></span>`;
  });
  html += '</div>';
  return html;
}

// The previous review stays on screen while runs are in flight — running state is a
// banner above it, not a replacement view.
function renderRunningBanner(st) {
  const pending = st.pending || [];
  if (!pending.length) return '';
  let html = '';
  for (const p of pending) {
    const bits = [];
    if (p.model) bits.push(p.model);
    if (p.scopeDesc) bits.push(p.scopeDesc);
    if (p.startedAt) bits.push(`started ${analysisTimeAgo(p.startedAt)}`);
    html += `<div class="analysis-status"><span class="analysis-spinner"></span>Analyzing memory with Claude Code — usually 30–90s…${bits.length ? ` <span class="analysis-meta">${esc(bits.join(' · '))}</span>` : ''}</div>`;
  }
  return html;
}

function renderAnalysis(st) {
  const runs = st.runs || [];
  const shown = analysisRunIdx < 0 ? mergedRunView(st) : runs[analysisRunIdx];
  // The wrapper stays in the DOM even when empty so quiet polls can update just
  // the banner in place instead of rebuilding the whole review (see refreshAnalysis).
  let html = '<div class="analysis-box">';
  html += `<div id="runningBanner">${renderRunningBanner(st)}</div>`;
  html += renderAnalysisHead(st, shown?.result, shown?.ts);
  // A failed run no longer wipes history — show the error above the surviving review.
  if (st.error) {
    html += `<div class="analysis-status analysis-status-error">${esc(st.error)} <button class="action-btn small" onclick="_runAnalysis(true)">Retry</button></div>`;
    if (!shown) return `${html}</div>`;
  }
  if (!shown) {
    html += '<div class="analysis-empty">No analysis yet — pick a scope and run one.</div></div>';
    return html;
  }
  const r = shown.result;
  analysisFindings = r.findings || [];
  const byName = Object.fromEntries(stackData.map((s) => [s.name, s]));
  html += renderHealthDash(st, shown);
  if (r.summary) html += `<div class="analysis-summary">${esc(r.summary)}</div>`;
  html += renderMemoryMap(shown);

  const live = analysisFindings.filter((f) => !analysisDismissed.has(findingKey(f)));
  const count = (sev) => live.filter((f) => f.severity === sev).length;
  if (analysisFindings.length) {
    html += '<div class="sev-strip">';
    for (const sev of ['all', 'high', 'med', 'low']) {
      const n = sev === 'all' ? live.length : count(sev);
      html += `<button class="sev-pill${analysisFilter === sev ? ' active' : ''}" data-sev="${esc(sev)}" onclick="_setAnalysisFilter('${escAttrJs(sev)}')">`;
      if (sev !== 'all') html += '<span class="dot"></span>';
      html += `${sev} ${n}</button>`;
    }
    if (analysisFileFilter) {
      html += `<button class="sev-pill active" onclick="_setFileFilter('${escAttrJs(analysisFileFilter.id)}','${escAttrJs(analysisFileFilter.name)}')" title="Clear the file filter">${esc(analysisFileFilter.name)} ×</button>`;
    }
    if (analysisDismissed.size) {
      html += `<span class="dismissed-note">${analysisDismissed.size} dismissed · <a onclick="_restoreDismissed()">restore</a></span>`;
    }
    if (fixSelected.size) {
      html += `<button class="card-btn fix-plan-btn" onclick="_copyFixPlan()" title="Copy the selected findings as one ordered fix prompt">${COPY_ICON}Copy fix plan (${fixSelected.size})</button>`;
    }
    html += '</div>';
  }

  const visible = live.filter(
    (f) => (analysisFilter === 'all' || f.severity === analysisFilter) && findingMatchesFileFilter(f),
  );
  if (!analysisFindings.length) html += '<div class="analysis-empty">No issues found.</div>';
  else if (!visible.length) html += '<div class="analysis-empty">Nothing here — filtered out or dismissed.</div>';
  for (const f of visible) {
    const idx = analysisFindings.indexOf(f);
    html += `<div class="analysis-card ${esc(`sev-${f.severity}`)}">`;
    html += '<div class="analysis-card-head">';
    html += `<input type="checkbox" class="fix-check" ${fixSelected.has(findingKey(f)) ? 'checked ' : ''}onclick="_toggleFixSelect(${idx})" title="Queue for the fix plan">`;
    html += `<span class="kind-badge ${esc(`kind-${f.kind}`)}">${esc(f.kind)}</span>`;
    html += `<span class="analysis-card-title">${esc(f.title)}</span>`;
    html += '<span class="card-actions">';
    html += `<button class="card-btn" onclick="_copyFindingPrompt(${idx})" title="Copy an agent-ready instruction for this finding">${COPY_ICON}Copy prompt</button>`;
    html += `<button class="card-btn" onclick="_dismissFinding(this, ${idx})" title="Drop this finding from the list">${DISMISS_ICON}Dismiss</button>`;
    html += '</span></div>';
    const files = f.files || [];
    html += '<div class="analysis-card-files">';
    if (!files.length) html += '<span class="no-files">no file — new memory suggested</span>';
    for (const fn of files) {
      // Same name-or-path resolution as the map and tree badges — a chip must
      // stay clickable when the agent reported a path instead of the name.
      const child = byName[fn] || stackData.find((s) => findingFileIds(fn).includes(s.id));
      const scopeTag = fileChipScope(child);
      if (child) {
        html += `<a class="file-chip" href="#" onclick="selectFile('${escAttrJs(child.id)}');return false" title="${esc(child.path)}">${FILE_ICON}${esc(fn)}<span class="fscope fscope-${esc(scopeTag)}">${esc(scopeTag)}</span></a>`;
      } else {
        html += `<span class="file-chip">${FILE_ICON}${esc(fn)}</span>`;
      }
    }
    html += '</div>';
    html += `<div class="analysis-card-detail">${esc(f.detail)}</div>`;
    html += `<div class="analysis-card-suggestion">${esc(f.suggestion)}</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// #endregion ANALYZER

// #region RENDER_BUDGET

let footprintHighlight = false;
let footprintScope = null; // null = whole footprint; a scope name = just that segment's files
let footprintIds = new Set(); // source ids the server counted into the footprint

// Clicking the top bar highlights all footprint files; clicking a segment narrows
// the highlight to that segment's scope (the skill segment = skill descriptions).
function _toggleFootprint(scope = null, ev) {
  if (ev) ev.stopPropagation();
  if (footprintHighlight && footprintScope === scope) {
    footprintHighlight = false;
    footprintScope = null;
  } else {
    footprintHighlight = true;
    footprintScope = scope;
  }
  document.body.classList.toggle('fp-mode', footprintHighlight);
  applySegmentState();
  renderTree();
}

function footprintHit(item) {
  if (footprintScope === 'skill') return item.scope === 'skill' && !item.parentId;
  if (footprintScope) return footprintIds.has(item.id) && item.scope === footprintScope;
  return footprintIds.has(item.id);
}

function applySegmentState() {
  const scoped = footprintHighlight && footprintScope !== null;
  for (const el of document.querySelectorAll('.budget-segment')) {
    el.classList.toggle('seg-dim', scoped && el.dataset.scope !== footprintScope);
  }
}

function renderBudget() {
  if (!summaryData) return;
  footprintIds = new Set(summaryData.ids || []);

  // Summary stat cards
  document.getElementById('statFiles').textContent = summaryData.totalFiles;
  document.getElementById('statChars').textContent = summaryData.totalChars.toLocaleString();
  document.getElementById('statBytes').textContent = formatBytes(summaryData.totalBytes);
  document.getElementById('statAlways').textContent = summaryData.alwaysLoaded;

  // Budget text
  document.getElementById('budgetText').textContent =
    `${summaryData.totalChars.toLocaleString()} chars / ${formatBytes(summaryData.totalBytes)}`;

  // Budget segments — proportional by chars per scope; the server's summary owns
  // the footprint filter, the client only renders its per-scope totals.
  const segContainer = document.getElementById('budgetSegments');
  const scopeTotals = summaryData.scopeChars || {};
  const skillDescChars = summaryData.skillDesc?.chars || 0;
  const totalChars = summaryData.totalChars || 1;
  let html = '';
  for (const scope of SCOPE_ORDER) {
    const chars = scopeTotals[scope];
    if (!chars) continue;
    const pct = (chars / totalChars) * 100;
    html += `<div class="budget-segment" data-scope="${esc(scope)}" onclick="_toggleFootprint('${escAttrJs(scope)}', event)" style="width:${pct}%;background:var(--scope-${scope})" title="${SCOPE_LABELS[scope] || scope}: ${chars.toLocaleString()} chars (${pct.toFixed(1)}%) — click to highlight"></div>`;
  }
  if (skillDescChars) {
    const pct = (skillDescChars / totalChars) * 100;
    html += `<div class="budget-segment" data-scope="skill" onclick="_toggleFootprint('skill', event)" style="width:${pct}%;background:var(--scope-skill)" title="Skill descriptions (${esc(summaryData.skillDesc.count)} enabled): ${skillDescChars.toLocaleString()} chars (${pct.toFixed(1)}%) — click to highlight"></div>`;
  }
  segContainer.innerHTML = html;
  applySegmentState();
}

// #endregion RENDER_BUDGET

// #region DATA

async function loadData() {
  try {
    [stackData, summaryData] = await Promise.all([fetchJSON('/api/stack'), fetchJSON('/api/summary')]);
    invalidateTreeIndex();
    renderBudget(); // refreshes footprintIds, which renderTree's highlight reads
    renderTree();
    refreshAnalysis(); // health dots on the tree come from the latest run
    if (!selectedFileId && !healthViewOpen) {
      const proj = stackData.find((s) => s.scope === 'project' && s.name === 'CLAUDE.md');
      const user = stackData.find((s) => s.scope === 'user' && s.name === 'CLAUDE.md');
      const auto = proj || user;
      if (auto) selectedFileId = auto.id;
    }
    if (selectedFileId) renderTree();
    renderPreview();
  } catch (err) {
    showToast(`Failed to load: ${err.message}`, 'error');
  }
}

async function refreshData() {
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    showToast('Data Refreshed', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// #endregion DATA

// #region TOAST

function showToast(msg, type) {
  const container = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `toast ${type || ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// #endregion TOAST

// #region KEYBOARD

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const modal = document.querySelector('.modal-overlay.open');
  if (modal) {
    if (e.key === 'Escape') {
      modal.classList.remove('open');
      e.preventDefault();
    }
    return;
  }
  if (e.key === 'Escape' && healthViewOpen) {
    e.preventDefault();
    openHealthView();
    return;
  }
  if (e.key === 't') toggleTheme();
  if (e.key === 'r') refreshData();
  if (e.key === '?') {
    e.preventDefault();
    toggleHelpModal();
  }
  if (e.key === 'P' && e.shiftKey) {
    e.preventDefault();
    changeProject();
  }
  // Skip when modifiers are held (e.g. hub's Ctrl+Alt+Arrow app switching).
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
  if (plain && (e.key === 'j' || e.key === 'ArrowDown')) {
    e.preventDefault();
    navigateTree(1);
  }
  if (plain && (e.key === 'k' || e.key === 'ArrowUp')) {
    e.preventDefault();
    navigateTree(-1);
  }
  if (plain && (e.key === 'h' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    collapseOrAscend();
  }
  if (plain && (e.key === 'l' || e.key === 'ArrowRight')) {
    e.preventDefault();
    expandOrDescend();
  }
  if (e.key === 'Enter' && selectedFileId) renderPreview();
  if (e.key === 'e' && selectedFileId) {
    const s = stackData.find((x) => x.id === selectedFileId);
    if (s) openInEditor(s.path);
  }
});

// #endregion KEYBOARD

// #region HUB_INTEGRATION

(async function initHub() {
  const cfg = await fetch('/hub-config')
    .then((r) => r.json())
    .catch(() => ({}));
  if (!cfg.enabled) return;
  window.__HUB__ = cfg;
  const fwd = (e) => hubPost({ type: 'hub:keydown', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      fwd(e);
    }
    // Its own branch: the Alt+digit case below requires !ctrlKey.
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      fwd(e);
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      fwd(e);
    }
  });
})();

function _hubNavigate(app, url) {
  if (!window.__HUB__?.enabled) return;
  hubPost({ type: 'hub:navigate', app, url });
}

// Hoisted out of initHubTheme so initHubProject can share it.
const hubOrigin = () => (window.__HUB__?.url ? new URL(window.__HUB__.url).origin : null);

// Every send is addressed to the hub explicitly. With targetOrigin '*' any page that
// framed this app also received the forwarded keystrokes and navigation intents.
function hubPost(message) {
  const origin = hubOrigin();
  if (origin) window.parent?.postMessage(message, origin);
}

(function initHubTheme() {
  const getTheme = () => (document.body.classList.contains('light') ? 'light' : 'dark');
  const getColorTheme = () => document.body.dataset.colorTheme || 'ember';
  // lastTheme/lastColorTheme are updated synchronously when applying a hub
  // message, so the (async) observer sees no diff and doesn't echo it back.
  let lastTheme = getTheme();
  let lastColorTheme = getColorTheme();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:theme') return;
    if (typeof e.data.colorTheme === 'string' && e.data.colorTheme !== getColorTheme()) {
      setColorTheme(e.data.colorTheme);
      lastColorTheme = getColorTheme();
    }
    if (getTheme() !== e.data.theme) {
      window.toggleTheme();
      lastTheme = getTheme();
    }
  });
  new MutationObserver(() => {
    const t = getTheme();
    const ct = getColorTheme();
    if (t === lastTheme && ct === lastColorTheme) return;
    lastTheme = t;
    lastColorTheme = ct;
    hubPost({ type: 'hub:theme', theme: t, colorTheme: ct });
  }).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
})();

// Set synchronously when the hub pushes a project, so the DOMContentLoaded restore below can't
// let a stale localStorage recent win the race against the hub's choice.
let hubProjectPath = null;

(function initHubProject() {
  let lastApplied = null;
  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent || e.origin !== hubOrigin()) return;
    if (e.data?.type !== 'hub:project') return;
    const dirPath = e.data.project;
    if (typeof dirPath !== 'string' || !dirPath) return;
    hubProjectPath = dirPath;
    // Dedupes against the last applied value, not just an in-flight one: the hub re-posts on
    // every iframe load, so without this each load would PUT and reload twice.
    if (lastApplied === dirPath) return;
    lastApplied = dirPath;
    try {
      await putProject(dirPath);
      // The hub does not persist its own scope, so a hub-pushed project must become the recent
      // head here: after a hard refresh the boot path PUTs getRecentProjects()[0], which would
      // otherwise clobber the server's hub-scoped project with the previous one.
      addRecentProject(dirPath);
      await Promise.all([loadProject(), loadData()]);
    } catch (err) {
      lastApplied = null;
      console.warn('hub:project failed:', err.message);
    }
  });
})();

// #endregion HUB_INTEGRATION

// #region RESIZE

function initResize() {
  const handle = document.getElementById('resizeHandle');
  const panel = document.getElementById('treePanel');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    const layout = panel.parentElement;
    const rect = layout.getBoundingClientRect();
    const width = Math.max(150, Math.min(e.clientX - rect.left, rect.width * 0.5));
    panel.style.width = `${width}px`;
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem('treePanelWidth', panel.offsetWidth);
  }

  const saved = localStorage.getItem('treePanelWidth');
  if (saved) panel.style.width = `${saved}px`;
}

// #endregion RESIZE

// #region INIT

window.addEventListener('popstate', (e) => {
  const id = e.state?.fileId || decodeURIComponent(location.hash.slice(1)) || null;
  selectFile(id, false);
});

document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  initResize();
  bindModalKeys('projectPathInput', 'projectPickerModal', submitProjectPicker);
  // Handle ?project= query param, else restore last-used project from localStorage
  const params = new URLSearchParams(location.search);
  let desiredProject = params.get('project');
  // A hub-pushed project outranks the localStorage recent: initHub() is fire-and-forget at script
  // eval, so hub:project can land before or during this block.
  if (!desiredProject) desiredProject = hubProjectPath || getRecentProjects()[0] || null;
  if (desiredProject) {
    try {
      await putProject(desiredProject);
    } catch {
      if (params.has('project')) showToast('Failed to switch project', 'error');
    }
    // A push that arrived while the PUT above was in flight must still win.
    if (hubProjectPath && hubProjectPath !== desiredProject) {
      try {
        await putProject(hubProjectPath);
      } catch {}
    }
  }
  if (params.has('project')) {
    params.delete('project');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname + location.hash);
  }
  // Retry initial load — server may not be ready yet (e.g. Hub iframe race)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await loadProject();
      break;
    } catch {
      if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      else showToast('Failed to connect to server', 'error');
    }
  }
  if (projectData) addRecentProject(projectData.path);
  await loadData();
  // Restore file selection from hash
  const hash = decodeURIComponent(location.hash.slice(1));
  const hashItem = hash && stackData.find((s) => s.id === hash);
  if (hashItem) {
    selectedFileId = hash;
    expandGroupForItem(hashItem);
    expandItemAncestors(hashItem);
    renderTree();
    renderPreview();
  }
});

// #endregion INIT
