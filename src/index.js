#!/usr/bin/env node
/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const logger = require('./logger');
const metrics = require('./metrics');
const { checkStream } = require('./checker');

const CONFIG_PATH = process.env.CONFIG || 'streams.json';

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(CONFIG_PATH), 'utf8'));
  cfg.addr = process.env.ADDR || cfg.addr;
  cfg.dc = process.env.DC || cfg.dc || 'default';
  cfg.tls = cfg.tls !== false; // TLS on unless explicitly disabled
  cfg.firstFrameTimeoutMs = Number(process.env.TIMEOUT_MS || cfg.firstFrameTimeoutMs || 5000);
  cfg.intervalSeconds = Number(process.env.INTERVAL_SECONDS || cfg.intervalSeconds || 30);
  cfg.minFrames = Number(process.env.MIN_FRAMES || cfg.minFrames || 1);
  cfg.protoIncludeDirs = cfg.protoIncludeDirs || [];
  cfg.streams = cfg.streams || [];
  return cfg;
}

// `--only=a,b` restricts the run to named streams (handy for debugging one flaky stream).
function onlyFilter() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
}

async function runOnce(cfg) {
  const only = onlyFilter();
  const streams = cfg.streams.filter((s) => !only || only.has(s.name));

  const results = await Promise.all(streams.map(async (s) => {
    const labels = { stream: s.name, method: s.method, addr: s.addr || cfg.addr, dc: cfg.dc };
    const out = await checkStream(s, {
      addr: cfg.addr,
      tls: cfg.tls,
      timeoutMs: s.timeoutMs || cfg.firstFrameTimeoutMs,
      minFrames: cfg.minFrames,
      auth: cfg.auth,
      includeDirs: cfg.protoIncludeDirs,
    });

    // outcome
    metrics.checkTotal.inc({ ...labels, result: out.result });
    metrics.up.set(labels, out.result === 'ok' ? 1 : 0);
    if (out.code) metrics.errorTotal.inc({ ...labels, code: out.code });
    if (out.failedRule) metrics.validationFailTotal.inc({ ...labels, rule: out.failedRule });

    // latency & volume
    if (out.frames > 0) {
      metrics.firstFrameMs.set(labels, out.firstFrameMs);
      metrics.firstFrameSeconds.observe(labels, out.firstFrameMs / 1000);
      metrics.framesTotal.inc(labels, out.frames);
    }
    metrics.framesLastCheck.set(labels, out.frames);
    if (out.frames > 1) metrics.maxInterFrameMs.set(labels, out.maxGapMs);
    if (out.result === 'ok') metrics.lastSuccess.set(labels, Math.floor(Date.now() / 1000));

    const line = {
      stream: s.name,
      result: out.result,
      frames: out.frames,
      firstFrameMs: Math.round(out.firstFrameMs),
      maxGapMs: Math.round(out.maxGapMs),
      code: out.code,
      error: out.error,
    };
    if (out.result === 'ok') logger.info(line, 'stream ok');
    else logger.warn(line, 'stream check failed');
    return out;
  }));

  metrics.lastRun.set({ addr: cfg.addr, dc: cfg.dc }, Math.floor(Date.now() / 1000));
  return results;
}

function main() {
  const cfg = loadConfig();
  logger.info(
    {
      addr: cfg.addr, dc: cfg.dc, streams: cfg.streams.length,
      minFrames: cfg.minFrames, intervalSeconds: cfg.intervalSeconds,
    },
    'starting grpc-streams-checker',
  );

  if (process.argv.includes('--once')) {
    runOnce(cfg)
      .then((results) => {
        const failed = results.filter((r) => r.result !== 'ok').length;
        process.exit(failed === 0 ? 0 : 1); // non-zero exit → usable as a CI / cron gate
      })
      .catch((err) => { logger.error({ err: err.message }, 'run failed'); process.exit(1); });
    return;
  }

  const app = express();
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  });
  const port = Number(process.env.PORT || 4777);
  app.listen(port, () => logger.info({ port }, 'metrics server listening on /metrics'));

  const loop = () => runOnce(cfg).catch((err) => logger.error({ err: err.message }, 'run failed'));
  loop();
  setInterval(loop, cfg.intervalSeconds * 1000);
}

main();
