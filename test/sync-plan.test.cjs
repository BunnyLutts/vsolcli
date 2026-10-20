// Unit tests for the pure three-way planner used by sync-guard.mjs.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const load = () => import('../sync-plan.mjs');
const buffers = entries => new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));

async function planWith({ local, remote, base, protectedPaths }) {
  const { planSync, hashBuffer } = await load();
  const baseHashes = new Map(Object.entries(base ?? {}).map(([name, text]) => [name, hashBuffer(Buffer.from(text))]));
  return planSync({ local: buffers(local), remote: buffers(remote), base: baseHashes, protectedPaths: new Set(protectedPaths ?? []) });
}

test('unchanged files are neither pushed nor pulled', async () => {
  const plan = await planWith({ local: { 'main.tex': 'A' }, remote: { 'main.tex': 'A' }, base: { 'main.tex': 'A' } });
  assert.deepEqual(plan.unchanged, ['main.tex']);
  assert.deepEqual(plan.push, []);
  assert.deepEqual(plan.pull, []);
  assert.deepEqual(plan.conflicts, []);
});

test('a local-only change is pushed', async () => {
  const plan = await planWith({ local: { 'main.tex': 'A2' }, remote: { 'main.tex': 'A' }, base: { 'main.tex': 'A' } });
  assert.deepEqual(plan.push, ['main.tex']);
  assert.deepEqual(plan.pull, []);
});

test('a remote-only change is pulled', async () => {
  const plan = await planWith({ local: { 'main.tex': 'A' }, remote: { 'main.tex': 'A2' }, base: { 'main.tex': 'A' } });
  assert.deepEqual(plan.pull, ['main.tex']);
  assert.deepEqual(plan.push, []);
});

test('both sides changing the same file is a conflict, never an overwrite', async () => {
  const plan = await planWith({ local: { 'main.tex': 'local' }, remote: { 'main.tex': 'remote' }, base: { 'main.tex': 'base' } });
  assert.deepEqual(plan.conflicts.map(conflict => conflict.kind), ['both-modified']);
  assert.deepEqual(plan.push, []);
  assert.deepEqual(plan.pull, []);
});

test('both sides converging on identical bytes is not a conflict', async () => {
  const plan = await planWith({ local: { 'main.tex': 'same' }, remote: { 'main.tex': 'same' }, base: { 'main.tex': 'base' } });
  assert.deepEqual(plan.unchanged, ['main.tex']);
  assert.deepEqual(plan.conflicts, []);
});

test('deletions propagate only when the other side did not change', async () => {
  const localDelete = await planWith({ local: {}, remote: { 'old.tex': 'A' }, base: { 'old.tex': 'A' } });
  assert.deepEqual(localDelete.deleteRemote, ['old.tex']);

  const remoteDelete = await planWith({ local: { 'old.tex': 'A' }, remote: {}, base: { 'old.tex': 'A' } });
  assert.deepEqual(remoteDelete.deleteLocal, ['old.tex']);
});

test('delete-versus-edit becomes a conflict instead of deleting work', async () => {
  const localDelete = await planWith({ local: {}, remote: { 'main.tex': 'remote edit' }, base: { 'main.tex': 'base' } });
  assert.deepEqual(localDelete.conflicts.map(conflict => conflict.kind), ['local-deleted-remote-modified']);
  assert.deepEqual(localDelete.deleteRemote, []);

  const remoteDelete = await planWith({ local: { 'main.tex': 'local edit' }, remote: {}, base: { 'main.tex': 'base' } });
  assert.deepEqual(remoteDelete.conflicts.map(conflict => conflict.kind), ['remote-deleted-local-modified']);
  assert.deepEqual(remoteDelete.push, [], 'a conflicted edit must not resurrect the file silently');
});

test('new files on either side are transferred', async () => {
  const plan = await planWith({ local: { 'new-local.tex': 'L' }, remote: { 'new-remote.tex': 'R' }, base: {} });
  assert.deepEqual(plan.push, ['new-local.tex']);
  assert.deepEqual(plan.pull, ['new-remote.tex']);
});

