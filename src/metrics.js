/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ---- liveness of the stream itself -----------------------------------------

// 1 if the last check fully passed (frames arrived AND validation passed), else 0.
const up = new client.Gauge({
  name: 'grpc_stream_up',
  help: '1 if the last check passed (frames arrived and validation passed), else 0.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// Every check by outcome: ok | timeout | insufficient_frames | validation_failed | error.
const checkTotal = new client.Counter({
  name: 'grpc_stream_check_total',
  help: 'Total stream checks, by result (ok|timeout|insufficient_frames|validation_failed|error).',
  labelNames: ['stream', 'method', 'addr', 'dc', 'result'],
  registers: [register],
});

// gRPC status code on failures (DEADLINE_EXCEEDED, UNAVAILABLE, UNAUTHENTICATED, ...).
const errorTotal = new client.Counter({
  name: 'grpc_stream_error_total',
  help: 'Stream check errors by gRPC status code.',
  labelNames: ['stream', 'method', 'addr', 'dc', 'code'],
  registers: [register],
});

// ---- latency ----------------------------------------------------------------

// Time to the FIRST frame — degrades before the stream goes fully dark.
const firstFrameMs = new client.Gauge({
  name: 'grpc_stream_first_frame_ms',
  help: 'Milliseconds until the first frame arrived (last check).',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// Same, as a histogram — for percentiles over time.
const firstFrameSeconds = new client.Histogram({
  name: 'grpc_stream_first_frame_duration_seconds',
  help: 'Time to first frame, as a histogram.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Worst gap between consecutive frames within one check (sustained-flow health).
const maxInterFrameMs = new client.Gauge({
  name: 'grpc_stream_max_inter_frame_ms',
  help: 'Largest gap between consecutive frames within the last check.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// ---- volume & content -------------------------------------------------------

// Frames received during the last check (did we get the 3-5 we asked for?).
const framesLastCheck = new client.Gauge({
  name: 'grpc_stream_frames_last_check',
  help: 'Frames received during the last check.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// Total frames ever received, per stream.
const framesTotal = new client.Counter({
  name: 'grpc_stream_frames_total',
  help: 'Total frames received across all checks.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// Payload validation failures, by rule (missing_field|mismatch|empty_frame).
const validationFailTotal = new client.Counter({
  name: 'grpc_stream_validation_fail_total',
  help: 'Frames that failed payload validation, by rule.',
  labelNames: ['stream', 'method', 'addr', 'dc', 'rule'],
  registers: [register],
});

// ---- bookkeeping --------------------------------------------------------------

// Unix time of the last SUCCESSFUL check per stream — alert when it goes stale.
const lastSuccess = new client.Gauge({
  name: 'grpc_stream_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful check for this stream.',
  labelNames: ['stream', 'method', 'addr', 'dc'],
  registers: [register],
});

// Unix time of the last completed run — distinguishes a dead checker from dead streams.
const lastRun = new client.Gauge({
  name: 'grpc_stream_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last completed check run.',
  labelNames: ['addr', 'dc'],
  registers: [register],
});

module.exports = {
  register,
  up,
  checkTotal,
  errorTotal,
  firstFrameMs,
  firstFrameSeconds,
  maxInterFrameMs,
  framesLastCheck,
  framesTotal,
  validationFailTotal,
  lastSuccess,
  lastRun,
};
