/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { buildMetadata } = require('./auth');

// proto files are parsed once and cached across checks.
const packageCache = new Map();

function loadService(streamDef) {
  let packageDef = packageCache.get(streamDef.proto);
  if (!packageDef) {
    packageDef = protoLoader.loadSync(path.resolve(streamDef.proto), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    packageCache.set(streamDef.proto, packageDef);
  }
  const root = grpc.loadPackageDefinition(packageDef);
  const ServiceCtor = resolve(root, `${streamDef.package}.${streamDef.service}`);
  if (typeof ServiceCtor !== 'function') {
    throw new Error(
      `service "${streamDef.package}.${streamDef.service}" not found in ${streamDef.proto}`,
    );
  }
  return ServiceCtor;
}

function resolve(obj, dotted) {
  return dotted.split('.').reduce((node, key) => (node ? node[key] : undefined), obj);
}

/**
 * Open one server-side streaming RPC and measure time to the first frame.
 * Never rejects — always resolves to a structured result so one bad stream
 * can't take down the run.
 *
 * @param {object} streamDef stream definition from config
 * @param {object} opts { addr, tls, timeoutMs, auth }
 * @return {Promise<{result:'ok'|'timeout'|'error', ms:number, error:?string}>}
 */
function checkStream(streamDef, opts) {
  return new Promise((resolve) => {
    let ServiceCtor;
    try {
      ServiceCtor = loadService(streamDef);
    } catch (err) {
      return resolve({ result: 'error', ms: 0, error: err.message });
    }

    const target = streamDef.addr || opts.addr;
    const useTls = streamDef.tls !== undefined ? streamDef.tls : opts.tls;
    const creds = useTls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const clientInstance = new ServiceCtor(target, creds);

    const startedNs = process.hrtime.bigint();
    let settled = false;
    let call;

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (call) call.cancel(); } catch (_) { /* ignore */ }
      try { clientInstance.close(); } catch (_) { /* ignore */ }
      resolve(out);
    };

    const timer = setTimeout(
      () => finish({ result: 'timeout', ms: opts.timeoutMs, error: `no frame within ${opts.timeoutMs}ms` }),
      opts.timeoutMs,
    );

    try {
      call = clientInstance[streamDef.method](streamDef.request || {}, buildMetadata(opts.auth));
    } catch (err) {
      return finish({ result: 'error', ms: 0, error: err.message });
    }

    call.on('data', () => {
      const ms = Number(process.hrtime.bigint() - startedNs) / 1e6;
      finish({ result: 'ok', ms, error: null });
    });
    call.on('error', (err) => {
      // A cancel() after success surfaces here as CANCELLED; the `settled` guard drops it.
      finish({ result: 'error', ms: 0, error: err.message || String(err) });
    });
    call.on('end', () => {
      finish({ result: 'error', ms: 0, error: 'stream ended before any frame arrived' });
    });
  });
}

module.exports = { checkStream };
