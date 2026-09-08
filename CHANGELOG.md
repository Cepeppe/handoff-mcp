# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

### Changed

- `.github/workflows/ci.yml` runs on pushes to `main`, on pull requests and on dispatch; a
  tag no longer runs it a second time next to the release workflow. A dispatch runs the
  macOS leg alone, unless the `full` input asks for the ubuntu/windows matrix as well, and
  it no longer cancels the push run of the same commit: `ci.yml` and `sea.yml` group their
  runs per event, so only a run superseded by a newer one of the same kind is cancelled.

### Fixed

- `test/fake-app` compiles its channel-schema validator when it starts, not on the first
  line a peer sends. The stop hook has 1 800 ms for everything it does, and on the macOS
  runner with Node 22 the compile alone outlived that budget, so the F-10 hook test went
  neutral without a `hook.stop` while the same suite passed everywhere else.

## [0.2.0] - 2026-09-08

The server is usable alone: validation, text mode, runbooks, channel client, hook, doctor,
docs. Registered in an MCP client with no overlay running, it validates a spec, masks the
values that match a certain-secret pattern, searches the runbooks of `~/.handoff/` and hands
the handoff back as text for the agent to walk the person through in the chat. With an
overlay listening it opens a real handoff over the channel, blocks, heartbeats, resumes and
transfers. The public formats and the channel definition are unchanged since `0.1.0`.

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
- The runbook reader, matcher and converter: `RunbookStore` lists `~/.handoff/runbooks/`,
  validates each file against the published runbook schema and caches it by path and mtime,
  skipping a bad file with one warning on stderr rather than failing the search; a missing
  folder is an empty result, an unreadable one is `RUNBOOKS_UNREADABLE` for the tool and a
  silent skip for the safety net. `matchRunbooks` applies the rule of the design — same
  `where` after normalisation, at least one shared goal word beyond stop-words — ranked by
  shared words, then freshness, then id, and capped at five. `searchRunbooks` converts each
  match into the `runbooks[]` item an agent receives, with `{{name}}` turned into `[name]`,
  the names collected into each step, and a draft spec whose empty values keep it invalid
  until the agent fills them.
- `handoff-mcp runbooks search --where … --goal … [--lang …]`: the same rule offline,
  printing the same `{ "runbooks": [ … ] }` the tool returns.
- `fixtures/matching/*.json` (19 cases, with the format documented beside them) and
  `test/contract/matching.test.ts` pin the matching rule for every implementation, and the
  conversion is asserted equal to the published `runbook_match` outcome fixture.
- The MCP server itself: `handoff-mcp serve` registers `handoff_to_user`, `handoff_verify`
  and `handoff_runbooks` over stdio with the descriptions, input schemas and annotations
  generated from `schemas/tool-contract.v1.md`, registered verbatim, plus an `outputSchema`
  per tool — the published outcome schema with the spec schema bundled into it, so a client
  resolves every reference without fetching anything.
- Shape inference for `handoff_to_user`: exactly one of `spec`, `reply` (with `handoff_id`)
  or `resume`, and anything else — a field borrowed from another shape, a field the schema
  does not declare, a control field of the wrong type or outside its bounds — is
  `SHAPE_AMBIGUOUS` with the fix text that lists the three shapes again.
- The open path in full: the validation pipeline, the certain detector, and the runbook
  safety net, which answers `runbook_match` without opening anything when a saved runbook
  already covers the work and is skipped by `ignore_runbook`. A runbook file that cannot be
  read, or a folder that cannot be listed, never stops a handoff from opening.
- Text mode: with no overlay application reachable, an open comes back as the `text_mode`
  outcome with the spec rendered as text and every certain secret masked, and everything
  that needs the handoff's state comes back as `APP_DISCONNECTED`. Every outcome takes its
  `final` and its `instruction` from the published contract, with `<id>` substituted and
  the Stop-hook variant chosen by the session's capability row, and carries the same object
  in `structuredContent` as in its text block; an image block accompanies it only when the
  user sent an image and the client can display one.
- `test/unit/mcp/` drives all of this over the SDK's in-memory transport, which validates
  every answer against the registered output schema, and `test/contract/mcp-tools.test.ts`
  compiles those schemas and runs the fourteen published outcome fixtures through them.
- The paths the server and the overlay application share, computed the same way on both
  sides: `~/.handoff/` with the runbook folder, the token file, the Unix socket and the
  pointer file the application writes when the socket path does not fit in a `sun_path`,
  and on Windows the named pipe `\\.\pipe\handoff-<h>`, whose suffix is the SHA-256 of the
  lower-cased `USERDOMAIN\USERNAME` — plus `HANDOFF_HOME` when it is set, so a test instance
  can never meet the application the user is running.
- The channel token file, re-read at every connection attempt so that a token regenerated
  by a repair is picked up without restarting the agent. A POSIX mode wider than `0600`
  warns once on stderr and connects anyway; a token that is missing, unreadable or
  malformed is reported as `CHANNEL_AUTH_FAILED`, the same state a rejected one produces.
