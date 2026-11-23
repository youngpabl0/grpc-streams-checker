/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { dig } = require('./validate');

// Below these magnitudes a bare epoch number is read as s, ms, us; above, ns.
// 1e11 s is the year 5138, 1e11 ms is 1973: the ranges do not overlap in practice.
const UNIT_MS = { s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };
const NUMERIC = /^-?\d+(\.\d+)?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function guessUnit(n) {
  const abs = Math.abs(n);
  if (abs < 1e11) return 's';
  if (abs < 1e14) return 'ms';
  if (abs < 1e17) return 'us';
  return 'ns';
}

/**
 * Turn a timestamp found in a frame into epoch milliseconds.
 *
 * Accepts:
 *   - google.protobuf.Timestamp objects: { seconds, nanos } (seconds may be a
 *     string or a Long, as proto-loader decodes int64);
 *   - epoch numbers or numeric strings in s, ms, us or ns (unit guessed from
 *     the magnitude unless `unit` is given);
 *   - RFC 3339 strings, e.g. "2026-11-23T10:00:00.123Z" or "...+07:00";
 *   - Date objects.
 *
 * @param {*} value
 * @param {string} [unit] "s" | "ms" | "us" | "ns" for numeric values
 * @return {?number} epoch ms, or null if the value is not a timestamp
 */
function toEpochMs(value, unit) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }

  if (typeof value === 'object') {
    if (!('seconds' in value)) return null;
    const seconds = Number(String(value.seconds));
    const nanos = Number(value.nanos || 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return seconds * 1000 + nanos / 1e6;
  }

  if (typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n * UNIT_MS[unit || guessUnit(n)];
  }

  if (typeof value === 'string' && RFC3339.test(value.trim())) {
    const t = Date.parse(value.trim().toUpperCase().replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }

  return null;
}

/**
 * Check that one frame carries recent data.
 *
 * @param {object} frame decoded message
 * @param {{field: string, maxAgeSeconds: number, unit?: string}} rule
 * @param {number} [nowMs] current time (injectable for tests)
 * @return {{ok: boolean, ageSeconds: ?number, result: ?string, rule: ?string, detail: ?string}}
 *   result is "stale" for old data, "validation_failed" (rule "invalid_timestamp")
 *   when the field is missing or not a timestamp.
 */
function checkFreshness(frame, rule, nowMs = Date.now()) {
  const raw = dig(frame, rule.field);
  const ts = toEpochMs(raw, rule.unit);
  if (ts === null) {
    return {
      ok: false,
      ageSeconds: null,
      result: 'validation_failed',
      rule: 'invalid_timestamp',
      detail: `freshness field "${rule.field}"=${JSON.stringify(raw)} is not a timestamp`,
    };
  }
  const ageSeconds = (nowMs - ts) / 1000;
  if (ageSeconds > rule.maxAgeSeconds) {
    return {
      ok: false,
      ageSeconds,
      result: 'stale',
      rule: null,
      detail: `data in "${rule.field}" is ${ageSeconds.toFixed(1)}s old, limit ${rule.maxAgeSeconds}s`,
    };
  }
  return { ok: true, ageSeconds, result: null, rule: null, detail: null };
}

module.exports = { toEpochMs, checkFreshness, UNITS: Object.keys(UNIT_MS) };
