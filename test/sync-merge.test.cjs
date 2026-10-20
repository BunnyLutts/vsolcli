// Unit tests for the git-backed three-way merge used on content conflicts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');

const load = () => import('../sync-merge.mjs');

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const text = value => Buffer.from(value);
const BASE = 'alpha\nbravo\ncharlie\ndelta\necho\n';

test('non-overlapping edits merge cleanly', async () => {
  const { mergeThreeWay } = await load();
  const result = mergeThreeWay({
    base: text(BASE),
    local: text(BASE.replace('alpha', 'alpha local')),
    remote: text(BASE.replace('echo', 'echo remote'))
  });
  assert.equal(result.conflict, false);
  assert.equal(result.merged.toString(), BASE.replace('alpha', 'alpha local').replace('echo', 'echo remote'));
});

test('overlapping edits are reported as conflicts, not guessed', async () => {
  const { mergeThreeWay } = await load();
  const result = mergeThreeWay({
    base: text(BASE),
    local: text(BASE.replace('bravo', 'bravo local')),
    remote: text(BASE.replace('bravo', 'bravo remote'))
  });
  assert.equal(result.conflict, true);
  assert.equal(result.reason, 'overlap');
  assert.equal(result.merged, undefined);
});

test('binary files are never merged as text', async () => {
  const { mergeThreeWay } = await load();
  const result = mergeThreeWay({
    base: Buffer.from([0, 1, 2]),
    local: Buffer.from([0, 1, 3]),
    remote: Buffer.from([0, 1, 4])
  });
  assert.equal(result.conflict, true);
  assert.equal(result.reason, 'binary');
});

test('a missing baseline disables automatic merging', async () => {
  const { mergeThreeWay } = await load();
  const result = mergeThreeWay({ local: text('a\n'), remote: text('b\n') });
  assert.equal(result.conflict, true);
  assert.equal(result.reason, 'missing-side');
});

test('git-backed clean merge matches a real git checkout', { skip: !hasGit() && 'git is not installed' }, async () => {
  const { mergeThreeWay } = await load();
  const result = mergeThreeWay({
    base: text('1\n2\n3\n4\n5\n6\n7\n8\n'),
    local: text('one\n2\n3\n4\n5\n6\n7\n8\n'),
    remote: text('1\n2\n3\n4\n5\n6\n7\neight\n')
  });
  assert.equal(result.conflict, false);
  assert.equal(result.merged.toString(), 'one\n2\n3\n4\n5\n6\n7\neight\n');
});
