/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFrame } = require('../src/validate');

test('passes a frame with no rules', () => {
  const v = validateFrame({ price: 1 }, undefined);
  assert.equal(v.ok, true);
});

test('rejects an empty frame by default', () => {
  const v = validateFrame({}, {});
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'empty_frame');
});

test('allows an empty frame when nonEmpty=false', () => {
  const v = validateFrame({}, { nonEmpty: false });
  assert.equal(v.ok, true);
});

test('fields: rejects missing field', () => {
  const v = validateFrame({ price: 1 }, { fields: ['symbol'] });
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'missing_field');
  assert.match(v.detail, /symbol/);
});

test('fields: rejects empty-string field', () => {
  const v = validateFrame({ symbol: '' }, { fields: ['symbol'] });
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'missing_field');
});

test('fields: accepts zero as a present value', () => {
  const v = validateFrame({ price: 0 }, { fields: ['price'] });
  assert.equal(v.ok, true);
});

test('fields: dotted paths reach nested values', () => {
  const ok = validateFrame({ meta: { ts: 5 } }, { fields: ['meta.ts'] });
  assert.equal(ok.ok, true);
  const bad = validateFrame({ meta: {} }, { fields: ['meta.ts'] });
  assert.equal(bad.ok, false);
});

test('match: exact value passes, wrong value fails', () => {
  const ok = validateFrame({ symbol: 'BTCUSD' }, { match: { symbol: 'BTCUSD' } });
  assert.equal(ok.ok, true);
  const bad = validateFrame({ symbol: 'ETHUSD' }, { match: { symbol: 'BTCUSD' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.rule, 'mismatch');
});

test('match: /regex/ values are treated as regexes', () => {
  const ok = validateFrame({ symbol: 'BTCUSD' }, { match: { symbol: '/^BTC/' } });
  assert.equal(ok.ok, true);
  const bad = validateFrame({ symbol: 'ETHUSD' }, { match: { symbol: '/^BTC/' } });
  assert.equal(bad.ok, false);
});

test('match: numbers compare loosely as strings', () => {
  const v = validateFrame({ code: 42 }, { match: { code: '42' } });
  assert.equal(v.ok, true);
});
