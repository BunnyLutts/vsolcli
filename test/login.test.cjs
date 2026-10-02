const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionCookie } = require('../out/login');

test('cookie login accepts raw values and named session cookies', () => {
  assert.deepEqual(parseSessionCookie(' raw== ', 'overleaf_session2'), { name: 'overleaf_session2', value: 'raw==' });
  assert.deepEqual(parseSessionCookie('overleaf.sid=secret==; Path=/', 'overleaf_session2'), { name: 'overleaf.sid', value: 'secret==' });
  assert.deepEqual(parseSessionCookie('custom=secret', 'custom'), { name: 'custom', value: 'secret' });
  assert.throws(() => parseSessionCookie('overleaf.sid=', 'overleaf_session2'));
  assert.throws(() => parseSessionCookie('', 'overleaf_session2'));
});
