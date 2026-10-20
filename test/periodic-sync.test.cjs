// Tests for the periodic background sync and the conflict reporting that
// surrounds it.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, waitFor, projectDir, isSync, isSafeSync, isCompile } = require('./harness.cjs');

const INTERVAL = 0.05; // 50 ms; the setting is in seconds

test('periodic sync runs without a save and never compiles', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-periodic-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' }, settings: { autoSyncInterval: INTERVAL } });
    try {
      await waitFor(() => h.calls.filter(isSync).length >= 1, 'the periodic sync', 3000);
      assert.ok(h.output.includes('periodic sync starting'), 'should log the background run');
      assert.equal(h.calls.filter(isCompile).length, 0, 'background syncs must not trigger a cloud compile');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('periodic sync is off by default and needs the project marker', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-periodic-off-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(h.calls.filter(isSync).length, 0, 'interval 0 must not schedule anything');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const markerless = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vsolcli-periodic-marker-'));
  try {
    const h = harness({ projectRoot: markerless, storedSession: { OVERLEAF_SESSION: 'test-session' }, settings: { autoSyncInterval: INTERVAL } });
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(h.calls.filter(isSync).length, 0, 'a directory without .olcli.json is not synced');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(markerless, { recursive: true, force: true });
  }
});

test('periodic sync waits for unsaved editor changes', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-periodic-dirty-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' }, settings: { autoSyncInterval: INTERVAL } });
    try {
      const document = h.document('main.tex', true);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(h.calls.filter(isSync).length, 0, 'a dirty editor must block the background sync');
      assert.ok(h.output.includes('periodic sync skipped: unsaved editor changes'));

      document.isDirty = false;
      await waitFor(() => h.calls.filter(isSync).length >= 1, 'the next periodic tick after the save', 3000);
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('periodic sync still runs after a save-triggered run finished', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-periodic-after-save-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' }, settings: { autoSyncInterval: INTERVAL } });
    try {
      h.save('main.tex');
      await waitFor(() => h.calls.filter(isSync).length >= 1, 'the save-triggered sync', 3000);
      // The save debounce handle must not look permanently pending.
      await waitFor(() => h.calls.filter(isSync).length >= 2, 'a background sync after the save run', 4000);
      assert.ok(h.output.includes('periodic sync starting'));
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing olcli.autoSyncInterval arms the timer without an immediate sync', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-periodic-config-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.settings.autoSyncInterval = INTERVAL;
      h.changeConfig(['olcli.autoSyncInterval']);
      await waitFor(() => h.calls.filter(isSync).length >= 1, 'the timer re-armed by the config change', 3000);
      assert.equal(h.calls.filter(isCompile).length, 0, 'an interval change alone must not compile');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conflicts are reported, both versions are kept, and compile is skipped', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-conflict-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.sidecar({
        projectId: 'a'.repeat(24),
        skipped: false,
        pulled: 0,
        pushed: 0,
        deletedRemote: 0,
        deletedLocal: 0,
        merged: 0,
        unchanged: 0,
        conflicts: [{ path: 'main.tex', kind: 'both-modified' }],
        conflictsDir: '.olcli-conflicts/2026-01-01T00-00-00-000Z',
        errors: []
      });
      h.save('main.tex');
      await waitFor(() => h.warnings.length >= 1, 'the conflict warning');
      assert.match(h.warnings[0], /changed both locally and in Overleaf/);
      assert.ok(h.output.includes('conflict: main.tex (changed on both sides)'));
      assert.ok(h.output.includes('cloud compile skipped'), 'a conflicted project must not compile');
      assert.equal(h.calls.filter(isCompile).length, 0);
      assert.equal(h.calls.filter(isSafeSync).length, 1, 'the safe sync itself should still have run');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a locked project is skipped instead of compiled or reported as failure', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-locked-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.sidecar({ projectId: 'a'.repeat(24), skipped: true, reason: 'locked' });
      h.save('main.tex');
      await waitFor(() => h.output.includes('sync skipped'), 'the skipped sync log');
      assert.equal(h.calls.filter(isCompile).length, 0, 'do not compile a project another sync is writing');
      assert.equal(h.errors.length, 0, 'a concurrent sync is not an error worth a notification');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed file operation surfaces as an error notification on a save', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-sync-error-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.sidecar({
        projectId: 'a'.repeat(24),
        skipped: false,
        pulled: 0,
        pushed: 0,
        deletedRemote: 0,
        deletedLocal: 0,
        merged: 0,
        unchanged: 0,
        conflicts: [],
        errors: [{ path: 'main.tex', message: 'upload failed' }]
      });
      h.save('main.tex');
      await waitFor(() => h.errors.length >= 1, 'the sync error notification');
      assert.match(h.errors[0], /file operation\(s\) failed/);
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual conflict resolution passes the preference to the sidecar', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-resolve-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      await h.commands.get('olcli.resolveConflictsLocal')();
      await waitFor(() => h.calls.filter(isSafeSync).length === 1, 'the resolution sync');
      assert.ok(h.calls.find(isSafeSync).argv.includes('--prefer-local'));
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