- The ancestor chain, resolved per platform as the design allocates it: one capped `ps`
  spawn on macOS, `/proc` on Linux, and nothing at all on Windows, where the application
  completes the chain itself from its native process table.
- The channel client: NDJSON framing with the 16 MiB cap, the JSON-RPC 2.0 envelopes,
  `hello` with the identity payload, and the connection lifecycle — the 1, 2, 5, 10, 30
  second backoff that never gives up, one attempt every five minutes after a version
  mismatch, a ping after thirty seconds of silence with two unanswered pings meaning the
  connection is dead, the 10 second timeout on non-blocking requests, `app.shutdown` and
  `session.bye`. Nothing is wired into the tool pipeline yet: `serve` still answers in text
  mode until the blocking calls arrive.
- `test/unit/channel/` and `test/unit/platform/` pin all of it — the pipe digest as a
  literal value the application has to reproduce, every line of every golden channel
  sequence round-tripped through the codec and cut at each byte boundary, the schedules on
  a fake clock, the client over a real pipe or socket — and `test/contract/channel.test.ts`
  now validates what the client actually writes against the published channel schema.
- `test/fake-app/`, the scripted channel listener the integration tests talk to: it listens
  on the real endpoint under a `HANDOFF_HOME` of its own, validates every raw line against
  `channel.v1.schema.json` in both directions, checks the token in constant time and the
  protocol version for equality, assigns a `ses_…` to a server and serves a hook without
  one, records everything received, and answers from a scenario written in a small DSL —
  reply rules, timed emissions and barriers, consumed as a queue. The eleven scenarios in
  `test/fake-app/scenarios/` derive their actions from `fixtures/channel/` instead of
  copying a payload out of it, and loading one checks the summary it carries against that
  derivation, so a fixture cannot change under a scenario unnoticed. `test/fake-app/README.md`
  is how to write one.
- `test/fake-app/fake-app.test.ts` replays every golden sequence over a real socket and
  compares both halves against the fixture modulo identifiers and timestamps, drives the
  fake with the channel client for registration, a refused token, a version mismatch, a
  ping in each direction, `app.shutdown` and a dropped connection, and requires the golden
  comparison to fail on a planted mutation.
- **Blocking calls.** `handoff_to_user` now opens, continues and resumes a handoff against
  the overlay app and blocks until the user is done. `src/calls/` holds the in-flight table
  — one entry per waiting call, at most one waiting call per handoff — and everything that
  ends a wait: the outcome the app pushes, the heartbeat deadline (the app is told the call
  detached and the agent gets `in_progress` with the instruction to resume at once), the
  agent cancelling (the app is told, the call is forgotten), and a channel that dropped, in
  which case the call is **kept** and re-issues its resume when the connection returns, so a
  restart of the app costs a banner and not a handoff.
- A resume reads the snapshot of the design: a handoff that is already final hands its
  outcome back with `already_delivered`, a queued undelivered event comes back at once, and
  anything else attaches the call and waits. `handoff_verify` forwards the report and returns
  the outcome the app answers with.
- The five application errors of the channel become the published error catalogue:
  `not_waiting`, `final` and `not_found` become `HANDOFF_NOT_WAITING`, `HANDOFF_FINAL` and
  `HANDOFF_NOT_FOUND`, `no_verify_in_spec` becomes `NO_VERIFY_IN_SPEC`, and
  `unknown_value_key` becomes the `SPEC_INVALID` of the value-key rule, one problem per key
  the app refused. A channel that is refusing rather than absent — a token the app rejects, a
  protocol version it does not speak — still degrades an open to text mode, now with the
  repair sentence for that failure beside it.
- A screenshot the user sent as an image travels beside its outcome on the channel and is
  attached to the tool result as an image block, when the session's capability row says the
  client can show one. The channel schema gains an optional `image` for it, on `handoff.event`
  and on the snapshot of `handoff.resume`; the published outcome schema is unchanged.
- `test/integration/`: the flows of the design driven end to end — a real MCP client, the
  real server, the real channel client over a real named pipe or Unix socket, and the fake
  app replaying the golden sequence — with both halves of the traffic compared against the
  fixture afterwards. Plus the degraded half: no app at all, a runbook that answers before
  the channel is used, a socket that dies mid-call, a refused token, a version mismatch, a
  cancelled call, each application error, and the image gating.
- `handoff-mcp hook stop`, the Stop and SubagentStop hook: it reads the hook payload on
  stdin, asks the overlay application whether anything is still waiting for the user, and
  prints `{"decision":"block","reason":…}` when the answer is yes. It never blocks on
  uncertainty — a missing application, a refused token, a malformed payload, a late answer
  and the agent's own loop guard all print nothing and exit 0 — and it holds to its budgets:
  500 ms to connect, 1800 ms in all, and a hard exit at 1950 ms on an unref'd timer. The
  connection is its own short-lived one over the channel codec rather than the session
  client, whose retry schedule never gives up by design.
