// Verifies the extension compiles the project once per save and syncs through
// the conflict-aware sidecar whenever a session is available.
//
// Before: every save ran `olcli pdf` and then `olcli output log`, and each of
// those POSTs /compile — two cloud compiles per save, which is what made request
// timeouts frequent. Now one wrapper run yields both artifacts.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, waitFor, projectDir, isSafeSync, isCliSync, isSync } = require('./harness.cjs');

test('a save compiles once and gets the log from that same compile', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-save-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      await h.commands.get('olcli.syncAndCompileCurrent')();
      await waitFor(() => h.calls.some(call => call.argv[0].endsWith('compile.mjs')), 'a compile step');

      assert.equal(h.calls.filter(isSafeSync).length, 1, 'save should sync once through sync-guard.mjs');
      assert.equal(h.calls.filter(isCliSync).length, 0, 'the CLI sync fallback must not run when a session is stored');
      const wrapperCalls = h.calls.filter(call => call.argv[0].endsWith('compile.mjs'));
      assert.equal(wrapperCalls.length, 1, `expected one compile wrapper run, saw ${wrapperCalls.length}`);
      assert.equal(h.calls.filter(call => call.argv.includes('pdf')).length, 0, 'must not run olcli pdf');
      assert.equal(h.calls.filter(call => call.argv.includes('output')).length, 0, 'must not run olcli output log');

      const [wrapper] = wrapperCalls;
      assert.equal(wrapper.options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(wrapper.options.env.OVERLEAF_SESSION, 'test-session');
      assert.ok(Number(wrapper.argv[3]) >= 1000, `compile timeout should be raised, saw ${wrapper.argv[3]}`);
      assert.ok(fs.existsSync(path.join(root, '.build', 'main.log')), 'the log from the single compile should be on disk');
      assert.ok(!h.output.includes('test-session'), 'must not echo the session cookie');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without a stored session the CLI fallback still compiles', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-fallback-');
  try {
    const h = harness({ projectRoot: root, storedSession: undefined });
    try {
      await h.commands.get('olcli.syncAndCompileCurrent')();
      await waitFor(() => h.calls.some(call => call.argv.includes('pdf')), 'the CLI pdf fallback');

      assert.equal(h.calls.filter(isSafeSync).length, 0, 'the sidecar needs a stored session');
      assert.equal(h.calls.filter(isCliSync).length, 1, 'plain olcli sync should run');
      assert.equal(h.calls.filter(call => call.argv.includes('pdf')).length, 1);
      assert.equal(h.calls.filter(call => call.argv.includes('output')).length, 1);
      assert.equal(h.calls.filter(call => call.argv[0].endsWith('compile.mjs')).length, 0);
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saving a .tex file triggers sync automatically', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-save-trigger-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.save('main.tex');
      await waitFor(() => h.calls.filter(isSync).length === 1, 'the debounced sync');
      assert.equal(h.calls.filter(isSync).length, 1, 'save should sync once');
      assert.ok(h.output.includes('saved:'), 'the save handler should log the save');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a save during a long run is coalesced, not dropped', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-coalesce-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' } });
    try {
      h.hold('sync');
      h.save('a.tex');
      await waitFor(() => h.heldCount() === 1, 'the first sync to be held');
      assert.equal(h.calls.filter(isSync).length, 1);

      // No suppression window: the save that lands while the first run is in
      // flight is accepted, debounced and queued as `pending` immediately.
      h.save('b.tex');
      await waitFor(() => h.output.includes('saved:'), 'the mid-run save to be accepted');
      await new Promise(resolve => setTimeout(resolve, 60));

      h.release();
      await waitFor(() => h.calls.filter(isSync).length === 2, 'the coalesced second sync', 4000);
      assert.equal(h.calls.filter(isSync).length, 2, 'exactly one coalesced re-run');
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a compile that never exits is aborted instead of wedging sync', async () => {
  delete process.env.OVERLEAF_SESSION;
  const root = projectDir('vsolcli-watchdog-');
  try {
    const h = harness({ projectRoot: root, storedSession: { OVERLEAF_SESSION: 'test-session' }, settings: { compileTimeout: 1000 } });
    try {
      h.hold('compile.mjs'); // the wrapper never exits
      h.save('main.tex');

      await waitFor(() => h.errors.some(text => /did not finish/.test(text)), 'the watchdog to abort the compile', 8000);
      // If `running` were still set, the command would be swallowed and no sync would follow.
      const before = h.calls.filter(isSync).length;
      await h.commands.get('olcli.syncAndCompileCurrent')();
      await waitFor(() => h.calls.filter(isSync).length > before, 'a follow-up run', 4000);
    } finally {
      h.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
