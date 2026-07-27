/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests: spin up a real in-process gRPC server (the same proto the
 * demo uses) and run checkStream against it, covering every result the checker
 * can produce: ok, timeout, insufficient_frames, validation_failed, error.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { checkStream } = require('../src/checker');

const PROTO = path.join(__dirname, '..', 'examples', 'price.proto');
const packageDef = protoLoader.loadSync(PROTO, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);

let server;
let addr;

// One server, per-symbol behavior — each test picks its mode via request.symbol.
function priceStream(call) {
  const mode = call.request.symbol;
  if (mode === 'SILENT') return; // stream open, no frames

  if (mode === 'ONE_THEN_HANG') {
    call.write({ symbol: mode, price: 1, ts: Date.now() });
    return; // one frame, then silence
  }

  if (mode === 'BROKEN') {
    call.write({ symbol: '', price: 0, ts: 0 }); // fails "fields" validation
    return;
  }

  // default: healthy — frame every 20ms
  const timer = setInterval(() => {
    call.write({ symbol: mode, price: 100 + Math.random(), ts: Date.now() });
  }, 20);
  call.on('cancelled', () => clearInterval(timer));
  call.on('error', () => clearInterval(timer));
}

before(async () => {
  server = new grpc.Server();
  server.addService(proto.example.v1.PriceService.service, { PriceStream: priceStream });
  addr = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err); else resolve(`127.0.0.1:${port}`);
    });
  });
});

after(() => server.forceShutdown());

const streamDef = (symbol, extra = {}) => ({
  name: 'test_stream',
  proto: PROTO,
  package: 'example.v1',
  service: 'PriceService',
  method: 'PriceStream',
  request: { symbol },
  ...extra,
});

const opts = (over = {}) => ({ addr, tls: false, timeoutMs: 1500, minFrames: 1, ...over });

test('healthy stream with minFrames=3 -> ok, measures first frame and gaps', async () => {
  const out = await checkStream(streamDef('OK'), opts({ minFrames: 3 }));
  assert.equal(out.result, 'ok');
  assert.equal(out.frames, 3);
  assert.ok(out.firstFrameMs > 0, 'firstFrameMs should be measured');
  assert.ok(out.maxGapMs > 0, 'inter-frame gap should be measured for frames > 1');
});

test('payload validation passes for valid frames', async () => {
  const out = await checkStream(
    streamDef('OK', { expect: { fields: ['symbol', 'price', 'ts'], match: { symbol: '/^OK$/' } } }),
    opts({ minFrames: 2 }),
  );
  assert.equal(out.result, 'ok');
});

test('silent stream -> timeout with zero frames', async () => {
  const out = await checkStream(streamDef('SILENT'), opts({ timeoutMs: 500 }));
  assert.equal(out.result, 'timeout');
  assert.equal(out.frames, 0);
});

test('one frame then silence with minFrames=3 -> insufficient_frames', async () => {
  const out = await checkStream(streamDef('ONE_THEN_HANG'), opts({ minFrames: 3, timeoutMs: 500 }));
  assert.equal(out.result, 'insufficient_frames');
  assert.equal(out.frames, 1);
});

test('broken payload -> validation_failed with the failed rule', async () => {
  const out = await checkStream(
    streamDef('BROKEN', { expect: { fields: ['symbol', 'price', 'ts'] } }),
    opts(),
  );
  assert.equal(out.result, 'validation_failed');
  assert.equal(out.failedRule, 'missing_field');
  assert.match(out.error, /symbol/);
});

test('unreachable target -> error with a gRPC status code', async () => {
  const out = await checkStream(
    streamDef('OK', { addr: '127.0.0.1:1' }), // nothing listens on port 1
    opts({ timeoutMs: 2000 }),
  );
  assert.equal(out.result, 'error');
  assert.ok(out.code, `expected a gRPC status code, got: ${out.code}`);
});

test('bad service name in config -> error, does not throw', async () => {
  const out = await checkStream(
    { ...streamDef('OK'), service: 'NoSuchService' },
    opts(),
  );
  assert.equal(out.result, 'error');
  assert.match(out.error, /not found/);
});
