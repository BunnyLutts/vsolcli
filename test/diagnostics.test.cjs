const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCompileLog } = require('../out/diagnostics');

test('parses cloud file-line errors, TeX errors and warnings', () => {
  const result = parseCompileLog('./chapters/a.tex:12: Undefined control sequence.\n(./main.tex\n! Missing $ inserted.\nl.30 text\nLaTeX Warning: Reference undefined on input line 42.', 'main.tex');
  assert.equal(result[0].file, './chapters/a.tex');
  assert.equal(result[0].line, 11);
  assert.equal(result[1].line, 29);
  assert.equal(result[2].warning, true);
  assert.equal(result[2].line, 41);
  assert.deepEqual(parseCompileLog('Compilation succeeded', 'main.tex'), []);
});
