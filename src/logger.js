/*
 * Copyright 2026 Daniil Romashov
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const pretty = process.env.LOG_PRETTY === 'true';

const logger = pino(
  pretty
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level },
);

module.exports = logger;
