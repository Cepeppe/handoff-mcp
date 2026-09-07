# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

### Added

- `schemas/tool-contract.v1.md`, the normative source of everything the server says to an
  agent: the MCP input schema, description and annotations of `handoff_to_user`,
  `handoff_verify` and `handoff_runbooks`, the exact `instruction` sentence of each of the
  fourteen outcome statuses (in two variants where the presence of a Stop hook changes what
  the agent must do), and the twelve-code error catalogue with its fix texts.
- `build/gen-contract.mjs`, run by `pnpm gen` and as the first step of `pnpm build`, which
  turns that document into the typed constants of `src/mcp/generated/contract.ts` and
  inlines `handoff-spec.v1.schema.json` where the tool input schema refers to it, so the
  spec format has a single source. A unit test regenerates into a temporary file and fails
  on any difference, and asserts that every status of the outcome schema has an
  instruction, that every error code has a text, and that the outcome fixtures carry the
  generated sentences.

- Definition of the internal server-to-app channel in `protocol/channel/`: a JSON Schema
  covering every method, its params and its result, the JSON-RPC envelope and the error
  codes; a `protocol_version` file holding the single integer both peers compare for
  equality; and a README carrying the "internal, subject to change without notice" notice,
  the transport, the connection lifecycle and the declared threat model.
- Golden channel sequences in `fixtures/channel/*.jsonl`, one per flow, replayed by both
  test doubles, and a contract test that validates every line, requires every method to
  appear and checks that the sequences answer the requests they contain.
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

### Changed

- The fourteen fixtures in `fixtures/outcomes/` now carry the exact instruction texts of
  the tool contract instead of the gists they were written with.
