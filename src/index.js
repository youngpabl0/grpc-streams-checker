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
  cfg.streams = cfg.streams || [];
  return cfg;
}

// `--only=a,b` restricts the run to named streams (handy for debugging one flaky stream).
function onlyFilter() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return new Set(
    arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean),
  );
}

async function runOnce(cfg) {
  const only = onlyFilter();
  const streams = cfg.streams.filter((s) => !only || only.has(s.name));

  await Promise.all(streams.map(async (s) => {
    const labels = { stream: s.name, addr: s.addr || cfg.addr, dc: cfg.dc };
    const out = await checkStream(s, {
      addr: cfg.addr,
      tls: cfg.tls,
      timeoutMs: cfg.firstFrameTimeoutMs,
      auth: cfg.auth,
    });

    metrics.checkTotal.inc({ ...labels, result: out.result });
    metrics.up.set(labels, out.result === 'ok' ? 1 : 0);
    if (out.result === 'ok') metrics.firstFrameMs.set(labels, out.ms);

    const line = { stream: s.name, result: out.result, ms: Math.round(out.ms), error: out.error };
    if (out.result === 'ok') logger.info(line, 'stream ok');
    else logger.warn(line, 'stream check failed');
  }));

  metrics.lastRun.set({ addr: cfg.addr, dc: cfg.dc }, Math.floor(Date.now() / 1000));
}

function main() {
  const cfg = loadConfig();
  logger.info(
    { addr: cfg.addr, dc: cfg.dc, streams: cfg.streams.length, intervalSeconds: cfg.intervalSeconds },
    'starting grpc-streams-checker',
  );

  if (process.argv.includes('--once')) {
    runOnce(cfg)
      .then(() => process.exit(0))
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
