// Regression test for the project tree fetch loop.
//
// VS Code answers onDidChangeTreeData by calling getChildren() again. If
// getChildren() itself triggers a refresh, the two call each other forever and
// hammer the Overleaf server until it answers HTTP 429.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

test('project tree fetches once and does not refetch on refresh events', async () => {
  let provider;
  let listRuns = 0;
  let fires = 0;
  const commands = new Map();
  const disposable = { dispose() {} };
  const settings = {
    servers: [{ id: 'x', name: 'overleaf.example', url: 'https://overleaf.example', cookieName: 'overleaf_session2' }]
  };

  // A real EventEmitter, unlike the no-op mock used elsewhere: VS Code actually
  // subscribes to onDidChangeTreeData, which is what closes the loop.
  class RealEventEmitter {
    constructor() { this.listeners = []; }
    event = fn => { this.listeners.push(fn); return disposable; };
    fire() { fires++; for (const fn of [...this.listeners]) fn(); }
  }

  const vscode = {
    languages: { createDiagnosticCollection: () => disposable },
    ConfigurationTarget: { Workspace: 2, Global: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: RealEventEmitter,
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: {
      registerTextDocumentContentProvider: () => disposable,
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, update: async () => {} }),
      onDidSaveTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable
    },
    window: {
      onDidChangeActiveTextEditor: () => disposable,
      createOutputChannel: () => ({ ...disposable, append() {}, appendLine() {} }),
      registerTreeDataProvider: (id, value) => { provider = value; return disposable; },
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showErrorMessage() {}, showInformationMessage() {}, showWarningMessage() {}, setStatusBarMessage() {}
    },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async () => {}
    }
  };

  const spawn = (executable, args) => {
    if (args.includes('list')) listRuns++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('list')) child.stdout.emit('data', JSON.stringify([{ _id: 'abc123', name: 'My Paper' }]));
      child.emit('close', 0);
    });
    return child;
  };

  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === 'node:child_process') return { spawn };
    return original.call(this, name, ...args);
  };
  let extension;
  try { extension = require('../out/extension.js'); } finally { Module._load = original; }

  extension.activate({ subscriptions: [], secrets: { get: async () => undefined, store: async () => {} } });

  // Stand in for VS Code. The cap keeps a regressed build from spinning forever
  // so the assertion below can report a clean failure instead of hanging.
  provider.onDidChangeTreeData(() => {
    if (fires > 25) return;
    void provider.getChildren();
  });

  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  const afterActivate = listRuns;
  assert.equal(afterActivate, 1, `activation should run olcli list once, ran ${afterActivate}`);
  assert.deepEqual((await provider.getChildren()).map(item => item.server.name), ['overleaf.example']);

  const servers = await provider.getChildren();
  const projects = await provider.getChildren(servers[0]);
  assert.match(provider.getTreeItem(servers[0]).iconPath.light.fsPath, /[\\/]light[\\/]server\.svg$/);
  assert.match(provider.getTreeItem(projects[0]).iconPath.dark.fsPath, /[\\/]dark[\\/]project\.svg$/);
  assert.deepEqual(projects.map(({ id, name }) => ({ id, name })), [{ id: 'abc123', name: 'My Paper' }]);
  await tick();

  assert.equal(listRuns, 1, `tree rendering must not refetch projects, ran olcli list ${listRuns} times`);
  assert.ok(fires <= 1, `a single load should invalidate the tree once, saw ${fires}`);

  // An explicit refresh still fetches.
  await commands.get('olcli.listProjects')();
  assert.equal(listRuns, 2, 'the List Projects command must still refetch');
  extension.deactivate();
});
