// Unit tests for the periodic-sync backoff helper.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { periodicDelayMs, MAX_PERIODIC_DELAY_MS } = require('../out/autoSync.js');

test('a disabled or invalid interval schedules nothing', () => {
  assert.equal(periodicDelayMs(0, 0), 0);
  assert.equal(periodicDelayMs(-1000, 3), 0);
  assert.equal(periodicDelayMs(Number.NaN, 0), 0);
});

test('no failures means the configured interval', () => {
  assert.equal(periodicDelayMs(60_000, 0), 60_000);
});

test('consecutive failures back off exponentially up to 8x', () => {
  assert.equal(periodicDelayMs(60_000, 1), 120_000);
  assert.equal(periodicDelayMs(60_000, 2), 240_000);
  assert.equal(periodicDelayMs(60_000, 3), 480_000);
  assert.equal(periodicDelayMs(60_000, 4), 480_000, 'capped at 8x the interval');
  assert.equal(periodicDelayMs(60_000, 1_000), 480_000);
});

test('the delay never exceeds the hard ceiling', () => {
  assert.equal(periodicDelayMs(MAX_PERIODIC_DELAY_MS, 0), MAX_PERIODIC_DELAY_MS);
  assert.equal(periodicDelayMs(MAX_PERIODIC_DELAY_MS * 2, 0), MAX_PERIODIC_DELAY_MS);
  assert.equal(periodicDelayMs(10 * 60 * 1000, 5), MAX_PERIODIC_DELAY_MS);
});