test('two different files created at the same path conflict', async () => {
  const plan = await planWith({ local: { 'new.tex': 'local' }, remote: { 'new.tex': 'remote' }, base: {} });
  assert.deepEqual(plan.conflicts.map(conflict => conflict.kind), ['both-added']);
});

test('unsaved editor buffers are never overwritten or deleted', async () => {
  const pull = await planWith({ local: { 'main.tex': 'A' }, remote: { 'main.tex': 'A2' }, base: { 'main.tex': 'A' }, protectedPaths: ['main.tex'] });
  assert.deepEqual(pull.conflicts.map(conflict => conflict.kind), ['local-unsaved']);
  assert.deepEqual(pull.pull, []);

  const deletion = await planWith({ local: { 'main.tex': 'A' }, remote: {}, base: { 'main.tex': 'A' }, protectedPaths: ['main.tex'] });
  assert.deepEqual(deletion.conflicts.map(conflict => conflict.kind), ['local-unsaved']);
  assert.deepEqual(deletion.deleteLocal, []);

  // Pushing does not touch the local file, so a protected path may still be pushed.
  const push = await planWith({ local: { 'main.tex': 'A2' }, remote: { 'main.tex': 'A' }, base: { 'main.tex': 'A' }, protectedPaths: ['main.tex'] });
  assert.deepEqual(push.push, ['main.tex']);
});

test('bootstrap infers a baseline from lastPull and the remote manifest', async () => {
  const { bootstrapBase } = await load();
  const lastPull = '2026-01-01T00:00:00.000Z';
  const newer = Date.parse(lastPull) + 60_000;
  const older = Date.parse(lastPull) - 60_000;

  // Local was edited after the last pull -> the remote copy is the agreed base.
  const editedLocally = bootstrapBase({
    local: buffers({ 'main.tex': 'local-edit' }),
    remote: buffers({ 'main.tex': 'base' }),
    localMtimes: new Map([['main.tex', newer]]),
    lastPull
  });
  assert.deepEqual([...editedLocally.base.keys()], ['main.tex']);
  assert.equal(editedLocally.baseContent.get('main.tex').toString(), 'base');

  // Remote was edited instead -> the local copy is the agreed base.
  const editedRemotely = bootstrapBase({
    local: buffers({ 'main.tex': 'base' }),
    remote: buffers({ 'main.tex': 'remote-edit' }),
    localMtimes: new Map([['main.tex', older]]),
    lastPull
  });
  assert.equal(editedRemotely.baseContent.get('main.tex').toString(), 'base');

  // Tracked by the manifest, only on the remote -> a local deletion.
  const localDeletion = bootstrapBase({
    local: buffers({}),
    remote: buffers({ 'old.tex': 'base' }),
    manifest: ['old.tex'],
    lastPull
  });
  assert.equal(localDeletion.baseContent.get('old.tex').toString(), 'base');

  // Tracked by the manifest, only locally -> a remote deletion.
  const remoteDeletion = bootstrapBase({
    local: buffers({ 'old.tex': 'base' }),
    remote: buffers({}),
    manifest: ['old.tex'],
    lastPull
  });
  assert.equal(remoteDeletion.baseContent.get('old.tex').toString(), 'base');
});

test('bootstrap without any history prefers the local copy', async () => {
  const { bootstrapBase } = await load();
  const bootstrapped = bootstrapBase({
    local: buffers({ 'main.tex': 'local' }),
    remote: buffers({ 'main.tex': 'remote' }),
    manifest: []
  });
  assert.equal(bootstrapped.baseContent.get('main.tex').toString(), 'remote', 'base=remote makes the local copy look changed, so it is pushed');
  const untrackedLocal = bootstrapBase({ local: buffers({ 'new.tex': 'new' }), remote: buffers({}), manifest: [] });
  assert.equal(untrackedLocal.base.has('new.tex'), false, 'a brand new local file has no baseline yet');
});
