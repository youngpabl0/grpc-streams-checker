/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drift checks for the Helm chart. helm lint / helm template run in CI; these
 * tests only need Node.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHART = path.join(ROOT, 'deploy', 'helm', 'grpc-streams-checker');

test('chart alert rules are identical to alerts/ (single source of truth)', () => {
  const shipped = fs.readFileSync(path.join(ROOT, 'alerts', 'grpc-streams-checker.rules.yml'), 'utf8');
  const inChart = fs.readFileSync(path.join(CHART, 'files', 'grpc-streams-checker.rules.yml'), 'utf8');
  assert.equal(
    inChart, shipped,
    'copy alerts/grpc-streams-checker.rules.yml to deploy/helm/grpc-streams-checker/files/',
  );
});

test('chart appVersion matches package.json version', () => {
  const chart = fs.readFileSync(path.join(CHART, 'Chart.yaml'), 'utf8');
  const appVersion = (chart.match(/^appVersion:\s*"?([^"\n]+)"?\s*$/m) || [])[1];
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(appVersion, version);
});
