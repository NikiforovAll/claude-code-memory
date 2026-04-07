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

function removeRecentProject(p, e) {
  e.stopPropagation();
  const recent = getRecentProjects().filter((r) => r !== p);
  localStorage.setItem('recentProjects', JSON.stringify(recent));
  renderRecentProjects();
}

function selectRecentProject(p) {
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
          `<div class="recent-project-item" onclick="selectRecentProject('${escJs(p)}')">` +
          `<span>${esc(p)}</span>` +
          `<button class="recent-project-remove" onclick="removeRecentProject('${escJs(p)}', event)" title="Remove">&#10005;</button>` +
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

const SCOPE_ORDER = ['policy', 'user', 'project', 'rule', 'memory'];
const SCOPE_LABELS = {
  policy: 'Managed Policy',
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
  import: '\u2192',
};
const LOAD_TITLES = {
  always: 'Always loaded',
  startup: 'Loaded at startup (partial)',
  conditional: 'Conditional (path-scoped)',
  ondemand: 'On-demand',
  import: 'Imported by parent file',
};

function renderTree() {
  const container = document.getElementById('treeContent');
  if (!stackData.length) {
    container.innerHTML =
      '<div class="loading-state" style="padding:20px;font-size:11px;color:var(--text-muted)">No memory sources found</div>';
    return;
  }

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

  function renderItem(item, indent) {
    const sel = selectedFileId === item.id ? ' selected' : '';
    const loadIcon = LOAD_ICONS[item.load] || '';
    const loadTitle = LOAD_TITLES[item.load] || item.load;
    const meta = `${item.lines}L`;
    const pad = indent ? ' style="padding-left:' + (12 + indent * 16) + 'px"' : '';
    let h = `<div class="tree-item${sel}${indent ? ' tree-child' : ''}" data-id="${esc(item.id)}" title="${esc(item.path)}" onclick="selectFile('${escJs(item.id)}')"${pad}>`;
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

function selectFile(id) {
  selectedFileId = selectedFileId === id ? null : id;
  renderTree();
  renderPreview();
}

function getSelectedIndex() {
  if (!stackData.length) return -1;
  return stackData.findIndex((s) => s.id === selectedFileId);
}

function navigateTree(direction) {
  if (!stackData.length) return;
  let idx = getSelectedIndex();
  if (idx === -1) {
    idx = direction > 0 ? 0 : stackData.length - 1;
  } else {
    idx += direction;
    if (idx < 0) idx = stackData.length - 1;
    if (idx >= stackData.length) idx = 0;
  }
  selectedFileId = stackData[idx].id;
  renderTree();
  renderPreview();
  const el = document.querySelector(`.tree-item[data-id="${selectedFileId}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// #endregion RENDER_TREE

// #region RENDER_PREVIEW

async function renderPreview() {
  const panel = document.getElementById('previewPanel');
  const source = stackData.find((s) => s.id === selectedFileId);
  if (!source) {
    panel.innerHTML =
      '<div class="preview-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 20 12 22c0-2-1-2.5-3-4.5S5 12 5 9a7 7 0 017-7z"/></svg><span>Select a file to preview</span></div>';
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
  html += `<button class="action-btn small" onclick="openInEditor('${escJs(source.path)}')" title="Open in VS Code">Open</button>`;
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
  if (source.scope === 'memory' && source.load === 'startup' && source.maxLines) {
    html += `<span class="tag-badge">${source.lines}/${source.maxLines} lines used</span>`;
  }
  html += '</div>';

  // Imports
  if (fileData.imports && fileData.imports.length) {
    html += '<div class="preview-imports">';
    for (const imp of fileData.imports) {
      html += `<a class="import-link" href="#" onclick="navigateToImport('${escJs(imp)}');return false">@${esc(imp)}</a>`;
    }
    html += '</div>';
  }

  html += '</div>';

  // File path
  html += `<div class="preview-filepath">${esc(source.path)}</div>`;

  // Content — with cutoff line for auto memory startup files
  const content = fileData.content || '';
  if (source.scope === 'memory' && source.load === 'startup' && source.maxLines) {
    const lines = content.split('\n');
    const cutoff = source.maxLines;
    if (lines.length > cutoff) {
      const before = lines.slice(0, cutoff).join('\n');
      const after = lines.slice(cutoff).join('\n');
      const hlBefore = highlightSource(before, source.name);
      const hlAfter = highlightSource(after, source.name);
      html += `<pre class="preview-code"><code>${hlBefore}</code></pre>`;
      html += `<div class="cutoff-line"><span class="cutoff-label">Cutoff: ${cutoff} lines / loaded at startup</span></div>`;
      html += `<pre class="preview-code preview-code-faded"><code>${hlAfter}</code></pre>`;
    } else {
      html += `<pre class="preview-code"><code>${highlightSource(content, source.name)}</code></pre>`;
    }
  } else {
    html += `<pre class="preview-code"><code>${highlightSource(content, source.name)}</code></pre>`;
  }

  panel.innerHTML = html;
}

function formatBytes(b) {
  if (b < 1024) return b + 'B';
  return (b / 1024).toFixed(1) + 'KB';
}

async function openInEditor(filePath) {
  try {
    const res = await fetch('/api/open-in-editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function navigateToImport(importPath) {
  const source = stackData.find((s) => s.path === importPath);
  if (source) {
    selectedFileId = source.id;
    renderTree();
    renderPreview();
  } else {
    showToast('Import target not in stack: ' + importPath, 'error');
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
  document.getElementById('budgetText').textContent = `${summaryData.totalLines.toLocaleString()} lines / ${formatBytes(summaryData.totalBytes)}`;

  // Budget segments — proportional by lines per scope
  const segContainer = document.getElementById('budgetSegments');
  if (!stackData.length) { segContainer.innerHTML = ''; return; }

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
    [stackData, summaryData] = await Promise.all([
      fetchJSON('/api/stack'),
      fetchJSON('/api/summary'),
    ]);
    renderTree();
    renderBudget();
    if (!selectedFileId) {
      const proj = stackData.find((s) => s.scope === 'project' && s.name === 'CLAUDE.md');
      const user = stackData.find((s) => s.scope === 'user' && s.name === 'CLAUDE.md');
      const auto = proj || user;
      if (auto) selectedFileId = auto.id;
    }
    if (selectedFileId) { renderTree(); renderPreview(); }
  } catch (err) {
    showToast('Failed to load: ' + err.message, 'error');
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
  if (e.key === '?' || e.key === '/') {
    e.preventDefault();
    toggleHelpModal();
  }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); navigateTree(1); }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); navigateTree(-1); }
  if (e.key === 'Enter' && selectedFileId) renderPreview();
  if (e.key === 'e' && selectedFileId) {
    const s = stackData.find((x) => x.id === selectedFileId);
    if (s) openInEditor(s.path);
  }
});

// #endregion KEYBOARD

// #region HUB_INTEGRATION

async function detectHub() {
  try {
    const res = await fetch('/hub-config');
    if (res.ok) window.__HUB__ = true;
  } catch {
    /* not in hub */
  }
}

// #endregion HUB_INTEGRATION

// #region INIT

document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  bindModalKeys('projectPathInput', 'projectPickerModal', submitProjectPicker);
  await detectHub();
  await loadProject();
  addRecentProject(projectData.path);
  await loadData();
});

// #endregion INIT
