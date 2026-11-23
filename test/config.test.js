/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const PROTO = path.join(__dirname, '..', 'examples', 'price.proto');

function tmpConfig(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-')), 'streams.json');
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

const validStream = {
  name: 's1', proto: PROTO, package: 'example.v1',
  service: 'PriceService', method: 'PriceStream',
};

test('valid config loads with defaults applied', () => {
  const cfg = loadConfig(tmpConfig({ addr: 'x:1', streams: [validStream] }), {});
  assert.equal(cfg.dc, 'default');
  assert.equal(cfg.minFrames, 1);
  assert.equal(cfg.tls, true);
  assert.equal(cfg.intervalSeconds, 30);
});

test('env overrides win over file values', () => {
  const cfg = loadConfig(
    tmpConfig({ addr: 'x:1', dc: 'file-dc', streams: [validStream] }),
    { DC: 'env-dc', MIN_FRAMES: '5' },
  );
  assert.equal(cfg.dc, 'env-dc');
  assert.equal(cfg.minFrames, 5);
});

test('missing file -> clear error', () => {
  assert.throws(() => loadConfig('/nope/streams.json', {}), /config not found/);
});

test('broken JSON -> clear error', () => {
  assert.throws(() => loadConfig(tmpConfig('{oops'), {}), /not valid JSON/);
});

test('empty streams -> rejected', () => {
  assert.throws(() => loadConfig(tmpConfig({ addr: 'x:1', streams: [] }), {}), /no streams/);
});

test('missing required stream field -> named in the error', () => {
  const bad = { ...validStream };
  delete bad.method;
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [bad] }), {}),
    /stream "s1": missing required field "method"/,
  );
});

test('nonexistent proto path -> named in the error', () => {
  const bad = { ...validStream, proto: '/no/such.proto' };
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [bad] }), {}),
    /proto file not found/,
  );
});

test('duplicate stream names -> rejected (metric collision)', () => {
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [validStream, { ...validStream }] }), {}),
    /duplicate stream name/,
  );
});

test('no addr anywhere -> rejected', () => {
  assert.throws(
    () => loadConfig(tmpConfig({ streams: [validStream] }), {}),
    /no addr/,
  );
});

test('reflection: true makes "proto" optional', () => {
  const s = { ...validStream, reflection: true };
  delete s.proto;
  const cfg = loadConfig(tmpConfig({ addr: 'x:1', streams: [s] }), {});
  assert.equal(cfg.streams[0].reflection, true);
});

test('neither proto nor reflection -> rejected with a hint', () => {
  const s = { ...validStream };
  delete s.proto;
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [s] }), {}),
    /missing required field "proto" \(or set "reflection": true/,
  );
});

test('both proto and reflection -> rejected as ambiguous', () => {
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [{ ...validStream, reflection: true }] }), {}),
    /either "proto" or "reflection"/,
  );
});

test('non-boolean reflection -> rejected', () => {
  const s = { ...validStream, reflection: 'yes' };
  delete s.proto;
  assert.throws(
    () => loadConfig(tmpConfig({ addr: 'x:1', streams: [s] }), {}),
    /"reflection" must be true or false/,
  );
});
