// Shared mock extension host for the extension tests.
//
// The extension talks to the outside world through `vscode` and the olcli child
// processes. Both are replaced here: the vscode API by a small object, and the
// child process API by a spawn() that records calls and emits scripted results.
// Each harness gets its own copy of out/extension.js so module-level state
// (timers, the running/pending flags) cannot leak between tests.
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const disposable = () => ({ dispose() {} });
const DEFAULTS = {
  baseUrl: 'https://overleaf.example',
  cookieName: 'overleaf_session2',
  autoRefreshPreview: false,
  debounceMs: 20,
  syncTimeout: 60000,
  compileTimeout: 120000,
  autoSyncInterval: 0,
  servers: [{ id: 's', name: 'overleaf.example', url: 'https://overleaf.example', cookieName: 'overleaf_session2' }]
};

function harness({ projectRoot, storedSession, settings: overrides, warningChoice, quickPickIndex, commandError } = {}) {
  const commands = new Map();
  const opened = [];
  const tabs = [];
  const closedTabs = [];
  const group = { tabs, activeTab: undefined };
  const makeUri = parts => ({ ...parts, toString() { return this.scheme + ':' + (this.fsPath ?? this.path); } });
  const errors = [];
  const warnings = [];
  const calls = [];
  const documents = [];
  const stored = new Map();
  let output = '';
  let onSave;
  let onConfigurationChange;
  if (storedSession) stored.set('olcli:https://overleaf.example', JSON.stringify(storedSession));
  const settings = { ...DEFAULTS, projectRoot, ...overrides };

  const vscode = {
    languages: { createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) },
    ConfigurationTarget: { Workspace: 2, Global: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: class { constructor() { this.event = () => disposable(); } fire() {} },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Range: class {},
    Uri: { file: fsPath => makeUri({ fsPath, scheme: 'file' }), from: makeUri },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    workspace: {
      registerTextDocumentContentProvider: () => disposable(),
      workspaceFolders: [{ uri: { fsPath: projectRoot } }],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, update: async () => {} }),
      fs: { stat: async () => ({}) },
      textDocuments: documents,
      onDidSaveTextDocument: handler => { onSave = handler; return disposable(); },
      onDidChangeConfiguration: handler => { onConfigurationChange = handler; return disposable(); }
    },
    window: {
      onDidChangeActiveTextEditor: () => disposable(),
      tabGroups: { all: [group], activeTabGroup: group, close: async targets => {
        closedTabs.push(...targets);
        for (const tab of targets) { const index = tabs.indexOf(tab); if (index >= 0) tabs.splice(index, 1); }
        if (targets.includes(group.activeTab)) group.activeTab = tabs[0];
        return true;
      } },
      activeTextEditor: { document: { uri: { fsPath: path.join(projectRoot, 'main.tex') } } },
      createOutputChannel: () => ({ ...disposable(), append: text => { output += text; }, appendLine: text => { output += text + '\n'; }, show() {} }),
      registerTreeDataProvider: () => disposable(),
      showInputBox: async () => undefined,
      showQuickPick: async items => quickPickIndex === undefined ? undefined : items[quickPickIndex],
      showOpenDialog: async () => undefined,
      showErrorMessage: text => errors.push(text),
      showWarningMessage: (text, ...items) => { warnings.push(text); return Promise.resolve(items.includes(warningChoice) ? warningChoice : undefined); },
      showInformationMessage() {},
      setStatusBarMessage() {}
    },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); },
      executeCommand: async (...args) => { opened.push(args);
        if (commandError && args[0] === 'vscode.diff') throw new Error(commandError);
        if (args[0] === 'vscode.diff') {
          const tab = { input: new vscode.TabInputTextDiff(args[1], args[2]) };
          tabs.push(tab); group.activeTab = tab;
        } }
    }
  };

  const held = [];
  let holdMatch;
  const failures = [];
  const sidecarResponses = [];

  const spawn = (executable, argv, options) => {
    const call = { executable, argv, options };
    calls.push(call);
    const joined = argv.join(' ');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const finish = () => {
      const failureIndex = failures.findIndex(failure => joined.includes(failure.match));
      if (failureIndex >= 0) {
        const failure = failures.splice(failureIndex, 1)[0];
        if (failure.stderr) child.stderr.emit('data', failure.stderr);
        child.emit('close', failure.code ?? 1);
        return;
      }
      if (argv[0].endsWith('sync-guard.mjs')) {
        const response = sidecarResponses.length
          ? sidecarResponses.shift()
          : { projectId: 'a'.repeat(24), skipped: false, pulled: 0, pushed: 0, deletedRemote: 0, deletedLocal: 0, merged: 0, unchanged: 0, conflicts: [], errors: [] };
        child.stdout.emit('data', JSON.stringify(typeof response === 'function' ? response(call) : response));
      } else if (argv[0].endsWith('compile.mjs')) {
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
    if (holdMatch && joined.includes(holdMatch)) held.push(finish);
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
    delete require.cache[require.resolve('../out/extension.js')];
    extension = require('../out/extension.js');
  } finally {
    Module._load = original;
  }
  extension.activate({
    subscriptions: [],
    secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value) }
  });

  return {
    extension,
    commands,
    calls,
    opened,
    tabs,
    closedTabs,
    errors,
    warnings,
    settings,
    documents,
    /** Fire the save event for a document path. */
    save: relativeOrAbsolute => {
      const file = path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(projectRoot, relativeOrAbsolute);
      onSave({ uri: { fsPath: file, scheme: 'file' } });
    },
    /** Fire the configuration-change event for the given changed keys. */
    changeConfig: changed => {
      if (!onConfigurationChange) return;
      onConfigurationChange({
        affectsConfiguration: section => changed.some(key => key === section || key.startsWith(section + '.') || section.startsWith(key + '.'))
      });
    },
    /** Register a dirty document (unsaved editor buffer) in the project. */
    document: (relative, dirty = true) => {
      const document = { uri: makeUri({ fsPath: path.join(projectRoot, relative), scheme: 'file' }), isDirty: dirty, save: async () => { document.isDirty = false; onSave(document); return true; } };
      documents.push(document);
      return document;
    },
    hold: match => { holdMatch = match; },
    release: () => { const next = held.shift(); if (next) next(); },
    heldCount: () => held.length,
    failNext: (match, options = {}) => failures.push({ match, ...options }),
    sidecar: response => sidecarResponses.push(response),
    dispose: () => {
      documents.length = 0;
      // Settle deliberately held children so their spawnCapture watchdog timers
      // are cleared; otherwise a test that keeps a child in flight would leave a
      // minutes-long timer behind and the test process would not exit.
      for (const finish of held.splice(0)) finish();
      extension.deactivate();
    },
    get output() { return output; }
  };
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

/** Create a temporary project directory with the marker the extension expects. */
function projectDir(prefix, meta = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, '.olcli.json'), JSON.stringify({
    projectId: 'a'.repeat(24),
    projectName: 'Paper',
    lastPull: new Date().toISOString(),
    remoteManifest: [],
    ...meta
  }));
  return directory;
}

/** Calls that ran a sync, whether through sync-guard.mjs or the CLI fallback. */
const isSafeSync = call => call.argv[0].endsWith('sync-guard.mjs');
const isCliSync = call => call.argv.includes('sync');
const isSync = call => isSafeSync(call) || isCliSync(call);
const isCompile = call => call.argv[0].endsWith('compile.mjs') || call.argv.includes('pdf');

module.exports = { harness, tick, waitFor, projectDir, isSafeSync, isCliSync, isSync, isCompile };
