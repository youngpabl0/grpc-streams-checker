# Contributing

Thanks for considering a contribution — issues, docs, and PRs are all welcome.

## Dev setup

```bash
git clone https://github.com/youngpabl0/grpc-streams-checker.git
cd grpc-streams-checker
npm ci
npm test        # 30+ unit & integration tests, ~1s (node:test, no extra deps)
npm run lint
```

Try it end-to-end without any infrastructure:

```bash
node examples/demo-server.js &      # demo gRPC server on :50051
cp streams.example.json streams.json
node src/index.js --once
```

## Pull requests

- Keep the dependency footprint small — this tool is deliberately light; new runtime
  dependencies need a good reason.
- Add or update tests for behavior changes (`test/` — unit for pure logic, the
  integration suite spins a real in-process gRPC server).
- `npm test && npm run lint` must pass; CI runs both on Node 18/20/22.
- New metrics: follow the existing label set (`stream`, `method`, `addr`, `dc`) and
  document them in the README metrics table + consider an alert rule in
  `alerts/grpc-streams-checker.rules.yml`.
- Keep the SPDX header (`Apache-2.0`) on new source files.

## Reporting bugs

Open an issue with the checker version, Node version, a redacted `streams.json`,
and the JSON log lines around the failure. For security issues see [SECURITY.md](SECURITY.md).
