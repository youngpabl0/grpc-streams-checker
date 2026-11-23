/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toEpochMs, checkFreshness } = require('../src/freshness');

const NOW = Date.parse('2026-11-23T12:00:00Z');

test('epoch numbers: unit guessed from magnitude (s, ms, us, ns)', () => {
  assert.equal(toEpochMs(NOW / 1000), NOW);
  assert.equal(toEpochMs(NOW), NOW);
  assert.equal(toEpochMs(NOW * 1000), NOW);
  assert.equal(toEpochMs(NOW * 1e6), NOW);
  assert.equal(toEpochMs(1795435200.5), 1795435200500); // fractional seconds
});

test('numeric strings (int64 decoded by proto-loader) are epochs too', () => {
  assert.equal(toEpochMs(String(NOW)), NOW);
  assert.equal(toEpochMs(String(NOW / 1000)), NOW);
});

test('explicit unit overrides the guess', () => {
  assert.equal(toEpochMs(1000, 's'), 1e6);
  assert.equal(toEpochMs(1000, 'ms'), 1000);
  assert.equal(toEpochMs('5000000', 'us'), 5000);
  assert.equal(toEpochMs(5e9, 'ns'), 5000);
});

test('RFC 3339 strings, with zone offsets and fractional seconds', () => {
  assert.equal(toEpochMs('2026-11-23T12:00:00Z'), NOW);
  assert.equal(toEpochMs('2026-11-23T19:00:00+07:00'), NOW);
  assert.equal(toEpochMs('2026-11-23t12:00:00.250z'), NOW + 250);
  assert.equal(toEpochMs('2026-11-23 12:00:00.123456789Z'), NOW + 123);
});

test('protobuf Timestamp objects, seconds as string or number', () => {
  assert.equal(toEpochMs({ seconds: String(NOW / 1000), nanos: 500000000 }), NOW + 500);
  assert.equal(toEpochMs({ seconds: NOW / 1000 }), NOW);
});

test('Date objects', () => {
  assert.equal(toEpochMs(new Date(NOW)), NOW);
});

test('values that are not timestamps -> null', () => {
  for (const v of [undefined, null, '', 'yesterday', '2026-11-23', {}, { nanos: 1 }, [], new Date('x'), true]) {
    assert.equal(toEpochMs(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('checkFreshness: fresh frame passes and reports its age', () => {
  const out = checkFreshness({ ts: String(NOW - 2500) }, { field: 'ts', maxAgeSeconds: 10 }, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.ageSeconds, 2.5);
});

test('checkFreshness: old frame -> stale with the age in the detail', () => {
  const out = checkFreshness({ meta: { at: '2026-11-23T11:59:00Z' } }, { field: 'meta.at', maxAgeSeconds: 10 }, NOW);
  assert.equal(out.ok, false);
  assert.equal(out.result, 'stale');
  assert.equal(out.rule, null);
  assert.equal(out.ageSeconds, 60);
  assert.match(out.detail, /60\.0s old, limit 10s/);
});

test('checkFreshness: missing or unparsable field -> validation_failed / invalid_timestamp', () => {
  for (const frame of [{}, { ts: 'soon' }, { ts: null }]) {
    const out = checkFreshness(frame, { field: 'ts', maxAgeSeconds: 10 }, NOW);
    assert.equal(out.ok, false);
    assert.equal(out.result, 'validation_failed');
    assert.equal(out.rule, 'invalid_timestamp');
    assert.equal(out.ageSeconds, null);
  }
});

test('checkFreshness: a timestamp slightly in the future (clock skew) is fresh', () => {
  const out = checkFreshness({ ts: NOW + 1500 }, { field: 'ts', maxAgeSeconds: 10 }, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.ageSeconds, -1.5);
});
