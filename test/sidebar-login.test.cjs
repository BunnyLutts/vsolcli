const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('empty Projects sidebar offers a standalone login button without context prerequisites', () => {
  const view = manifest.contributes.views.olcli.find(view => view.id === 'olcli.projects');
  assert.ok(view);
  const welcome = manifest.contributes.viewsWelcome?.find(entry => entry.view === view.id);
  assert.ok(welcome, 'empty project tree needs a visible login entry, not just a title icon');
  assert.equal(welcome.when, undefined, 'login must remain available on first use and after a failed refresh');
  // VS Code renders a command link as a button only when it is alone on a line.
  assert.match(welcome.contents, /^\[Login to Overleaf\]\(command:olcli\.login\)$/m);
  assert.match(welcome.contents, /command:olcli\.listProjects/);
  for (const [, id] of welcome.contents.matchAll(/\(command:([\w.]+)\)/g)) {
    const command = manifest.contributes.commands.find(command => command.command === id);
    assert.ok(command, `welcome command ${id} must be contributed`);
    assert.equal(command.enablement, undefined, `${id} must work without a configured project`);
  }
});

test('login stays available in the Projects title bar when the tree is populated', () => {
  const action = manifest.contributes.menus['view/title'].find(action => action.command === 'olcli.login');
  assert.equal(action.when, 'view == olcli.projects');
  assert.match(action.group, /^navigation(?:@\d+)?$/);
  const command = manifest.contributes.commands.find(command => command.command === action.command);
  for (const theme of ['light', 'dark']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', command.icon[theme])), `${theme} login icon must exist`);
  }
});
