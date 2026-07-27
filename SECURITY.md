# Security Policy

## Supported versions

The latest release on `main` is supported with security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead use GitHub's
[private vulnerability reporting](https://github.com/youngpabl0/grpc-streams-checker/security/advisories/new)
on this repository. You'll get an acknowledgement within a few days.

Notes for operators:

- The checker holds credentials only in memory (env-expanded `${VARS}`); never commit
  a `streams.json` containing literal tokens — keep secrets in the environment / a Secret.
- The `/metrics` endpoint exposes stream names, methods, and target addresses — scrape
  it inside your network; don't expose port 4777 publicly.
