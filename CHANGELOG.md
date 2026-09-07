# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

### Added

- TypeScript project scaffold: strict `tsconfig.json`, ESLint, Prettier, Vitest, and an
  esbuild bundle producing the single CommonJS file behind the `handoff-mcp` binary.
- CLI entry routing the five subcommands (`serve`, `hook stop`, `validate`,
  `runbooks search`, `doctor`) plus `--help` and `--version`. The subcommands are
  placeholders until the tasks named in their message implement them.
- Continuous integration on Linux and Windows with Node 22 and 24; the macOS leg runs on
  manual dispatch only.
