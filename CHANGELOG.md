# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

### Added

- The validation pipeline: `validateSpec` checks `spec_version` before the schema, then the
  published schema with every error collected at once, then the semantic rules the schema
  cannot express — control fields left inside the spec, value keys a step cites without
  declaring, runbook placeholders never replaced, URL schemes outside the closed list and
  strings that are empty once trimmed. Every problem comes back with the path of the
  offending location, what is wrong there and the fix text of the design, and never with a
  value of the spec. `validateReplacementSteps` applies the same steps schema and the same
  rules to the steps of a continue call.
- `handoff-mcp validate <spec.json>`: the same pipeline offline, printing the same JSON
  error the tool returns and exiting 1, or a one-line summary and 0. `pnpm handoff-mcp`
  runs the built bundle from a checkout.
- `test/contract/validate.test.ts` asserts the error code and the exact path of every
  invalid spec fixture, and `test/unit/format/` the exact texts of each rule, the
  translation of every schema keyword, and that no rendered error carries a spec value.

## [0.1.0] - 2026-09-07

Foundations: formats, patterns, channel definition, SEA build. The server is **not
functional yet** — `serve`, `hook stop`, `validate`, `runbooks search` and `doctor` print
the task that implements them and exit. What this release publishes is the public part of
the contract, so that the overlay application can pin it and build against it.

### Added

- Release pipeline: `.github/workflows/release.yml` turns a `v*` tag into the assets of the
  design — the standalone executables, `handoff-mcp-<ver>-format.tar.gz` with the schemas,
  the patterns, the channel definition, the fixtures, the documentation and a
  `FORMAT-VERSION` file, then `SHA256SUMS` and its detached minisign signature — and
  refuses to start unless the tag is the version of `package.json` and the changelog has a
  section for it. `build/verify-release.mjs` downloads a published release and checks every
  hash and the signature against `keys/handoff-mcp-release.pub`, with the minisign
  verification self-contained so that a consumer needs only Node. The two darwin binaries
  are built when the workflow is dispatched with `include_macos`, and the npm publish waits
  for the `PUBLISH_NPM` repository variable.

- Standalone executables: `build/sea/build-sea.mjs` turns the esbuild bundle into a Node
  Single Executable Application named after the release asset of the platform it runs on,
  `build/sea/smoke.mjs` exercises the result the way a machine without Node would, and
  `.github/workflows/sea.yml` builds and smokes `win32-x64` on every push to `main` and the
  two macOS targets on demand. `docs/build-sea.md` carries the procedure, the entitlements
  the signed macOS build will need, and the fallback if a platform stops working.

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
