const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('Marketplace icon stays within the PNG size and dimension limits', () => {
  const image = fs.readFileSync(path.join(__dirname, '..', manifest.icon));
  assert.ok(image.length <= 1024 * 1024, 'Marketplace icon must not exceed 1024 KB');
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(image.toString('ascii', 12, 16), 'IHDR');
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(width >= 128 && height >= 128, 'Marketplace icon must be at least 128x128');
  assert.equal(width, height, 'the extension icon should be square');
});
