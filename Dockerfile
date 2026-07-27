# Copyright 2026 Daniil Romashov
# SPDX-License-Identifier: Apache-2.0
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY LICENSE NOTICE ./

ENV PORT=4777
EXPOSE 4777
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4777)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
