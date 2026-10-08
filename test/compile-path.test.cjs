// Verifies the extension compiles the project once per save.
//
// Before: every save ran `olcli pdf` and then `olcli output log`, and each of
// those POSTs /compile — two cloud compiles per save, which is what made request
// timeouts frequent. Now one wrapper run yields both artifacts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function harness({ projectRoot, storedSession }) {
  const commands = new Map();
  const opened = [];
  const errors = [];
  const calls = [];
  let output = '';
  const stored = new Map();
  if (storedSession) stored.set('olcli:https://overleaf.example', JSON.stringify(storedSession));
  const disposable = { dispose() {} };
  const settings = {
    baseUrl: 'https://overleaf.example',
    cookieName: 'overleaf_session2',
    projectRoot,
    autoRefreshPreview: false,
    servers: [{ id: 's', name: 'overleaf.example', url: 'https://overleaf.example', cookieName: 'overleaf_session2' }]
  };

  let onSave;
  const vscode = {
    languages: { createDiagnosticCollection: () => ({ ...disposable, clear() {}, set() {} }) },
    ConfigurationTarget: { Workspace: 2, Global: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: class { event = () => disposable; fire() {} },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Range: class {},
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: projectRoot } }],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, update: async () => {} }),
      fs: { stat: async () => ({}) },
      onDidSaveTextDocument: handler => { onSave = handler; return disposable; },
      onDidChangeConfiguration: () => disposable
    },
    window: {
      activeTextEditor: { document: { uri: { fsPath: path.join(projectRoot, 'main.tex') } } },
      createOutputChannel: () => ({ ...disposable, append: text => { output += text; }, appendLine: text => { output += text + '\n'; }, show() {} }),
      registerTreeDataProvider: () => disposable,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showErrorMessage: text => errors.push(text),
      showInformationMessage() {}, showWarningMessage() {}, setStatusBarMessage() {}
    },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async (...args) => { opened.push(args); }
    }
  };

  const held = [];
  let holdMatch;
  const spawn = (executable, argv, options) => {
    calls.push({ executable, argv, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const finish = () => {
      // argv is [cli.js, ...] for the real CLI, or [compile.mjs, baseUrl, cookieName, timeout, pdfPath, resource].
      if (argv[0].endsWith('compile.mjs')) {
        const pdfPath = argv[4];
        fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
        fs.writeFileSync(pdfPath, '%PDF-1.5 fake');
        fs.writeFileSync(pdfPath.replace(/\.pdf$/, '.log'), 'main.tex:3: Undefined control sequence.\n');
        child.stdout.emit('data', JSON.stringify({ status: 'success', pdf: true, log: true }));
      } else if (argv.includes('output')) {
        fs.writeFileSync(argv[argv.indexOf('-o') + 1], 'main.tex:3: Undefined control sequence.\n');
      }
      child.emit('close', 0);
    };
    // `hold` keeps matching commands in flight so a test can act mid-run.
    if (holdMatch && argv.join(' ').includes(holdMatch)) held.push(finish);
    else queueMicrotask(finish);
    return child;
  };

  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === 'node:child_process') return { spawn };
    return original.call(this, name, ...args);
  };
  let extension;
  try {
    // Each harness needs its own module instance, otherwise the extension keeps the
    // vscode mock bound at first load.
    delete require.cache[require.resolve('../out/extension.js')];
    extension = require('../out/extension.js');
  } finally { Module._load = original; }
  extension.activate({ subscriptions: [], secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value) } });
  return { extension, commands, calls, opened, errors, settings, save: doc => onSave(doc),
    hold: match => { holdMatch = match; }, release: () => { const next = held.shift(); if (next) next(); },
    heldCount: () => held.length, get output() { return output; } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function projectDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, '.olcli.json'), JSON.stringify({ projectId: 'a'.repeat(24), projectName: 'Paper' }));
  return dir;
}

