/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Time to first frame on the last check — the metric that degrades before a stream fully breaks.
const firstFrameMs = new client.Gauge({
  name: 'grpc_stream_first_frame_ms',
  help: 'Milliseconds until the first frame arrived on the server-side stream (last check).',
  labelNames: ['stream', 'addr', 'dc'],
  registers: [register],
});

// Every check, labelled by outcome — the basis for "no data" / error-rate alerts.
const checkTotal = new client.Counter({
  name: 'grpc_stream_check_total',
  help: 'Total stream checks performed, by result (ok|timeout|error).',
  labelNames: ['stream', 'addr', 'dc', 'result'],
  registers: [register],
});

// 1 if the stream produced a frame within the timeout on the last check, else 0.
const up = new client.Gauge({
  name: 'grpc_stream_up',
  help: '1 if the stream produced a frame within the timeout on the last check, else 0.',
  labelNames: ['stream', 'addr', 'dc'],
  registers: [register],
});

// Lets you distinguish "failed on the last run" from stale data / a dead checker.
const lastRun = new client.Gauge({
  name: 'grpc_stream_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last completed check run.',
  labelNames: ['addr', 'dc'],
  registers: [register],
});

module.exports = { register, firstFrameMs, checkTotal, up, lastRun };
