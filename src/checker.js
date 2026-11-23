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
const { resolveViaReflection } = require('./reflection');
const { checkFreshness } = require('./freshness');

// Proto definitions are parsed once per (proto, includeDirs) and cached across checks.
const packageCache = new Map();

// Descriptors fetched through server reflection, cached per (address, TLS, service).
// The value is a Promise so concurrent checks of one service share one lookup.
const reflectionCache = new Map();

function loadFromProto(streamDef, includeDirs) {
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
  return packageDef;
}

function reflectionKey(target, useTls, fqService) {
  return `${target}|${useTls ? 'tls' : 'plain'}|${fqService}`;
}

function loadFromReflection(streamDef, target, useTls, creds, opts) {
  const fqService = `${streamDef.package}.${streamDef.service}`;
  const key = reflectionKey(target, useTls, fqService);
  let pending = reflectionCache.get(key);
  if (!pending) {
    pending = resolveViaReflection({
      target,
      creds,
      symbol: fqService,
      metadata: buildMetadata(opts.auth),
      timeoutMs: opts.timeoutMs,
    });
    reflectionCache.set(key, pending);
    // a failed lookup is not cached: the next run asks the server again
    pending.catch(() => { if (reflectionCache.get(key) === pending) reflectionCache.delete(key); });
  }
  return pending;
}

/** Forget every descriptor fetched through reflection (tests, config reloads). */
function clearReflectionCache() {
  reflectionCache.clear();
}

async function loadService(streamDef, ctx) {
  const packageDef = streamDef.reflection
    ? await loadFromReflection(streamDef, ctx.target, ctx.useTls, ctx.creds, ctx.opts)
    : loadFromProto(streamDef, ctx.opts.includeDirs);
  const root = grpc.loadPackageDefinition(packageDef);
  const ServiceCtor = resolve(root, `${streamDef.package}.${streamDef.service}`);
  if (typeof ServiceCtor !== 'function') {
    const source = streamDef.reflection ? `server reflection at ${ctx.target}` : streamDef.proto;
    throw new Error(`service "${streamDef.package}.${streamDef.service}" not found in ${source}`);
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
 * The schema comes from `streamDef.proto` or, with `streamDef.reflection`,
 * from the server reflection API of the target (cached per address).
 *
 * @param {object} streamDef stream definition from config
 * @param {object} opts { addr, tls, timeoutMs, minFrames, auth, includeDirs }
 * @return {Promise<{
 *   result: 'ok'|'timeout'|'insufficient_frames'|'validation_failed'|'stale'|'error',
 *   firstFrameMs: number, maxGapMs: number, frames: number,
 *   code: ?string, error: ?string, failedRule: ?string,
 *   dataAgeSeconds: ?number  (largest data age seen, only with streamDef.freshness)
 * }>}
 */
function checkStream(streamDef, opts) {
  const target = streamDef.addr || opts.addr;
  const useTls = streamDef.tls !== undefined ? streamDef.tls : opts.tls;
  const creds = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  const ctx = { target, useTls, creds, opts };

  return loadService(streamDef, ctx).then(
    (ServiceCtor) => runStream(ServiceCtor, streamDef, ctx),
    (err) => ({
      result: 'error', firstFrameMs: 0, maxGapMs: 0, frames: 0,
      code: err.code !== undefined && grpc.status[err.code] ? grpc.status[err.code] : null,
      error: err.message, failedRule: null, dataAgeSeconds: null,
    }),
  ).then((out) => {
    // A server redeployed with a changed schema gets re-resolved on the next run.
    if (streamDef.reflection && out.result === 'error') {
      reflectionCache.delete(reflectionKey(target, useTls, `${streamDef.package}.${streamDef.service}`));
    }
    return out;
  });
}

function runStream(ServiceCtor, streamDef, ctx) {
  const { target, creds, opts } = ctx;
  return new Promise((resolvePromise) => {
    const minFrames = streamDef.minFrames || opts.minFrames || 1;
    const clientInstance = new ServiceCtor(target, creds);

    const startedNs = process.hrtime.bigint();
    let lastFrameNs = startedNs;
    let firstFrameMs = 0;
    let maxGapMs = 0;
    let frames = 0;
    let dataAgeSeconds = null;
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
      dataAgeSeconds,
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

      // Freshness: a stream that keeps pushing cached data passes every other check.
      if (streamDef.freshness) {
        const fresh = checkFreshness(frame, streamDef.freshness);
        if (fresh.ageSeconds !== null) {
          dataAgeSeconds = dataAgeSeconds === null ? fresh.ageSeconds : Math.max(dataAgeSeconds, fresh.ageSeconds);
        }
        if (!fresh.ok) return fail(fresh.result, new Error(fresh.detail), fresh.rule);
      }

      if (frames >= minFrames) {
        finish({
          result: 'ok', firstFrameMs, maxGapMs, frames, code: null, error: null, failedRule: null, dataAgeSeconds,
        });
      }
    });

    // cancel() after success surfaces here as CANCELLED; the `settled` guard drops it
    call.on('error', (err) => fail('error', err, null));
    call.on('end', () => fail('error', new Error(`stream ended after ${frames}/${minFrames} frames`), null));
  });
}

module.exports = { checkStream, clearReflectionCache };
