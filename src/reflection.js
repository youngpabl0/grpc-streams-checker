/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

/**
 * Minimal client for the gRPC Server Reflection API.
 *
 * Given a target and a fully-qualified service name, it asks the server for the
 * file that declares the service, then for every file that file imports
 * (transitively), and turns the collected FileDescriptorProtos into a
 * proto-loader package definition. The checker then builds a client from it
 * exactly as it does from a local .proto file.
 *
 * grpc.reflection.v1 is tried first; servers that only implement the older
 * grpc.reflection.v1alpha (still common) are handled by a fallback.
 */

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const LOADER_OPTS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const VERSIONS = ['v1', 'v1alpha'];

// Reflection protos ship in src/proto (copied from the gRPC project, Apache-2.0).
const reflectionStubs = {};
function reflectionStub(version) {
  if (!reflectionStubs[version]) {
    const file = path.join(__dirname, 'proto', 'grpc', 'reflection', version, 'reflection.proto');
    const pkg = grpc.loadPackageDefinition(protoLoader.loadSync(file, LOADER_OPTS));
    reflectionStubs[version] = pkg.grpc.reflection[version].ServerReflection;
  }
  return reflectionStubs[version];
}

/**
 * Read the `name` (field 1) and `dependency` (field 3) of a serialized
 * FileDescriptorProto without a full descriptor decoder.
 *
 * @param {Buffer} buf serialized google.protobuf.FileDescriptorProto
 * @return {{name: string, dependencies: string[]}}
 */
function fileDescriptorInfo(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= buf.length) throw new Error('truncated FileDescriptorProto');
      const byte = buf[pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
      shift += 7;
    }
  };
  let name = '';
  const dependencies = [];
  while (pos < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) varint();
    else if (wireType === 1) pos += 8;
    else if (wireType === 5) pos += 4;
    else if (wireType === 2) {
      const len = varint();
      const value = buf.subarray(pos, pos + len);
      pos += len;
      if (field === 1) name = value.toString('utf8');
      else if (field === 3) dependencies.push(value.toString('utf8'));
    } else {
      throw new Error(`unsupported wire type ${wireType} in FileDescriptorProto`);
    }
  }
  return { name, dependencies };
}

/**
 * Wrap serialized FileDescriptorProtos into a serialized FileDescriptorSet
 * (`repeated FileDescriptorProto file = 1`).
 *
 * @param {Buffer[]} files
 * @return {Buffer}
 */
function fileDescriptorSet(files) {
  const parts = [];
  for (const file of files) {
    const len = [];
    let n = file.length;
    while (n >= 0x80) { len.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    len.push(n);
    parts.push(Buffer.from([0x0a, ...len]), file);
  }
  return Buffer.concat(parts);
}

/**
 * Local descriptors for google/protobuf/*.proto files the server did not serve.
 * proto-loader bundles the well-known types; loading them together yields one
 * descriptor file that defines every requested type.
 */
function wellKnownDescriptors(fileNames) {
  const def = protoLoader.loadSync(fileNames, LOADER_OPTS);
  const anyType = Object.values(def).find((t) => t && t.fileDescriptorProtos);
  return anyType ? anyType.fileDescriptorProtos : [];
}

function reflectionError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Collect the descriptor of `symbol` and its transitive imports over one
 * reflection stream of the given API version.
 */
function collectFiles(version, target, creds, symbol, metadata, deadline) {
  return new Promise((resolve, reject) => {
    const Stub = reflectionStub(version);
    const client = new Stub(target, creds);
    const files = new Map(); // file name -> serialized descriptor
    const missingWellKnown = [];
    const requested = new Set();
    let pending = 0;
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      try { call.end(); } catch (_) { /* ignore */ }
      try { call.cancel(); } catch (_) { /* ignore */ }
      client.close();
      if (err) reject(err); else resolve(value);
    };

    const call = client.ServerReflectionInfo(metadata, { deadline });

    const request = (msg, key) => {
      if (requested.has(key)) return;
      requested.add(key);
      pending += 1;
      call.write(msg);
    };

    call.on('data', (res) => {
      if (done) return;
      pending -= 1;
      if (res.message_response === 'error_response') {
        const e = res.error_response || {};
        const asked = res.original_request || {};
        const what = asked.file_containing_symbol || asked.file_by_filename || symbol;
        // Well-known types are bundled with protobufjs, a server need not serve them.
        if (asked.file_by_filename && asked.file_by_filename.startsWith('google/protobuf/')) {
          missingWellKnown.push(asked.file_by_filename);
          if (pending === 0) finish(null, { files: [...files.values()], missingWellKnown });
          return;
        }
        const codeName = grpc.status[e.error_code] || 'NOT_FOUND';
        finish(reflectionError(`reflection: "${what}" not found on the server: ${e.error_message || codeName}`, e.error_code || grpc.status.NOT_FOUND));
        return;
      }
      const protos = (res.file_descriptor_response && res.file_descriptor_response.file_descriptor_proto) || [];
      for (const buf of protos) {
        let info;
        try {
          info = fileDescriptorInfo(buf);
        } catch (err) {
          finish(err);
          return;
        }
        if (!files.has(info.name)) files.set(info.name, buf);
      }
      // ask for imports the server did not volunteer
      for (const buf of protos) {
        for (const dep of fileDescriptorInfo(buf).dependencies) {
          if (!files.has(dep)) request({ file_by_filename: dep }, `file:${dep}`);
        }
      }
      if (pending === 0) finish(null, { files: [...files.values()], missingWellKnown });
    });
    call.on('error', (err) => finish(err));
    call.on('end', () => finish(reflectionError('reflection stream ended before all descriptors arrived', grpc.status.UNAVAILABLE)));

    request({ file_containing_symbol: symbol }, `symbol:${symbol}`);
  });
}

/**
 * Resolve a service through server reflection and return a proto-loader
 * package definition containing it and everything it depends on.
 *
 * @param {object} p
 * @param {string} p.target host:port
 * @param {grpc.ChannelCredentials} p.creds
 * @param {string} p.symbol fully-qualified service name, e.g. "example.v1.PriceService"
 * @param {grpc.Metadata} [p.metadata] call metadata (auth)
 * @param {number} [p.timeoutMs] deadline for the reflection exchange
 * @return {Promise<object>} package definition
 */
async function resolveViaReflection({ target, creds, symbol, metadata, timeoutMs = 5000 }) {
  const errors = [];
  for (const version of VERSIONS) {
    try {
      const { files, missingWellKnown } = await collectFiles(
        version, target, creds, symbol,
        metadata || new grpc.Metadata(),
        new Date(Date.now() + timeoutMs),
      );
      if (missingWellKnown.length) files.push(...wellKnownDescriptors(missingWellKnown));
      if (files.length === 0) throw reflectionError(`reflection: server returned no descriptor for "${symbol}"`, grpc.status.NOT_FOUND);
      return protoLoader.loadFileDescriptorSetFromBuffer(fileDescriptorSet(files), LOADER_OPTS);
    } catch (err) {
      // only "this API version is not implemented" moves on to the next version
      if (err.code === grpc.status.UNIMPLEMENTED) {
        errors.push(`grpc.reflection.${version}: ${err.details || err.message}`);
        continue;
      }
      throw err;
    }
  }
  throw reflectionError(
    `server reflection is not available at ${target} (tried ${VERSIONS.map((v) => `grpc.reflection.${v}`).join(', ')}): ${errors.join('; ')}`,
    grpc.status.UNIMPLEMENTED,
  );
}

module.exports = {
  resolveViaReflection, fileDescriptorInfo, fileDescriptorSet, wellKnownDescriptors,
};
