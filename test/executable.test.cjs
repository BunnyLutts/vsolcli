const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveExecutable } = require('../out/executable');

test('finds executable in PNPM_HOME even when extension PATH omits it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olcli-path-'));
  try {
    const executable = path.join(directory, 'test-olcli');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(resolveExecutable('test-olcli', { PATH: '', PNPM_HOME: directory }), executable);
    assert.equal(resolveExecutable(executable, { PATH: '' }), executable);
    assert.equal(resolveExecutable('nonexistent-olcli-test', { PATH: '' }), 'nonexistent-olcli-test');
  } finally { fs.rmSync(directory, { recursive: true }); }
});
