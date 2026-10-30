const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, waitFor, projectDir } = require('./harness.cjs');

for (const scenario of ['both-modified', 'local-unsaved', 'local-deleted-remote-modified', 'remote-deleted-local-modified', 'multiple', 'cancel', 'missing-copy', 'command-failure', 'folder']) {
  test(`conflict difference: ${scenario}`, async () => {
    const root = projectDir('vsolcli-diff-');
    const conflictsDir = '.olcli-conflicts/snapshot';
    const remotePath = path.join(root, conflictsDir, 'main.tex.hash.remote');
    fs.mkdirSync(path.dirname(remotePath), { recursive: true });
    fs.writeFileSync(remotePath, 'remote content');
    const localPath = path.join(root, 'main.tex');
    if (scenario !== 'local-deleted-remote-modified') fs.writeFileSync(localPath, 'local content');
    const h = harness({
      projectRoot: root,
      storedSession: { OVERLEAF_SESSION: 'test-session' },
      warningChoice: scenario === 'folder' ? 'Show Conflicts' : 'Show Difference',
      quickPickIndex: scenario === 'multiple' ? 1 : undefined,
      commandError: scenario === 'command-failure' ? 'diff failed' : undefined
    });
    try {
      const conflict = {
        path: 'main.tex',
        kind: ['local-unsaved', 'local-deleted-remote-modified', 'remote-deleted-local-modified'].includes(scenario) ? scenario : 'both-modified',
        ...(scenario === 'remote-deleted-local-modified' ? {} : { remoteCopy: path.basename(remotePath) })
      };
      const conflicts = scenario === 'multiple' || scenario === 'cancel'
        ? [{ path: 'other.tex', kind: 'both-modified', remoteCopy: 'not-selected.remote' }, conflict]
        : [conflict];
      if (scenario === 'missing-copy') fs.unlinkSync(remotePath);
      const dirty = scenario === 'local-unsaved' ? h.document('main.tex') : undefined;
      h.sidecar({ conflicts, conflictsDir, errors: [] });
      h.save('main.tex');
      await waitFor(() => h.warnings.length > 0, 'conflict warning');
      if (scenario === 'cancel') {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.opened.length, 0);
      } else if (scenario === 'missing-copy' || scenario === 'command-failure') {
        await waitFor(() => h.errors.length > 0, 'visible diff error');
        assert.match(h.errors[0], /unable to show conflicts/);
        if (scenario === 'missing-copy') assert.equal(h.opened.length, 0);
      } else if (scenario === 'folder') {
        await waitFor(() => h.opened.length > 0, 'conflict folder');
        assert.equal(h.opened[0][0], 'revealInExplorer');
        assert.equal(h.opened[0][1].fsPath, path.join(root, conflictsDir));
      } else {
        await waitFor(() => h.opened.length > 0, 'diff command');
        const [command, remote, local, title] = h.opened[0];
        assert.equal(command, 'vscode.diff');
        if (scenario === 'remote-deleted-local-modified') assert.equal(remote.scheme, 'olcli-empty');
        else assert.equal(remote.fsPath, remotePath);
        if (scenario === 'local-deleted-remote-modified') assert.equal(local.scheme, 'olcli-empty');
        else assert.equal(local.fsPath, localPath);
        if (dirty) assert.equal(local, dirty.uri, 'use the existing buffer URI');
        assert.match(title, /main.tex.*Overleaf.*Local/);
        assert.equal(h.errors.length, 0);
      }
      if (scenario !== 'missing-copy') assert.equal(fs.readFileSync(remotePath, 'utf8'), 'remote content');
      if (scenario !== 'local-deleted-remote-modified') assert.equal(fs.readFileSync(localPath, 'utf8'), 'local content');
    } finally {
      h.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['sync', 'keep-local', 'keep-remote', 'remaining-conflicts', 'locked', 'failed', 'dirty-local', 'save-failed', 'dirty-remote', 'project-routing']) {
  test(`conflict approval buttons: ${scenario}`, async () => {
    const root = projectDir('vsolcli-approval-');
    const conflictsDir = '.olcli-conflicts/snapshot';
    fs.mkdirSync(path.join(root, conflictsDir), { recursive: true });
    fs.writeFileSync(path.join(root, conflictsDir, 'main.remote'), 'remote');
    fs.writeFileSync(path.join(root, 'main.tex'), 'local');
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' }, warningChoice: 'Show Difference' });
    try {
      const conflict = { path: 'main.tex', kind: 'both-modified', remoteCopy: 'main.remote' };
      h.sidecar({ conflicts: [conflict], conflictsDir, errors: [] });
      h.save('main.tex');
      await waitFor(() => h.tabs.length === 1, 'conflict comparison');
      const comparison = h.tabs[0];
      const plain = { input: {} };
      const otherDiff = { input: new comparison.input.constructor(comparison.input.modified, comparison.input.original) };
      h.tabs.push(plain, otherDiff);
      assert.equal(h.closedTabs.length, 0, 'opening and reviewing must not close the comparison');
      const dirty = scenario.startsWith('dirty-') || scenario === 'save-failed' ? h.document('main.tex') : undefined;
      if (scenario === 'save-failed') dirty.save = async () => false;
      if (scenario === 'remaining-conflicts') h.sidecar({ conflicts: [conflict], conflictsDir, errors: [] });
      else if (scenario === 'locked') h.sidecar({ skipped: true, reason: 'locked' });
      else if (scenario === 'failed') h.failNext('sync-guard.mjs', { stderr: 'connection failed' });
      if (scenario === 'project-routing') h.settings.projectRoot = path.join(root, 'another-project');
      const before = h.calls.length;
      const command = scenario === 'sync' ? 'olcli.sync' : scenario === 'keep-remote' || scenario === 'dirty-remote' ? 'olcli.resolveConflictsRemote' : 'olcli.resolveConflictsLocal';
      await h.commands.get(command)();
      if (['remaining-conflicts', 'locked', 'failed', 'save-failed', 'dirty-remote'].includes(scenario)) {
        assert.equal(h.closedTabs.length, 0, 'failed or blocked approval must leave the diff open');
        assert.ok(h.tabs.includes(comparison));
        if (scenario === 'dirty-remote' || scenario === 'save-failed') assert.equal(h.calls.length, before);
        if (scenario === 'dirty-remote') assert.equal(dirty.isDirty, true);
      } else {
        assert.deepEqual(h.closedTabs, [comparison]);
        assert.deepEqual(h.tabs, [plain, otherDiff], 'unrelated editors and comparisons stay open');
        const call = h.calls.at(-1);
        assert.equal(call.options.cwd, root, 'use the reviewed project, not the configured default');
        if (scenario === 'keep-remote') assert.ok(call.argv.includes('--prefer-remote'));
        else if (scenario !== 'sync') assert.ok(call.argv.includes('--prefer-local'));
        else assert.ok(!call.argv.includes('--prefer-local') && !call.argv.includes('--prefer-remote'));
        if (dirty) {
          assert.equal(dirty.isDirty, false, 'save the reviewed local buffer before upload');
          assert.equal(h.calls.length, before + 1, 'approval saves must not trigger a duplicate sync');
        }
      }
    } finally {
      h.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
