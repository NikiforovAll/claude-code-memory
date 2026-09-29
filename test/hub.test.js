const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const HUB = 'http://localhost:3540';
const read = (file) => readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

// Runs the vendored SDK and the page's HUB_INTEGRATION region against stub browser globals.
async function loadHub({ search = '' } = {}) {
  const region = /\/\/ #region HUB_INTEGRATION\n([\s\S]*?)\/\/ #endregion/.exec(read('public/app.js'))[1];
  const listeners = { keydown: [], message: [], load: [] };
  const on = (type, fn) => listeners[type]?.push(fn);
  const posted = [];
  const calls = [];
  const parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  const body = { classList: { contains: () => light }, dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  let light = false;
  const context = vm.createContext({
    parent,
    top: parent,
    URL,
    URLSearchParams,
    location: { search },
    console,
    document: { readyState: 'complete', addEventListener: on, body },
    addEventListener: on,
    fetch: async () => ({ json: async () => ({ enabled: true, url: HUB }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0,
    MutationObserver: class {
      observe() {}
    },
    putProject: async (p) => {
      calls.push(['put', p]);
      if (p === 'C:/missing') throw new Error('not a directory');
    },
    showToast: (text, kind) => calls.push(['toast', text, kind]),
    addRecentProject: (p) => calls.push(['recent', p]),
    loadProject: async () => calls.push(['project']),
    loadData: async () => calls.push(['data']),
    setColorTheme: (id) => {
      body.dataset.colorTheme = id;
      calls.push(['color', id]);
    },
    toggleTheme: () => {
      light = !light;
      calls.push(['toggle', light ? 'light' : 'dark']);
    },
  });
  context.window = context;
  vm.runInContext(read('public/vendor/claude-hub-sdk.js'), context);
  vm.runInContext(region, context);
  await tick();

  return {
    calls,
    hubProjectPath: () => vm.runInContext('hubProjectPath', context),
    sent: () => posted.map((p) => p.message),
    press(init) {
      const before = posted.length;
      let prevented = false;
      const e = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', ...init };
      e.preventDefault = () => {
        prevented = true;
      };
      for (const fn of listeners.keydown) fn(e);
      const sent = posted.slice(before).filter((p) => p.message.type === 'hub:keydown');
      return sent.length === 1 && prevented;
    },
    async receive(data, { source = parent, origin = HUB } = {}) {
      for (const fn of listeners.message) fn({ data, source, origin });
      await tick();
    },
  };
}

const KEYS = ['ctrl+alt+p', 'ctrl+alt+w', 'ctrl+alt+ArrowLeft', 'ctrl+alt+ArrowRight', 'alt+1', 'alt+2'];
const WELCOME = { type: 'hub:welcome', protocol: 1, forward: KEYS, themes: [], actions: ['project.memory'] };
const project = (p) => ({ type: 'hub:event', topic: 'project.changed', payload: p && { project: p, encoded: 'C--p', name: 'p' } });
const APPLIED = [['put', 'C:/p'], ['recent', 'C:/p'], ['project'], ['data']];

describe('hub key forwarding', () => {
  it('forwards the old set until the hub sends its keys', async () => {
    const hub = await loadHub();
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
    assert.equal(hub.press({ altKey: true, key: '7', code: 'Digit7' }), true);
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' }), true);
    assert.equal(hub.press({ ctrlKey: true, key: 'q', code: 'KeyQ' }), false);
  });

  for (const [label, message] of [
    ['hub:keys', { type: 'hub:keys', keys: KEYS }],
    ['welcome.forward', WELCOME],
  ]) {
    it(`forwards only the listed combos after ${label}`, async () => {
      const hub = await loadHub();
      await hub.receive(message);
      assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' }), true);
      assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'π', code: 'KeyP' }), true);
      assert.equal(hub.press({ altKey: true, key: '2', code: 'Digit2' }), true);
      assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), false);
      assert.equal(hub.press({ altKey: true, key: '3', code: 'Digit3' }), false);
    });
  }

  it('ignores hub:keys from another origin or frame', async () => {
    const hub = await loadHub();
    await hub.receive({ type: 'hub:keys', keys: [] }, { origin: 'http://evil.example' });
    await hub.receive({ type: 'hub:keys', keys: [] }, { source: {} });
    assert.equal(hub.press({ ctrlKey: true, altKey: true, key: 'q', code: 'KeyQ' }), true);
  });
});

describe('hub messages', () => {
  it('says hello with both topics', async () => {
    const hub = await loadHub();
    const hello = hub.sent().find((m) => m.type === 'hub:hello');
    assert.deepEqual([...hello.subscribes].sort(), ['project.changed', 'theme.changed']);
  });

  it('applies the v1 project once and skips null, then the theme', async () => {
    const hub = await loadHub();
    await hub.receive(WELCOME);
    await hub.receive(project('C:/p'));
    await hub.receive(project('C:/p'));
    await hub.receive(project(null));
    await hub.receive({ type: 'hub:event', topic: 'theme.changed', payload: { theme: 'light', colorTheme: 'nord' } });
    assert.equal(hub.hubProjectPath(), 'C:/p');
    assert.deepEqual(hub.calls, [...APPLIED, ['color', 'nord'], ['toggle', 'light']]);
  });

  it('opens the project.memory project in place, and the next project.changed still applies', async () => {
    const hub = await loadHub();
    await hub.receive(WELCOME);
    await hub.receive(project('C:/p'));
    const action = (params) => hub.receive({ type: 'hub:action', id: 'a', action: 'project.memory', params });
    await action({ project: 'C:/q' });
    await action({});
    await action({ project: 'C:/missing' });
    await hub.receive(project('C:/p'));
    assert.equal(hub.hubProjectPath(), 'C:/p');
    assert.deepEqual(hub.calls, [
      ...APPLIED,
      ['put', 'C:/q'],
      ['recent', 'C:/q'],
      ['project'],
      ['data'],
      ['put', 'C:/missing'],
      ['toast', 'Failed to switch project', 'error'],
      ...APPLIED,
    ]);
  });

  it('keeps a ?project= link over the hub project until the hub moves', async () => {
    const hub = await loadHub({ search: '?project=C%3A%2Fq' });
    await hub.receive({ type: 'hub:project', project: 'C:/p', encoded: 'C--p', name: 'p' });
    await hub.receive({ type: 'hub:project', project: 'C:/p', encoded: 'C--p', name: 'p' });
    assert.equal(hub.hubProjectPath(), null);
    await hub.receive({ type: 'hub:project', project: 'C:/r', encoded: 'C--r', name: 'r' });
    await hub.receive({ type: 'hub:project', project: 'C:/p', encoded: 'C--p', name: 'p' });
    assert.deepEqual(hub.calls, [
      ['put', 'C:/r'],
      ['recent', 'C:/r'],
      ['project'],
      ['data'],
      ...APPLIED,
    ]);
  });

  it('applies the legacy project and theme messages from a hub with no welcome', async () => {
    const hub = await loadHub();
    await hub.receive({ type: 'hub:project', project: 'C:/p', encoded: 'C--p', name: 'p' });
    await hub.receive({ type: 'hub:project', project: null, encoded: null, name: null });
    await hub.receive({ type: 'hub:theme', theme: 'light', colorTheme: 'nord' });
    assert.deepEqual(hub.calls, [...APPLIED, ['color', 'nord'], ['toggle', 'light']]);
  });
});
