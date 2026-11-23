#!/usr/bin/env node
/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tiny demo gRPC server so you can try the checker end-to-end:
 *
 *   node examples/demo-server.js          # serves PriceStream on :50051
 *   cp streams.example.json streams.json
 *   node src/index.js --once              # all checks should pass
 *
 * Flags for failure-mode demos:
 *   --silent      open the stream but never send a frame  -> result: timeout
 *   --broken      send frames with missing fields         -> result: validation_failed
 *   --slow=2000   delay between frames, ms                -> watch max_inter_frame_ms
 *   --stale       keep sending one cached tick, 60s old    -> result: stale (with a freshness rule)
 *   --error=UNAVAILABLE   end every stream with this gRPC status -> result: error{code}
 *
 * Extra knobs (used by the docker-compose demo stack):
 *   --port=50051  listen port
 *   --jitter=300  add a random 0..N ms to every frame delay
 *   --cycle=120   rotate through normal, slow, broken, silent, error,
 *                 spending N seconds in each phase (failures and recoveries)
 *   --reflection  also serve the gRPC server reflection API (v1 and v1alpha),
 *                 so a stream config can use "reflection": true instead of a .proto
 */
'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDef = protoLoader.loadSync(path.join(__dirname, 'price.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);

function flag(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
}

const silent = process.argv.includes('--silent');
const broken = process.argv.includes('--broken');
const stale = process.argv.includes('--stale');
const errorCode = flag('error');
const delayMs = flag('slow') ? Number(flag('slow')) : 200;
const jitterMs = Number(flag('jitter') || 0);
const port = Number(flag('port') || 50051);
const cycleSeconds = Number(flag('cycle') || 0);
const reflection = process.argv.includes('--reflection');

const CYCLE = ['normal', 'slow', 'broken', 'silent', 'error'];
const startedAt = Date.now();

// The mode in force right now: fixed by flags, or rotating with --cycle.
function currentMode() {
  if (cycleSeconds > 0) {
    const phase = Math.floor((Date.now() - startedAt) / 1000 / cycleSeconds);
    return CYCLE[phase % CYCLE.length];
  }
  if (silent) return 'silent';
  if (broken) return 'broken';
  if (stale) return 'stale';
  if (errorCode) return 'error';
  return 'normal';
}

function priceStream(call) {
  const symbol = call.request.symbol || 'BTCUSD';
  const mode = currentMode();
  if (mode === 'silent') return; // stream stays open, no frames: the failure uptime checks miss

  if (mode === 'error') {
    const name = errorCode || 'UNAVAILABLE';
    const code = grpc.status[name] !== undefined ? grpc.status[name] : grpc.status.UNAVAILABLE;
    call.emit('error', { code, details: `demo server: ${name}` });
    return;
  }

  // In --cycle mode the "slow" phase has its own pace; otherwise --slow sets it.
  const baseDelay = mode === 'slow' ? 1500 : delayMs;
  let timer;
  const next = () => {
    timer = setTimeout(() => {
      if (mode === 'broken') {
        call.write({ symbol: '', price: 0, ts: 0 }); // fails "fields" validation
      } else if (mode === 'stale') {
        // the same snapshot over and over: frames flow, payloads are valid, data is old
        call.write({ symbol, price: 50123.45, ts: startedAt - 60000 });
      } else {
        call.write({ symbol, price: 50000 + Math.random() * 1000, ts: Date.now() });
      }
      next();
    }, baseDelay + Math.random() * jitterMs);
  };
  next();

  call.on('cancelled', () => clearTimeout(timer));
  call.on('error', () => clearTimeout(timer));
}

const server = new grpc.Server();
server.addService(proto.example.v1.PriceService.service, { PriceStream: priceStream });
if (reflection) {
  // required lazily: @grpc/reflection is a dev dependency, only this flag needs it
  const { ReflectionService } = require('@grpc/reflection');
  new ReflectionService(packageDef).addToServer(server);
}
server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) { console.error(err); process.exit(1); }
  let mode;
  if (cycleSeconds > 0) mode = `cycle (${CYCLE.join(' > ')}, ${cycleSeconds}s each)`;
  else if (silent) mode = 'silent';
  else if (broken) mode = 'broken';
  else if (stale) mode = 'stale (cached tick, 60s old)';
  else if (errorCode) mode = `error ${errorCode}`;
  else mode = `normal (frame every ${delayMs}ms${jitterMs ? `, up to ${jitterMs}ms jitter` : ''})`;
  console.log(`demo PriceService on :${port}, mode: ${mode}${reflection ? ', reflection on' : ''}`);
});
