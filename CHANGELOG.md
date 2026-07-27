# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [1.0.0] — 2026-07-27

First public release.

### Added
- Synthetic checks for gRPC **server-side streams**: open each stream as a real client,
  demand `minFrames` frames within a time budget (sustained flow, not just the first frame).
- **Per-frame payload validation** (`expect`): required fields, exact matches, `/regex/` matches,
  empty-frame detection.
- Runtime `.proto` loading via `@grpc/proto-loader` (no codegen), with `protoIncludeDirs`
  for imports.
- **11 Prometheus metrics** labelled by `stream`/`method`/`addr`/`dc`: up, checks by result,
  errors by gRPC code, first-frame gauge + histogram, max inter-frame gap, frames per
  check/total, validation failures by rule, last-success/last-run timestamps.
- Ready-made **Prometheus alert rules** (`alerts/`): stream down, slow first frame,
  stuttering, invalid payloads, gRPC errors, no recent success, dead checker.
- **Kubernetes manifests** (`deploy/kubernetes/`): Deployment with probes/resources/hardened
  securityContext, ConfigMaps, Service, ServiceMonitor + PrometheusRule.
- Demo gRPC server (`examples/demo-server.js`) with `--silent` / `--broken` / `--slow`
  failure modes; 60-second quick start.
- Config validation at startup (fail fast, exit code 2), overlapping-run guard,
  graceful SIGTERM/SIGINT shutdown, `--once` CI-gate mode, `--only=` stream filter.
- Test suite (unit + integration against a real in-process gRPC server), CI on Node 18/20/22.
