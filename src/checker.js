/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { buildMetadata } = require('./auth');
const { validateFrame } = require('./validate');

// Proto definitions are parsed once per (proto, includeDirs) and cached across checks.
const packageCache = new Map();

function loadService(streamDef, includeDirs) {
  const cacheKey = `${streamDef.proto}::${(includeDirs || []).join(',')}`;
  let packageDef = packageCache.get(cacheKey);
  if (!packageDef) {
    packageDef = protoLoader.loadSync(path.resolve(streamDef.proto), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      // lets your proto `import "common/types.proto";` resolve
      includeDirs: (includeDirs || []).map((d) => path.resolve(d)),
    });
    packageCache.set(cacheKey, packageDef);
  }
  const root = grpc.loadPackageDefinition(packageDef);
  const ServiceCtor = resolve(root, `${streamDef.package}.${streamDef.service}`);
  if (typeof ServiceCtor !== 'function') {
    throw new Error(`service "${streamDef.package}.${streamDef.service}" not found in ${streamDef.proto}`);
  }
  return ServiceCtor;
}

function resolve(obj, dotted) {
  return dotted.split('.').reduce((node, key) => (node ? node[key] : undefined), obj);
}

/**
 * Open one server-side streaming RPC and consume it like a real client.
 *
 * The check collects up to `minFrames` frames (default 1) within `timeoutMs`,
 * validating each frame's payload against `streamDef.expect`. It measures
 * time-to-first-frame and the largest inter-frame gap, then cancels the stream.
 *
 * Never rejects — always resolves to a structured result so one bad stream
 * cannot take down the whole run.
 *
 * @param {object} streamDef stream definition from config
 * @param {object} opts { addr, tls, timeoutMs, minFrames, auth, includeDirs }
 * @return {Promise<{
 *   result: 'ok'|'timeout'|'insufficient_frames'|'validation_failed'|'error',
 *   firstFrameMs: number, maxGapMs: number, frames: number,
 *   code: ?string, error: ?string, failedRule: ?string
 * }>}
 */
function checkStream(streamDef, opts) {
  return new Promise((resolvePromise) => {
    const minFrames = streamDef.minFrames || opts.minFrames || 1;

    let ServiceCtor;
    try {
      ServiceCtor = loadService(streamDef, opts.includeDirs);
    } catch (err) {
      return resolvePromise({
        result: 'error', firstFrameMs: 0, maxGapMs: 0, frames: 0,
        code: null, error: err.message, failedRule: null,
      });
    }

    const target = streamDef.addr || opts.addr;
    const useTls = streamDef.tls !== undefined ? streamDef.tls : opts.tls;
    const creds = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    const clientInstance = new ServiceCtor(target, creds);

    const startedNs = process.hrtime.bigint();
    let lastFrameNs = startedNs;
    let firstFrameMs = 0;
    let maxGapMs = 0;
    let frames = 0;
    let settled = false;
    let call;

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (call) call.cancel(); } catch (_) { /* ignore */ }
      try { clientInstance.close(); } catch (_) { /* ignore */ }
      resolvePromise(out);
    };

    const fail = (result, err, rule) => finish({
      result,
      firstFrameMs,
      maxGapMs,
      frames,
      code: err && err.code !== undefined ? (grpc.status[err.code] || String(err.code)) : null,
      error: err ? (err.message || String(err)) : null,
      failedRule: rule || null,
    });

    const timer = setTimeout(() => {
      if (frames === 0) fail('timeout', new Error(`no frame within ${opts.timeoutMs}ms`), null);
      else fail('insufficient_frames', new Error(`only ${frames}/${minFrames} frames within ${opts.timeoutMs}ms`), null);
    }, opts.timeoutMs);

    try {
      // deadline caps the call at the gRPC layer too, not only our timer
      call = clientInstance[streamDef.method](
        streamDef.request || {},
        buildMetadata(opts.auth),
        { deadline: new Date(Date.now() + opts.timeoutMs + 1000) },
      );
    } catch (err) {
      return fail('error', err, null);
    }

    call.on('data', (frame) => {
      if (settled) return;
      frames += 1;
      const now = process.hrtime.bigint();
      if (frames === 1) {
        firstFrameMs = Number(now - startedNs) / 1e6;
      } else {
        maxGapMs = Math.max(maxGapMs, Number(now - lastFrameNs) / 1e6);
      }
      lastFrameNs = now;

      const verdict = validateFrame(frame, streamDef.expect);
      if (!verdict.ok) return fail('validation_failed', new Error(verdict.detail), verdict.rule);

      if (frames >= minFrames) {
        finish({
          result: 'ok', firstFrameMs, maxGapMs, frames, code: null, error: null, failedRule: null,
        });
      }
    });

    // cancel() after success surfaces here as CANCELLED; the `settled` guard drops it
    call.on('error', (err) => fail('error', err, null));
    call.on('end', () => fail('error', new Error(`stream ended after ${frames}/${minFrames} frames`), null));
  });
}

module.exports = { checkStream };
