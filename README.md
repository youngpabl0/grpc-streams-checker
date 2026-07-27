# grpc-streams-checker

Synthetic monitoring for gRPC **server-side streams** — because a healthy connection, a
successful handshake, and a green health check do **not** mean data is actually flowing.

[![CI](https://github.com/youngpabl0/grpc-streams-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/youngpabl0/grpc-streams-checker/actions)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## Why

Uptime checks are a solved problem for request/response APIs: hit the endpoint, get a status code,
done. Server-side streaming RPCs break that model. A gRPC stream is a channel the server holds open
and pushes messages into over time — so the socket can be up, the handshake can succeed, the health
endpoint can be green, and yet **no frames are arriving**. Standard probes report "healthy" while
consumers get nothing.

`grpc-streams-checker` answers the only question that matters for a stream: **is it producing?** It
opens each configured stream as a real client, waits for the first frame within a time budget, and
exports the result as Prometheus metrics you can alert on.

## How it works

On each run, for every stream in your config, the checker:

1. loads the `.proto` at runtime (via `@grpc/proto-loader` — no codegen step);
2. opens the server-side streaming RPC as a client;
3. waits for the **first frame** within `firstFrameTimeoutMs`;
4. records: time-to-first-frame, an `up` gauge, and a per-result counter — labelled by stream / addr / dc.

It never lets one bad stream fail the run, and it cancels each stream as soon as the first frame lands.

## Install

```bash
git clone https://github.com/youngpabl0/grpc-streams-checker.git
cd grpc-streams-checker
npm ci
```

## Configure

```bash
cp streams.example.json streams.json
```

```jsonc
{
  "addr": "localhost:50051",      // default target host:port for all streams
  "dc": "dev",                    // datacenter/label
  "tls": false,                   // TLS on by default; set false for plaintext
  "intervalSeconds": 30,          // how often to run the checks
  "firstFrameTimeoutMs": 5000,    // a stream must produce a frame within this budget
  "streams": [
    {
      "name": "price_stream",     // metric label; also the --only key
      "proto": "examples/price.proto",
      "package": "example.v1",
      "service": "PriceService",
      "method": "PriceStream",     // a server-side streaming RPC
      "request": { "symbol": "BTCUSD" },
      "addr": "other-host:443",    // optional per-stream override
      "tls": true                  // optional per-stream override
    }
  ]
}
```

**Auth (optional).** Add an `auth` block; `${ENV}` placeholders expand at runtime so secrets stay out
of the file:

```jsonc
"auth": { "token": "${GRPC_TOKEN}", "metadata": { "x-tenant": "${TENANT_ID}" } }
```

For anything more involved (minting a JWT, AWS SigV4, mTLS) extend the single seam in
[`src/auth.js`](src/auth.js).

## Run

```bash
npm start                       # loop forever on intervalSeconds
node src/index.js --once        # run one pass and exit (great for CI / cron)
node src/index.js --only=price_stream   # check only named streams (debugging)
```

Environment overrides: `CONFIG`, `ADDR`, `DC`, `PORT` (default 4777), `TIMEOUT_MS`,
`INTERVAL_SECONDS`, `LOG_LEVEL`, `LOG_PRETTY=true`.

## Metrics

Served at `http://localhost:4777/metrics` (`/healthz` for liveness):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `grpc_stream_first_frame_ms` | gauge | stream, addr, dc | ms to first frame on the last check |
| `grpc_stream_up` | gauge | stream, addr, dc | 1 if a frame arrived within the timeout, else 0 |
| `grpc_stream_check_total` | counter | stream, addr, dc, result | checks by result (`ok`/`timeout`/`error`) |
| `grpc_stream_last_run_timestamp_seconds` | gauge | addr, dc | unix time of the last completed run |

## Alerting (PromQL)

```promql
# a stream opened but produced no frame — the failure uptime checks miss
grpc_stream_up == 0

# early warning: first frame getting slow before it goes dark
grpc_stream_first_frame_ms > 2000

# error rate per stream
rate(grpc_stream_check_total{result="error"}[5m]) > 0

# the checker itself died (no run recently)
time() - max by (dc) (grpc_stream_last_run_timestamp_seconds) > 120
```

## Docker

```bash
docker build -t grpc-streams-checker .
docker run -p 4777:4777 -v "$PWD/streams.json:/app/streams.json:ro" grpc-streams-checker
```

## The pattern generalizes

The same "open it and watch for a frame" approach works for any long-lived push transport —
WebSocket, SSE, message-queue consumers. The value is turning "is data flowing?" into a labelled
metric you page yourself about, instead of something a customer reports.

## License

[Apache License 2.0](LICENSE) — free to use, modify, and distribute; keep the copyright/`NOTICE`.
Copyright 2026 Daniil Romashov.