test('a save compiles once and gets the log from that same compile', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-save-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    await h.commands.get('olcli.syncAndCompileCurrent')();
    // Wait on either path so a regression reports the real problem below rather
    // than timing out here.
    await waitFor(() => h.calls.some(call => call.argv[0].endsWith('compile.mjs') || call.argv.includes('pdf')), 'a compile step');

    const wrapperCalls = h.calls.filter(call => call.argv[0].endsWith('compile.mjs'));
    assert.equal(wrapperCalls.length, 1, `expected one compile wrapper run, saw ${wrapperCalls.length}`);

    // The regression: no second cloud compile via `olcli pdf` / `olcli output log`.
    assert.equal(h.calls.filter(call => call.argv.includes('pdf')).length, 0, 'must not run olcli pdf');
    assert.equal(h.calls.filter(call => call.argv.includes('output')).length, 0, 'must not run olcli output log');
    assert.equal(h.calls.filter(call => call.argv.includes('sync')).length, 1, 'sync should still run exactly once');

    const [wrapper] = wrapperCalls;
    assert.equal(wrapper.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(wrapper.options.env.OVERLEAF_SESSION, 'test-session');
    assert.ok(Number(wrapper.argv[3]) >= 1000, `compile timeout should be raised, saw ${wrapper.argv[3]}`);
    assert.ok(fs.existsSync(path.join(root, '.build', 'main.log')), 'the log from the single compile should be on disk');
    assert.ok(!h.output.includes('test-session'), 'must not echo the session cookie');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without a stored session the CLI fallback still compiles', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-fallback-');
  try {
    const h = harness({ projectRoot: root, storedSession: undefined });
    await h.commands.get('olcli.syncAndCompileCurrent')();
    await waitFor(() => h.calls.some(call => call.argv.includes('pdf')), 'the CLI pdf fallback');

    assert.equal(h.calls.filter(call => call.argv.includes('pdf')).length, 1);
    assert.equal(h.calls.filter(call => call.argv.includes('output')).length, 1);
    assert.equal(h.calls.filter(call => call.argv[0].endsWith('compile.mjs')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saving a .tex file triggers sync automatically', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-save-trigger-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    h.save({ uri: { fsPath: path.join(root, 'main.tex') } });
    await waitFor(() => h.calls.some(call => call.argv.includes('sync')), 'the debounced sync', 4000);
    assert.equal(h.calls.filter(call => call.argv.includes('sync')).length, 1, 'save should sync once');
    assert.ok(h.output.includes('saved:'), 'the save handler should log the save');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a save during a long run is coalesced, not dropped', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-coalesce-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    h.settings.debounceMs = 20;
    h.hold('sync');
    h.save({ uri: { fsPath: path.join(root, 'a.tex') } });
    await waitFor(() => h.heldCount() === 1, 'the first sync to be held');
    assert.equal(h.calls.filter(call => call.argv.includes('sync')).length, 1);

    // Wait past the run's own suppression window, then save again mid-run. The old
    // handler returned early on `running`, so this save was discarded and the edit
    // was never synced.
    await new Promise(resolve => setTimeout(resolve, 3200));
    h.save({ uri: { fsPath: path.join(root, 'b.tex') } });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(h.output.includes('saved:'), 'a mid-run save must still be accepted');

    h.release();
    await waitFor(() => h.calls.filter(call => call.argv.includes('sync')).length === 2, 'the coalesced second sync', 4000);
    assert.equal(h.calls.filter(call => call.argv.includes('sync')).length, 2, 'exactly one coalesced re-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a compile that never exits is aborted instead of wedging sync', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-watchdog-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    h.settings.debounceMs = 20;
    h.settings.compileTimeout = 1000; // watchdog = compileTimeout * 4
    h.hold('compile.mjs');            // the wrapper never exits
    h.save({ uri: { fsPath: path.join(root, 'main.tex') } });

    await waitFor(() => h.errors.some(text => /did not finish/.test(text)), 'the watchdog to abort the compile', 8000);
    // If `running` were still set, the command would be swallowed and no sync would follow.
    const before = h.calls.filter(call => call.argv.includes('sync')).length;
    await h.commands.get('olcli.syncAndCompileCurrent')();
    await waitFor(() => h.calls.filter(call => call.argv.includes('sync')).length > before, 'a follow-up run', 4000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
