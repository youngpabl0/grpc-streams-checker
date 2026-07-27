# Copyright 2026 Daniil Romashov
# SPDX-License-Identifier: Apache-2.0
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=4777
EXPOSE 4777
USER node

CMD ["node", "src/index.js"]
