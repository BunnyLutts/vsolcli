const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');

test('self-hosted login, project tree, pull and authentication failures', async () => {
  const commands = new Map();
  const stored = new Map();
  const calls = [];
  const errors = [];
  const opened = [];
  const settings = { baseUrl: 'https://old.example', cookieName: 'overleaf_session2' };
  const latexSettings = { 'latex.autoBuild.run': 'onFileChange' };
  let inputs = [];
  let method = 'Session cookie';
  let provider;
  let fail = false;
  let output = '';
  const disposable = { dispose() {} };
  const vscode = {
    languages: { createDiagnosticCollection: () => disposable },
    ConfigurationTarget: { Workspace: 2, Global: 1 },
    TreeItemCollapsibleState: { None: 0 },
    TreeItem: class { constructor(label) { this.label = label; } },
    EventEmitter: class { event = () => disposable; fire() {} },
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: section => {
        const values = section === 'latex-workshop' ? latexSettings : settings;
        return { get: (key, fallback) => values[key] ?? fallback, update: async (key, value) => { values[key] = value; } };
      },
      onDidSaveTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable
    },
    window: {
      createOutputChannel: () => ({ ...disposable, append: text => { output += text; }, appendLine: text => { output += text; } }),
      registerTreeDataProvider: (id, value) => { provider = value; return disposable; },
      showInputBox: async () => inputs.shift(),
      showOpenDialog: async () => [{ fsPath: inputs.shift() }],
      showQuickPick: async choices => typeof choices[0] === 'string' ? method : choices[0],
      showErrorMessage: text => errors.push(text),
      showInformationMessage() {}, showWarningMessage() {}, setStatusBarMessage() {}
    },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
      executeCommand: async (...args) => opened.push(args)
    }
  };
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (!fail && args[0].endsWith('auth.mjs')) child.stdout.emit('data', JSON.stringify({ projects: [], session: { name: 'overleaf.sid', value: options.env.OVERLEAF_SESSION ?? 'password-session' } }));
      if (!fail && args.includes('list')) child.stdout.emit('data', JSON.stringify([{ _id: 'abc123', name: 'My Paper' }]));
      child.emit('close', fail ? 1 : 0);
    });
    return child;
  };
  const original = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === 'node:child_process') return { spawn };
    return original.call(this, name, ...args);
  };
  let extension;
  try { extension = require('../out/extension.js'); } finally { Module._load = original; }
  extension.activate({ subscriptions: [], secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(latexSettings['latex.autoBuild.run'], 'never');
  inputs = ['https://custom.example/', 'overleaf.sid=private-cookie'];
  await commands.get('olcli.login')();
  assert.equal(settings.baseUrl, 'https://custom.example');
  assert.equal(settings.cookieName, 'overleaf.sid');
  assert.equal(JSON.parse(stored.get('olcli:https://custom.example')).OVERLEAF_SESSION, 'private-cookie');
  const request = calls.find(call => call.options.env.OVERLEAF_SESSION === 'private-cookie');
  assert.equal(request.executable, process.execPath);
  assert.equal(request.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(request.args[0].endsWith('auth.mjs'));
  assert.deepEqual(request.args.slice(1), ['https://custom.example', 'overleaf.sid']);
  assert.ok(!request.args.includes('private-cookie'));
  assert.ok(!output.includes('private-cookie'));
  const servers = await provider.getChildren();
  assert.equal(servers.length, 1);
  const projects = await provider.getChildren(servers[0]);
  assert.deepEqual(projects.map(({ id, name }) => ({ id, name })), [{ id: 'abc123', name: 'My Paper' }]);
  assert.equal(provider.getTreeItem(projects[0]).command.command, 'olcli.pullProject');
  inputs = [process.cwd()];
  await commands.get('olcli.pullProject')(projects[0]);
  const pull = calls.find(call => call.args.includes('pull'));
  assert.equal(pull.args[pull.args.indexOf('pull') + 1], 'abc123');
  assert.equal(pull.options.env.OVERLEAF_SESSION, 'private-cookie');
  assert.equal(opened[0][0], 'vscode.openFolder');
  method = 'Email and password';
  inputs = ['https://password.example', 'user@example.com', 'private-password'];
  await commands.get('olcli.login')();
  const passwordRequest = calls.find(call => call.options.env.OVERLEAF_PASSWORD === 'private-password');
  assert.ok(passwordRequest.args[0].endsWith('auth.mjs'));
  assert.deepEqual(JSON.parse(stored.get('olcli:https://password.example')), { OVERLEAF_SESSION: 'password-session' });
  assert.equal(passwordRequest.options.env.OVERLEAF_SESSION, undefined);
  assert.ok(!output.includes('private-password'));
  fail = true;
  inputs = ['https://invalid.example', 'user@example.com', 'wrong'];
  await commands.get('olcli.login')();
  assert.equal(settings.baseUrl, 'https://password.example');
  assert.equal(stored.has('olcli:https://invalid.example'), false);
  await commands.get('olcli.listProjects')();
  assert.deepEqual(await provider.getChildren(), []);
  assert.ok(errors.length >= 2);
  extension.deactivate();
});
