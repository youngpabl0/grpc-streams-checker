/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_STREAM_FIELDS = ['name', 'proto', 'package', 'service', 'method'];

/**
 * Load and validate the checker config. Fails fast with a precise message —
 * a typo in the config should kill startup, not surface as a cryptic
 * per-check runtime error an hour later.
 *
 * @param {string} configPath path to streams.json
 * @param {object} [env] environment (defaults to process.env; injectable for tests)
 * @return {object} validated config
 */
function loadConfig(configPath, env = process.env) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`config not found: ${resolved} (set CONFIG=/path/to/streams.json)`);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`config is not valid JSON: ${resolved} — ${err.message}`);
  }

  cfg.addr = env.ADDR || cfg.addr;
  cfg.dc = env.DC || cfg.dc || 'default';
  cfg.tls = cfg.tls !== false;
  cfg.firstFrameTimeoutMs = Number(env.TIMEOUT_MS || cfg.firstFrameTimeoutMs || 5000);
  cfg.intervalSeconds = Number(env.INTERVAL_SECONDS || cfg.intervalSeconds || 30);
  cfg.minFrames = Number(env.MIN_FRAMES || cfg.minFrames || 1);
  cfg.protoIncludeDirs = cfg.protoIncludeDirs || [];
  cfg.streams = cfg.streams || [];

  const problems = [];

  if (!Array.isArray(cfg.streams) || cfg.streams.length === 0) {
    problems.push('config has no streams — nothing to check');
  }

  const seen = new Set();
  cfg.streams.forEach((s, i) => {
    const tag = s.name ? `stream "${s.name}"` : `streams[${i}]`;
    for (const field of REQUIRED_STREAM_FIELDS) {
      if (!s[field]) problems.push(`${tag}: missing required field "${field}"`);
    }
    if (s.name) {
      if (seen.has(s.name)) problems.push(`duplicate stream name "${s.name}" — metric series would collide`);
      seen.add(s.name);
    }
    if (s.proto && !fs.existsSync(path.resolve(s.proto))) {
      problems.push(`${tag}: proto file not found: ${path.resolve(s.proto)}`);
    }
    if (!s.addr && !cfg.addr) {
      problems.push(`${tag}: no addr — set a top-level "addr" or a per-stream override`);
    }
  });

  for (const dir of cfg.protoIncludeDirs) {
    if (!fs.existsSync(path.resolve(dir))) {
      problems.push(`protoIncludeDirs entry not found: ${path.resolve(dir)}`);
    }
  }

  if (problems.length) {
    throw new Error(`invalid config (${resolved}):\n  - ${problems.join('\n  - ')}`);
  }
  return cfg;
}

module.exports = { loadConfig };
