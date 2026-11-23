#!/usr/bin/env node
/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const express = require('express');

const logger = require('./logger');
const metrics = require('./metrics');
const { loadConfig } = require('./config');
const { checkStream } = require('./checker');

const CONFIG_PATH = process.env.CONFIG || 'streams.json';

// `--only=a,b` restricts the run to named streams (handy for debugging one flaky stream).
function onlyFilter() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
}

let runInFlight = false;

async function runOnce(cfg) {
  // A slow backend must not stack runs on top of each other: if the previous
  // pass is still going when the interval fires, skip and say so.
  if (runInFlight) {
    logger.warn('previous check run still in flight — skipping this tick (interval < slowest check?)');
    return [];
  }
  runInFlight = true;
  try {
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
      if (out.dataAgeSeconds !== null && out.dataAgeSeconds !== undefined) {
        metrics.dataAgeSeconds.set(labels, out.dataAgeSeconds);
      }
      if (out.result === 'ok') metrics.lastSuccess.set(labels, Math.floor(Date.now() / 1000));

      const line = {
        stream: s.name,
        result: out.result,
        frames: out.frames,
        firstFrameMs: Math.round(out.firstFrameMs),
        maxGapMs: Math.round(out.maxGapMs),
        dataAgeSeconds: out.dataAgeSeconds === null || out.dataAgeSeconds === undefined
          ? undefined : Math.round(out.dataAgeSeconds * 10) / 10,
        code: out.code,
        error: out.error,
      };
      if (out.result === 'ok') logger.info(line, 'stream ok');
      else logger.warn(line, 'stream check failed');
      return out;
    }));

    metrics.lastRun.set({ addr: cfg.addr, dc: cfg.dc }, Math.floor(Date.now() / 1000));
    return results;
  } finally {
    runInFlight = false;
  }
}

function main() {
  let cfg;
  try {
    cfg = loadConfig(CONFIG_PATH);
  } catch (err) {
    logger.error(err.message);
    process.exit(2); // config error: distinct exit code, fail fast
  }

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
  const httpServer = app.listen(port, () => logger.info({ port }, 'metrics server listening on /metrics'));

  const loop = () => runOnce(cfg).catch((err) => logger.error({ err: err.message }, 'run failed'));
  loop();
  const interval = setInterval(loop, cfg.intervalSeconds * 1000);

  // Graceful shutdown: Kubernetes sends SIGTERM on rollout/eviction — exit
  // promptly instead of hanging until the grace period kills us.
  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(interval);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // belt & braces
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
