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
 */
'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDef = protoLoader.loadSync(path.join(__dirname, 'price.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);

const silent = process.argv.includes('--silent');
const broken = process.argv.includes('--broken');
const slowArg = process.argv.find((a) => a.startsWith('--slow='));
const delayMs = slowArg ? Number(slowArg.split('=')[1]) : 200;

function priceStream(call) {
  const symbol = call.request.symbol || 'BTCUSD';
  if (silent) return; // stream stays open, no frames — the failure uptime checks miss

  const timer = setInterval(() => {
    if (broken) {
      call.write({ symbol: '', price: 0, ts: 0 }); // fails "fields" validation
    } else {
      call.write({ symbol, price: 50000 + Math.random() * 1000, ts: Date.now() });
    }
  }, delayMs);

  call.on('cancelled', () => clearInterval(timer));
  call.on('error', () => clearInterval(timer));
}

const server = new grpc.Server();
server.addService(proto.example.v1.PriceService.service, { PriceStream: priceStream });
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) { console.error(err); process.exit(1); }
  const mode = silent ? 'silent' : broken ? 'broken' : `normal (frame every ${delayMs}ms)`;
  console.log(`demo PriceService on :50051 — mode: ${mode}`);
});
