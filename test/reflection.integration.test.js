/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests for streams that resolve their schema through gRPC server
 * reflection instead of a local .proto file. Three in-process servers:
 *   - full:     PriceService + @grpc/reflection (v1 and v1alpha)
 *   - alpha:    ClockService + a hand-rolled v1alpha-only reflection service that
 *               answers one file at a time and does not serve well-known types
 *   - none:     PriceService without reflection
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { ReflectionService } = require('@grpc/reflection');
const { checkStream, clearReflectionCache } = require('../src/checker');
const descriptor = require('protobufjs/ext/descriptor');
const { fileDescriptorInfo, fileDescriptorSet, wellKnownDescriptors } = require('../src/reflection');

const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const PRICE_PROTO = path.join(__dirname, '..', 'examples', 'price.proto');
const FIXTURES = path.join(__dirname, 'fixtures');

const priceDef = protoLoader.loadSync(PRICE_PROTO, LOADER);
const price = grpc.loadPackageDefinition(priceDef);
const clockDef = protoLoader.loadSync(path.join(FIXTURES, 'clock.proto'), { ...LOADER, includeDirs: [FIXTURES] });
const clock = grpc.loadPackageDefinition(clockDef);

function priceStream(call) {
  const timer = setInterval(() => {
    call.write({ symbol: call.request.symbol, price: 100, ts: Date.now() });
  }, 20);
  call.on('cancelled', () => clearInterval(timer));
  call.on('error', () => clearInterval(timer));
}

function ticks(call) {
  const timer = setInterval(() => {
    const now = Date.now();
    call.write({ iso: new Date(now).toISOString(), epoch_ms: now });
  }, 20);
  call.on('cancelled', () => clearInterval(timer));
  call.on('error', () => clearInterval(timer));
}

// The clock fixture as one FileDescriptorProto per source file, the way protoc
// based servers (Go, Java, C++) publish them. proto-loader would merge files per
// package, so these are built by hand from test/fixtures/*.proto.
const OPTIONAL = 1;
const clockFiles = new Map([
  ['clock.proto', {
    name: 'clock.proto',
    package: 'test.v1',
    dependency: ['common/clock_types.proto'],
    service: [{
      name: 'ClockService',
      method: [{ name: 'Ticks', inputType: '.test.v1.TickRequest', outputType: '.test.v1.Tick', serverStreaming: true }],
    }],
    syntax: 'proto3',
  }],
  ['common/clock_types.proto', {
    name: 'common/clock_types.proto',
    package: 'test.v1',
    dependency: ['google/protobuf/timestamp.proto'],
    messageType: [
      { name: 'TickRequest', field: [{ name: 'mode', number: 1, label: OPTIONAL, type: 9 }] },
      {
        name: 'Tick',
        field: [
          { name: 'at', number: 1, label: OPTIONAL, type: 11, typeName: '.google.protobuf.Timestamp' },
          { name: 'iso', number: 2, label: OPTIONAL, type: 9 },
          { name: 'epoch_ms', number: 3, label: OPTIONAL, type: 3 },
          { name: 'epoch_s', number: 4, label: OPTIONAL, type: 1 },
        ],
      },
    ],
    syntax: 'proto3',
  }],
].map(([name, obj]) => [name, Buffer.from(descriptor.FileDescriptorProto.encode(obj).finish())]));

// Counts reflection requests the alpha server received, by kind.
const alphaRequests = { symbol: 0, file: 0 };

// A v1alpha-only reflection service: returns just the file that was asked for
// (never its imports) and refuses google/protobuf/*, like some minimal servers.
function alphaReflection() {
  const file = path.join(__dirname, '..', 'src', 'proto', 'grpc', 'reflection', 'v1alpha', 'reflection.proto');
  const pkg = grpc.loadPackageDefinition(protoLoader.loadSync(file, LOADER));
  const byName = clockFiles;
  const notFound = (req, msg) => ({
    original_request: req,
    error_response: { error_code: grpc.status.NOT_FOUND, error_message: msg },
  });
  const impl = {
    ServerReflectionInfo(call) {
      call.on('data', (req) => {
        if (req.file_containing_symbol) {
          alphaRequests.symbol += 1;
          if (req.file_containing_symbol === 'test.v1.ClockService') {
            call.write({ original_request: req, file_descriptor_response: { file_descriptor_proto: [byName.get('clock.proto')] } });
          } else {
            call.write(notFound(req, `symbol ${req.file_containing_symbol} not found`));
          }
        } else if (req.file_by_filename) {
          alphaRequests.file += 1;
          const buf = req.file_by_filename.startsWith('google/') ? null : byName.get(req.file_by_filename);
          if (buf) call.write({ original_request: req, file_descriptor_response: { file_descriptor_proto: [buf] } });
          else call.write(notFound(req, `file ${req.file_by_filename} not found`));
        }
      });
      call.on('end', () => call.end());
    },
  };
  return { service: pkg.grpc.reflection.v1alpha.ServerReflection.service, impl };
}

