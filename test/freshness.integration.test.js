/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 *
 * Freshness against a real in-process server whose frames carry the same
 * instant in four encodings: google.protobuf.Timestamp, RFC 3339 string,
 * int64 epoch milliseconds and double epoch seconds.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { checkStream } = require('../src/checker');

const FIXTURES = path.join(__dirname, 'fixtures');
const PROTO = path.join(FIXTURES, 'clock.proto');
const packageDef = protoLoader.loadSync(PROTO, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [FIXTURES],
});
const clock = grpc.loadPackageDefinition(packageDef);

// request.mode: "fresh" stamps frames with now, "stale" with five minutes ago
function ticks(call) {
  const lagMs = call.request.mode === 'stale' ? 300000 : 0;
  const timer = setInterval(() => {
    const t = Date.now() - lagMs;
    call.write({
      at: { seconds: Math.floor(t / 1000), nanos: (t % 1000) * 1e6 },
      iso: new Date(t).toISOString(),
      epoch_ms: t,
      epoch_s: t / 1000,
    });
  }, 20);
  call.on('cancelled', () => clearInterval(timer));
  call.on('error', () => clearInterval(timer));
}

let server;
let addr;

before(async () => {
  server = new grpc.Server();
  server.addService(clock.test.v1.ClockService.service, { Ticks: ticks });
  addr = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err); else resolve(`127.0.0.1:${port}`);
    });
  });
});

after(() => server.forceShutdown());

const def = (mode, field) => ({
  name: `clock_${field}`,
  proto: PROTO,
  package: 'test.v1',
  service: 'ClockService',
  method: 'Ticks',
  request: { mode },
  freshness: { field, maxAgeSeconds: 30 },
});

const opts = { addr: null, tls: false, timeoutMs: 1500, minFrames: 2, includeDirs: [FIXTURES] };

for (const field of ['at', 'iso', 'epoch_ms', 'epoch_s']) {
  test(`fresh "${field}" -> ok`, async () => {
    const out = await checkStream(def('fresh', field), { ...opts, addr });
    assert.equal(out.result, 'ok', out.error);
    assert.ok(out.dataAgeSeconds < 5, `dataAgeSeconds=${out.dataAgeSeconds}`);
  });

  test(`five-minute-old "${field}" -> stale`, async () => {
    const out = await checkStream(def('stale', field), { ...opts, addr });
    assert.equal(out.result, 'stale');
    assert.ok(out.dataAgeSeconds > 290 && out.dataAgeSeconds < 320, `dataAgeSeconds=${out.dataAgeSeconds}`);
  });
}
