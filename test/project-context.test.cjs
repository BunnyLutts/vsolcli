const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harness, waitFor, isSync, isCompile } = require('./harness.cjs');
const isProjectCommand = call => isSync(call) || isCompile(call) || call.argv.includes('compile');

const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const session = { OVERLEAF_SESSION: 'test-session' };

function fixture(t, { marker, settings = {}, storedSession = session } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-context-'));
  if (marker !== undefined) fs.writeFileSync(path.join(root, '.olcli.json'), marker);
  const h = harness({ projectRoot: root, storedSession, settings });
  t.after(() => { h.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, h };
}

for (const [label, marker] of [
  ['missing', undefined], ['empty metadata', '{}'], ['malformed metadata', '{'],
  ['null metadata', 'null'], ['blank project ID', '{"projectId":" "}']
]) {
  test(`automatic saves and config changes ignore ${label}`, async t => {
    const { h } = fixture(t, { marker });
    h.failNext('sync', { stderr: 'No project specified.\nEither run from a directory with .olcli.json or use --project' });
    h.save('notes.txt');
    h.changeConfig(['olcli.pdfOutput']);
    await settle();
    assert.equal(h.calls.filter(isProjectCommand).length, 0, 'do not launch project commands for an unbound workspace');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.warnings, []);
  });
}

for (const command of ['sync', 'syncAndCompile', 'syncAndCompileCurrent', 'compile', 'resolveConflictsLocal', 'resolveConflictsRemote']) {
  test(`manual ${command} explains how to select a project`, async t => {
    const { h } = fixture(t);
    await h.commands.get('olcli.' + command)();
    await waitFor(() => h.warnings.length > 0, 'the project setup hint');
    assert.match(h.warnings[0], /\.olcli\.json/);
    assert.match(h.warnings[0], /Pull Project/);
    assert.equal(h.calls.filter(isProjectCommand).length, 0, 'preflight should avoid a guaranteed CLI failure');
    assert.deepEqual(h.errors, []);
  });
}

test('saves choose the nearest nested project instead of the workspace container', async t => {
  const { root, h } = fixture(t);
  const nested = path.join(root, 'paper');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '.olcli.json'), JSON.stringify({ projectId: 'a'.repeat(24), projectName: 'Paper' }));
  h.save('paper/main.tex');
  await waitFor(() => h.calls.some(isSync), 'the nested project sync');
  assert.equal(h.calls.find(isSync).options.cwd, nested);
});

test('a nested project takes precedence over an enclosing project', async t => {
  const { root, h } = fixture(t, { marker: '{"projectId":"outer"}' });
  const nested = path.join(root, 'paper');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '.olcli.json'), '{"projectId":"inner"}');
  h.save('paper/main.tex');
  await waitFor(() => h.calls.some(isSync), 'the inner project sync');
  assert.equal(h.calls.find(isSync).options.cwd, nested);
});

test('automatic work rechecks project metadata after the debounce window', async t => {
  const { root, h } = fixture(t, { marker: '{"projectId":"paper"}' });
  h.save('main.tex');
  fs.unlinkSync(path.join(root, '.olcli.json'));
  await settle();
  assert.equal(h.calls.filter(isProjectCommand).length, 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
});

test('queued automatic work retains its quiet missing-project behavior', async t => {
  const { root, h } = fixture(t, { marker: '{"projectId":"paper"}', settings: { autoCompileOnSave: false } });
  h.hold('sync');
  h.save('first.tex');
  await waitFor(() => h.heldCount() === 1, 'the held sync');
  h.save('second.tex');
  await settle();
  fs.unlinkSync(path.join(root, '.olcli.json'));
  h.release();
  await settle();
  assert.equal(h.calls.filter(isSync).length, 1);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
});

test('valid projects still sync after a relevant configuration change', async t => {
  const { h } = fixture(t, { marker: '{"projectId":"paper"}' });
  h.changeConfig(['olcli.pdfOutput']);
  await waitFor(() => h.calls.some(isSync), 'the configuration-triggered sync');
});

test('mapping-only projects still work with the stored-session sidecar', async t => {
  const { root, h } = fixture(t);
  fs.writeFileSync(path.join(root, '.olcli-project.json'), '{"projectId":"paper"}');
  h.save('main.tex');
  await waitFor(() => h.calls.some(isSync), 'the mapped project sync');
  assert.ok(h.calls.find(isSync).argv[0].endsWith('sync-guard.mjs'));
});

test('mapping-only projects do not automatically invoke a CLI that cannot resolve them', async t => {
  const previous = process.env.OVERLEAF_SESSION;
  delete process.env.OVERLEAF_SESSION;
  t.after(() => { if (previous === undefined) delete process.env.OVERLEAF_SESSION; else process.env.OVERLEAF_SESSION = previous; });
  const { root, h } = fixture(t, { storedSession: null });
  fs.writeFileSync(path.join(root, '.olcli-project.json'), '{"projectId":"paper"}');
  h.failNext('sync', { stderr: 'No project specified.' });
  h.save('main.tex');
  await settle();
  assert.equal(h.calls.filter(isProjectCommand).length, 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
});

test('real sync failures in a configured project still notify the user', async t => {
  const { h } = fixture(t, { marker: '{"projectId":"paper"}' });
  h.failNext('sync-guard.mjs', { stderr: 'authentication expired' });
  h.save('main.tex');
  await waitFor(() => h.errors.length > 0, 'the real sync error');
  assert.match(h.errors[0], /authentication expired/);
});
