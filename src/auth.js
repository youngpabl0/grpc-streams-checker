/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const grpc = require('@grpc/grpc-js');

/**
 * Build gRPC call metadata for a stream.
 *
 * Default behaviour is no auth. If `auth.token` is set it is sent as
 * `authorization: Bearer <token>`; `auth.metadata` sets arbitrary headers.
 * Both support `${ENV_VAR}` expansion so secrets stay out of the config file.
 *
 * This is the single seam to extend for real auth — mint a JWT, sign a
 * request (e.g. AWS SigV4), or attach mTLS — without touching the checker.
 *
 * @param {object} [auth] optional auth config
 * @return {grpc.Metadata}
 */
function buildMetadata(auth) {
  const md = new grpc.Metadata();
  if (auth && auth.token) {
    const token = expandEnv(auth.token);
    if (token) md.set('authorization', `Bearer ${token}`);
  }
  if (auth && auth.metadata) {
    for (const [key, value] of Object.entries(auth.metadata)) {
      md.set(key, expandEnv(String(value)));
    }
  }
  return md;
}

function expandEnv(value) {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] || '');
}

module.exports = { buildMetadata };
