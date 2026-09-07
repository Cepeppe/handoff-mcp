# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

### Added

- Public certain-secret patterns in `patterns/certain-secrets.v1.json`: sixteen families
  with their own match and counter-example lists, the shared English and Italian stop-word
  lists used by runbook matching, and notes explaining the regex subset that JavaScript and
  Rust read the same way.
- Secret corpora `fixtures/secrets/positive.txt` and `fixtures/secrets/negative.txt`, and a
  contract test that requires recall 1.0 on the first and zero matches on the second.
- `scanText` over the compiled patterns, reporting the family and the span of a match and
  never the text that matched, and the identifier generators for handoffs, sessions, calls
  and runbooks, which by construction can never produce a value a pattern would match.
- Public JSON Schemas (draft 2020-12) for the handoff spec, the outcome and the runbook
  file, with `schemas/README.md` describing the version rules, the limits and the rule
  that placeholders exist only in runbooks.
- Fixtures for the three formats, including one outcome per status and invalid specs
  paired with the path and error code a validator must report, and a contract test that
  compiles the schemas with Ajv in strict mode and checks every fixture.
- TypeScript project scaffold: strict `tsconfig.json`, ESLint, Prettier, Vitest, and an
  esbuild bundle producing the single CommonJS file behind the `handoff-mcp` binary.
- CLI entry routing the five subcommands (`serve`, `hook stop`, `validate`,
  `runbooks search`, `doctor`) plus `--help` and `--version`. The subcommands are
  placeholders until the tasks named in their message implement them.
- Continuous integration on Linux and Windows with Node 22 and 24; the macOS leg runs on
  manual dispatch only.
