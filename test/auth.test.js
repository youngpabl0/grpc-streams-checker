/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMetadata } = require('../src/auth');

test('no auth -> empty metadata', () => {
  const md = buildMetadata(undefined);
  assert.deepEqual(md.get('authorization'), []);
});

test('token becomes a Bearer authorization header', () => {
  const md = buildMetadata({ token: 'abc123' });
  assert.deepEqual(md.get('authorization'), ['Bearer abc123']);
});

test('${ENV} placeholders expand from the environment', () => {
  process.env.TEST_GRPC_TOKEN = 'from-env';
  const md = buildMetadata({ token: '${TEST_GRPC_TOKEN}' });
  assert.deepEqual(md.get('authorization'), ['Bearer from-env']);
  delete process.env.TEST_GRPC_TOKEN;
});

test('unset ${ENV} -> no authorization header', () => {
  delete process.env.TEST_GRPC_TOKEN_MISSING;
  const md = buildMetadata({ token: '${TEST_GRPC_TOKEN_MISSING}' });
  assert.deepEqual(md.get('authorization'), []);
});

test('custom metadata headers are set and expanded', () => {
  process.env.TEST_TENANT = 't-1';
  const md = buildMetadata({ metadata: { 'x-tenant': '${TEST_TENANT}', 'x-static': 'v' } });
  assert.deepEqual(md.get('x-tenant'), ['t-1']);
  assert.deepEqual(md.get('x-static'), ['v']);
  delete process.env.TEST_TENANT;
});