async function bind(server) {
  return new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err); else resolve(`127.0.0.1:${port}`);
    });
  });
}

const servers = [];
let fullAddr;
let alphaAddr;
let noneAddr;

before(async () => {
  const full = new grpc.Server();
  servers.push(full);
  full.addService(price.example.v1.PriceService.service, { PriceStream: priceStream });
  new ReflectionService(priceDef).addToServer(full);
  fullAddr = await bind(full);

  const alpha = new grpc.Server();
  servers.push(alpha);
  alpha.addService(clock.test.v1.ClockService.service, { Ticks: ticks });
  const r = alphaReflection();
  alpha.addService(r.service, r.impl);
  alphaAddr = await bind(alpha);

  const none = new grpc.Server();
  servers.push(none);
  none.addService(price.example.v1.PriceService.service, { PriceStream: priceStream });
  noneAddr = await bind(none);
});

after(() => servers.forEach((s) => s.forceShutdown()));

beforeEach(() => clearReflectionCache());

const priceDefNoProto = (extra = {}) => ({
  name: 'reflected_price',
  reflection: true,
  package: 'example.v1',
  service: 'PriceService',
  method: 'PriceStream',
  request: { symbol: 'BTCUSD' },
  ...extra,
});

const opts = (addr, over = {}) => ({ addr, tls: false, timeoutMs: 1500, minFrames: 1, ...over });

test('reflection (v1): stream without a .proto resolves and passes validation', async () => {
  const out = await checkStream(
    priceDefNoProto({ expect: { fields: ['symbol', 'price', 'ts'], match: { symbol: 'BTCUSD' } } }),
    opts(fullAddr, { minFrames: 3 }),
  );
  assert.equal(out.result, 'ok', out.error);
  assert.equal(out.frames, 3);
});

test('reflection (v1alpha fallback): fetches imports one by one, tolerates missing well-known types', async () => {
  alphaRequests.symbol = 0;
  alphaRequests.file = 0;
  const def = {
    name: 'reflected_clock',
    reflection: true,
    package: 'test.v1',
    service: 'ClockService',
    method: 'Ticks',
    request: { mode: 'ok' },
    expect: { fields: ['iso', 'epoch_ms'] },
  };
  const out = await checkStream(def, opts(alphaAddr, { minFrames: 2 }));
  assert.equal(out.result, 'ok', out.error);
  assert.equal(alphaRequests.symbol, 1);
  // common/clock_types.proto, then google/protobuf/timestamp.proto (refused, bundled locally)
  assert.equal(alphaRequests.file, 2);
});

test('reflection descriptors are cached per address', async () => {
  alphaRequests.symbol = 0;
  const def = {
    name: 'reflected_clock', reflection: true, package: 'test.v1',
    service: 'ClockService', method: 'Ticks', request: {},
  };
  assert.equal((await checkStream(def, opts(alphaAddr))).result, 'ok');
  assert.equal((await checkStream(def, opts(alphaAddr))).result, 'ok');
  assert.equal(alphaRequests.symbol, 1, 'second check must reuse the cached descriptor');
});

test('server without reflection -> error result naming both API versions', async () => {
  const out = await checkStream(priceDefNoProto(), opts(noneAddr));
  assert.equal(out.result, 'error');
  assert.equal(out.code, 'UNIMPLEMENTED');
  assert.match(out.error, /server reflection is not available/);
  assert.match(out.error, /grpc\.reflection\.v1\b/);
  assert.match(out.error, /grpc\.reflection\.v1alpha/);
});

test('unknown service over reflection -> error result, not a throw', async () => {
  const out = await checkStream(priceDefNoProto({ service: 'NoSuchService' }), opts(fullAddr));
  assert.equal(out.result, 'error');
  assert.match(out.error, /NoSuchService/);
});

test('unreachable target with reflection -> error with a gRPC status code', async () => {
  const out = await checkStream(priceDefNoProto(), opts('127.0.0.1:1', { timeoutMs: 1000 }));
  assert.equal(out.result, 'error');
  assert.ok(out.code, `expected a gRPC status code, got: ${out.code}`);
});

test('fileDescriptorInfo / fileDescriptorSet round-trip through proto-loader', () => {
  const files = [...clockFiles.values(), ...wellKnownDescriptors(['google/protobuf/timestamp.proto'])];
  const info = fileDescriptorInfo(clockFiles.get('clock.proto'));
  assert.equal(info.name, 'clock.proto');
  assert.deepEqual(info.dependencies, ['common/clock_types.proto']);
  const def = protoLoader.loadFileDescriptorSetFromBuffer(fileDescriptorSet(files), LOADER);
  assert.ok(def['test.v1.ClockService'], 'service survives the round-trip');
});
