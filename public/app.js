// #region STATE

let projectData = null;
let stackData = [];
let summaryData = null;
let selectedFileId = null;

// #endregion STATE

// #region UTILS

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escJs(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
        return `<span class="hl-frontmatter">---</span>\n${fmHtml}\n<span class="hl-frontmatter">---</span>\n${bodyHtml}`;
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
      `<a class="inline-import" href="#" onclick="selectFile('${escJs(child.id)}');return false" title="${esc(child.path)}">${esc(display)}</a>`,
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

function loadTheme() {
  if (localStorage.getItem('theme') === 'light') document.body.classList.add('light');
  syncHljsTheme();
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
    const res = await fetch('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error, 'error');
      return;
    }
    closeModal('projectPickerModal');
    addRecentProject(dirPath);
    await loadProject();
    await loadData();
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
          `<div class="recent-project-item" onclick="_selectRecentProject('${escJs(p)}')">` +
          `<span>${esc(p)}</span>` +
          `<button class="recent-project-remove" onclick="_removeRecentProject('${escJs(p)}', event)" title="Remove">&#10005;</button>` +
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

const SCOPE_ORDER = ['policy', 'user', 'user-memory', 'project', 'rule', 'memory'];
const SCOPE_LABELS = {
  policy: 'Managed Policy',
  'user-memory': 'User Memory',
  user: 'User',
  project: 'Project',
  rule: 'Rules',
  memory: 'Auto Memory',
};
const LOAD_ICONS = {
  always: '\u25CF',
  startup: '\u25D2',
  conditional: '\u25CB',
  ondemand: '\u25CC',
  import: '@',
};
const LOAD_TITLES = {
  always: 'Always loaded',
  startup: 'Loaded at startup (partial)',
  conditional: 'Conditional (path-scoped)',
  ondemand: 'On-demand',
  import: 'Imported by parent file',
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
  const navOrder = [];
  function collect(item) {
    navOrder.push(item);
    const children = childrenOf[item.id];
    if (children) for (const c of children) collect(c);
  }
  for (const scope of SCOPE_ORDER) {
    const items = groups[scope];
    if (items) for (const item of items) collect(item);
  }
  treeIndex = { groups, childrenOf, navOrder };
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
    const isConditional = item.load === 'conditional' || item.load === 'ondemand';
    const pad = indent ? ` style="padding-left:${12 + indent * 16}px"` : '';
    let h = `<div class="tree-item${sel}${indent ? ' tree-child' : ''}${isConditional ? ' tree-conditional' : ''}" data-id="${esc(item.id)}" title="${esc(item.path)}" onclick="selectFile('${escJs(item.id)}')"${pad}>`;
    h += `<span class="load-icon" title="${loadTitle}" style="color:var(--scope-${item.scope})">${loadIcon}</span>`;
    h += `<span class="file-name">${esc(item.name)}</span>`;
    h += `<span class="file-meta">${meta}</span>`;
    h += '</div>';
    const children = childrenOf[item.id];
    if (children) {
      for (const child of children) h += renderItem(child, (indent || 0) + 1);
    }
    return h;
  }

  let html = '';
  for (const scope of SCOPE_ORDER) {
    const items = groups[scope];
    if (!items) continue;
    const label = SCOPE_LABELS[scope] || scope;
    html += `<div class="tree-group-header"><span class="scope-dot" style="color:var(--scope-${scope})">\u25CF</span> ${esc(label)} <span style="opacity:0.5">${items.length}</span></div>`;
    for (const item of items) html += renderItem(item, 0);
  }
  container.innerHTML = html;
}

function pushFileState(id) {
  const url = id ? `#${encodeURIComponent(id)}` : location.pathname;
  history.pushState({ fileId: id }, '', url);
}

function selectFile(id, pushState = true) {
  selectedFileId = selectedFileId === id ? null : id;
  if (pushState) pushFileState(selectedFileId);
  renderTree();
  renderPreview();
}

function scrollToSelected() {
  const el = document.querySelector(`.tree-item[data-id="${selectedFileId}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function navigateTree(direction) {
  const { navOrder } = getTreeIndex();
  if (!navOrder.length) return;
  let idx = navOrder.findIndex((s) => s.id === selectedFileId);
  if (idx === -1) {
    idx = direction > 0 ? 0 : navOrder.length - 1;
  } else {
    idx += direction;
    if (idx < 0) idx = navOrder.length - 1;
    if (idx >= navOrder.length) idx = 0;
  }
  selectedFileId = navOrder[idx].id;
  pushFileState(selectedFileId);
  renderTree();
  renderPreview();
  scrollToSelected();
}

function navigateGroup(direction) {
  const { groups } = getTreeIndex();
  const activeScopes = SCOPE_ORDER.filter((sc) => groups[sc]?.length);
  if (!activeScopes.length) return;

  const current = stackData.find((s) => s.id === selectedFileId);
  const currentScope = current?.parentId ? stackData.find((s) => s.id === current.parentId)?.scope : current?.scope;
  let scopeIdx = activeScopes.indexOf(currentScope);
  if (scopeIdx === -1) {
    scopeIdx = direction > 0 ? 0 : activeScopes.length - 1;
  } else {
    scopeIdx += direction;
    if (scopeIdx < 0) scopeIdx = activeScopes.length - 1;
    if (scopeIdx >= activeScopes.length) scopeIdx = 0;
  }
  selectedFileId = groups[activeScopes[scopeIdx]][0].id;
  pushFileState(selectedFileId);
  renderTree();
  renderPreview();
  scrollToSelected();
}

// #endregion RENDER_TREE

// #region MEMORY_INDEX

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
      ? `<a class="import-link" href="#" onclick="selectFile('${escJs(child.id)}');return false" title="${esc(child.path)}">${esc(entry.name)}</a>`
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
  html += `<button class="action-btn small" onclick="openInEditor('${escJs(source.path)}')" title="Open in VS Code"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M17.583 2.207a1.1 1.1 0 0 1 1.541.033l2.636 2.636a1.1 1.1 0 0 1 .033 1.541L10.68 17.53a1.1 1.1 0 0 1-.345.247l-4.56 1.903a.55.55 0 0 1-.725-.725l1.903-4.56a1.1 1.1 0 0 1 .247-.345zm.902 1.87-8.794 8.793-.946 2.268 2.268-.946 8.794-8.793z"/></svg></button>`;
  html += '</div>';

  // Badges row
  html += '<div class="preview-badges">';
  html += `<span class="load-badge load-${source.load}">${esc(source.load)}</span>`;
  html += `<span class="tag-badge">${source.lines}L / ${formatBytes(source.bytes)}</span>`;
  if (fileData.frontmatter) {
    for (const [k, v] of Object.entries(fileData.frontmatter)) {
      const val = Array.isArray(v) ? v.join(', ') : v;
      html += `<span class="tag-badge">${esc(k)}: ${esc(String(val))}</span>`;
    }
  }
  html += '</div>';

  // Imports — only show children (files that have this source as parent)
  const children = stackData.filter((s) => s.parentId === source.id);
  const unresolved = source.unresolvedImports || [];
  if (children.length || unresolved.length) {
    html += '<div class="preview-imports">';
    for (const child of children) {
      html += `<a class="import-link" href="#" onclick="selectFile('${escJs(child.id)}');return false" title="${esc(child.path)}">${esc(child.name)}</a>`;
    }
    for (const u of unresolved) {
      html += `<span class="import-link unresolved" title="Not found: ${esc(u)}">⚠ ${esc(u)}</span>`;
    }
    html += '</div>';
  }

  html += '</div>';

  // File path
  html += `<div class="preview-filepath">${esc(source.path)}</div>`;

  // Content — with cutoff line for auto memory startup files
  const content = fileData.content || '';
  const hl = (text) => {
    const { text: processed, placeholders } = linkifyImports(text, source.id);
    return restorePlaceholders(highlightSource(processed, source.name), placeholders);
  };

  // Memory index view — render structured table for MEMORY.md index files
  if ((source.scope === 'memory' || source.scope === 'user-memory') && source.name === 'MEMORY.md') {
    const entries = parseMemoryIndex(content);
    if (entries.length) {
      html += renderMemoryIndexTable(entries);
    }
  }

  if ((source.scope === 'memory' || source.scope === 'user-memory') && source.load === 'startup' && source.maxLines) {
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

// #region RENDER_BUDGET

function renderBudget() {
  if (!summaryData) return;

  // Summary stat cards
  document.getElementById('statFiles').textContent = summaryData.totalFiles;
  document.getElementById('statLines').textContent = summaryData.totalLines.toLocaleString();
  document.getElementById('statBytes').textContent = formatBytes(summaryData.totalBytes);
  document.getElementById('statAlways').textContent = summaryData.alwaysLoaded;

  // Budget text
  document.getElementById('budgetText').textContent =
    `${summaryData.totalLines.toLocaleString()} lines / ${formatBytes(summaryData.totalBytes)}`;

  // Budget segments — proportional by lines per scope
  const segContainer = document.getElementById('budgetSegments');
  if (!stackData.length) {
    segContainer.innerHTML = '';
    return;
  }

  const scopeTotals = {};
  for (const s of stackData) {
    scopeTotals[s.scope] = (scopeTotals[s.scope] || 0) + (s.lines || 0);
  }
  const totalLines = summaryData.totalLines || 1;
  let html = '';
  for (const scope of SCOPE_ORDER) {
    const lines = scopeTotals[scope];
    if (!lines) continue;
    const pct = (lines / totalLines) * 100;
    html += `<div class="budget-segment" style="width:${pct}%;background:var(--scope-${scope})" title="${SCOPE_LABELS[scope] || scope}: ${lines} lines (${pct.toFixed(1)}%)"></div>`;
  }
  segContainer.innerHTML = html;
}

// #endregion RENDER_BUDGET

// #region DATA

async function loadData() {
  try {
    [stackData, summaryData] = await Promise.all([fetchJSON('/api/stack'), fetchJSON('/api/summary')]);
    invalidateTreeIndex();
    renderTree();
    renderBudget();
    if (!selectedFileId) {
      const proj = stackData.find((s) => s.scope === 'project' && s.name === 'CLAUDE.md');
      const user = stackData.find((s) => s.scope === 'user' && s.name === 'CLAUDE.md');
      const auto = proj || user;
      if (auto) selectedFileId = auto.id;
    }
    if (selectedFileId) {
      renderTree();
      renderPreview();
    }
  } catch (err) {
    showToast(`Failed to load: ${err.message}`, 'error');
  }
}

async function refreshData() {
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    showToast('Refreshed', 'success');
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
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateTree(1);
  }
  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    navigateTree(-1);
  }
  if (e.key === 'h' || e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateGroup(-1);
  }
  if (e.key === 'l' || e.key === 'ArrowRight') {
    e.preventDefault();
    navigateGroup(1);
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
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      window.parent?.postMessage({ type: 'hub:keydown', key: e.key }, '*');
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      window.parent?.postMessage({ type: 'hub:keydown', key: e.key }, '*');
    }
  });
})();

function _hubNavigate(app, url) {
  if (!window.__HUB__?.enabled) return;
  window.parent?.postMessage({ type: 'hub:navigate', app, url }, '*');
}

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
  // Handle ?project= query param
  const params = new URLSearchParams(location.search);
  if (params.has('project')) {
    const projectPath = params.get('project');
    try {
      const res = await fetch('/api/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      if (!res.ok) showToast('Failed to switch project', 'error');
    } catch {}
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
  if (hash && stackData.find((s) => s.id === hash)) {
    selectedFileId = hash;
    renderTree();
    renderPreview();
  }
});

// #endregion INIT
