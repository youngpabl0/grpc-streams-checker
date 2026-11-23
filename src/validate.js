/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

/**
 * Validate one decoded frame against the stream's `expect` rules.
 *
 * Supported rules:
 *   expect.fields  — array of dotted paths that must exist and be non-empty
 *                    (e.g. ["price", "meta.ts"]).
 *   expect.match   — object of dotted path -> expected value. String values
 *                    starting and ending with "/" are treated as regexes.
 *   expect.nonEmpty — if true (default), an entirely empty frame fails.
 *
 * @param {object} frame decoded protobuf message (plain object)
 * @param {object} [expect] validation rules from the stream config
 * @return {{ok: boolean, rule: ?string, detail: ?string}}
 */
function validateFrame(frame, expect) {
  const rules = expect || {};

  if (rules.nonEmpty !== false) {
    if (!frame || Object.keys(frame).length === 0) {
      return { ok: false, rule: 'empty_frame', detail: 'frame decoded to an empty object' };
    }
  }

  for (const path of rules.fields || []) {
    const value = dig(frame, path);
    if (value === undefined || value === null || value === '') {
      return { ok: false, rule: 'missing_field', detail: `field "${path}" is missing or empty` };
    }
  }

  for (const [path, expected] of Object.entries(rules.match || {})) {
    const actual = dig(frame, path);
    if (typeof expected === 'string' && expected.length > 2 && expected.startsWith('/') && expected.endsWith('/')) {
      const re = new RegExp(expected.slice(1, -1));
      if (!re.test(String(actual))) {
        return { ok: false, rule: 'mismatch', detail: `field "${path}"="${actual}" !~ ${expected}` };
      }
    } else if (String(actual) !== String(expected)) {
      return { ok: false, rule: 'mismatch', detail: `field "${path}"="${actual}" != "${expected}"` };
    }
  }

  return { ok: true, rule: null, detail: null };
}

function dig(obj, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

module.exports = { validateFrame, dig };