- `handoff-mcp doctor`: the versions, the agent id and the capability row resolved for it,
  the status and permissions of the channel token file, the endpoint and whether the overlay
  application answers on it, and the runbook folder. The token itself is never printed, and
  reaching the application is a real connection — a hello with `role: "server"` followed by
  a goodbye — so an application that is not running (normal: every call degrades to text
  mode) is told apart from one that refused the token or speaks another protocol version.
  It exits 1, with a `problem:` line per finding, only for what the user has to repair.
- CLI polish: `handoff-mcp <command> --help` prints that subcommand's own help, every
  subcommand refuses an argument it does not know instead of ignoring it, and
  `HANDOFF_MCP_LOG=debug` adds a record for the command that ran, for every environment
  variable that was ignored, and for the exit code. The three exit codes are now the same
  everywhere: 0 success, 1 the command answered no, 2 usage error.
- The published documentation, in `docs/`: an overview with the three public promises and the
  support levels, then one page each for the handoff spec, the outcome, the tool contract,
  text mode and its limitations, the runbook format and its matching rule, the error
  catalogue, versions and compatibility, the internal channel with its threat model quoted
  from the requirements and its "internal, subject to change" notice, and the manual route
  for installing the server on its own with `HANDOFF_AGENT`, `doctor` and `validate`. The
  README is rewritten around that: what the server is, how to install it, what text mode
  looks like, and where the rest is.
- `pnpm check:links`, run by both legs of CI: every relative link and `#anchor` in the
  repository's Markdown resolves, with links inside code fences and inline code left alone.
  `test/unit/docs-links.test.ts` runs it against trees built to break it, and checks that
  every documented page exists and is reachable from the index.
- The canary harness of `test/canary/`: `pnpm canary` runs the real Claude Code against the
  built bundle in a throw-away project and re-verifies the assumptions the server rests on
  — registration before the first tool call, the `env` block of the MCP entry, the
  `clientInfo` name, `CLAUDE_PROJECT_DIR`, the Stop hook payload and its blocking decision,
  the hook's ancestor chain, both tool timeouts and the cancellation that follows them, and
  the text-mode answer with no overlay listening. Each assertion says whether it looked at
  the protocol or at the model, and only a model failure is retried, once.
- `docs/agent-facts.md`: what the harness measured against Claude Code 2.1.263 on
  2026-09-08, how to re-run it, and what is deliberately not measured.
- The server takes part in its own canary: with `HANDOFF_CANARY=1` it registers a `sleep_ms`
  test tool and writes an observation file under `$HANDOFF_HOME/canary/`, recording names
  and resolved values and never the value of an environment variable. Without the variable
  neither exists.
- `.github/workflows/canary.yml`, `workflow_dispatch` only: it compares the npm dist-tag of
  `@anthropic-ai/claude-code` against `test/canary/last-claude-version`, installs that
  version, runs the scenarios and opens an issue with the failing assertions. It skips
  gracefully while no API key is configured.

### Changed

- `src/adapters/capabilities.json` records the measured `clientInfo.name` of Claude Code,
  `claude-code`, so a server installed by hand — with no `HANDOFF_AGENT` — resolves the full
  row instead of `unknown`. `tool_timeout_ms_default` stays `null`: the canary can only
  bound the default from below, and a lower bound in that field would make the heartbeat
  arithmetic state something nobody measured.

### Fixed

- `serve` did not return when the agent closed stdin. The MCP SDK's stdio transport watches
  stdin for data and for errors but never for its end, so nothing noticed the agent exiting;
  while the server had no channel the process simply ran out of work and exited anyway, and
  that stopped being true as soon as a socket and a retry timer were holding it open. `serve`
  now watches stdin itself, which is also what triggers the goodbye on the channel.
- `npx baton-handoff-mcp` did not start the server. The bundle `bin` points at carried no
  shebang, and npm reads the first line of a bin target to decide how to launch it: the shim
  it generates handed the CommonJS bundle to `/bin/sh`, which answered with a screen of
  syntax errors and exit 2, and to `cmd.exe`, which printed nothing and exited 0. The
  bundler now writes `#!/usr/bin/env node`, which Node strips, including inside the SEA
  blob that embeds the same file.
- The published package carried the whole of `dist/`, so a `pnpm pack` weighed 71.9 MB and
  unpacked to 189.7 MB: the standalone executables, the SEA blob, the source map and every
  format tarball a local build had left behind travelled with it. `files` now names the one
  bundle `bin` points at, and gains `protocol/`, `fixtures/`, `keys/` and `CHANGELOG.md` so
  that the relative links of the shipped `docs/` resolve inside the package as well as on
  GitHub. `test/unit/package.test.ts` fails if either regresses.

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
