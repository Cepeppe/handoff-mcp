# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public formats (spec, outcome, runbook) and the tool contract carry their own
schema version, which is independent of the package version.

## [Unreleased]

## [1.7.0] - 2026-09-12

Kilo Code is the sixth agent in the capability table, on both of its surfaces — its CLI and its
VS Code extension, which run the same program — measured against Kilo 7.6.2 rather than
assumed. It is supported at `base` level, like OpenCode, whose fork its CLI is: images reach a
model that reads them, the entry's `timeout` is honoured in milliseconds and a call it cuts is
cancelled, a call with nothing configured is cut at sixty seconds, and there is no end-of-turn
hook. Neither surface needs code of its own: the VS Code extension starts this server from a
`kilo serve` of its own, one per window, so its sessions are keyed on that process, as a CLI
agent's are on the CLI. The public formats and the channel definition are unchanged since
`0.1.0`.

### Added

- The `kilo-code` row of the capability table is `supported`, with the values measured on
  2026-09-12: `clientInfo.name` `kilo` from both surfaces, images in tool results, the
  per-server field `timeout` (in milliseconds), an MCP cancellation when a call is cut, and a
  default timeout of 60 000 ms. An entry written by hand with no `HANDOFF_AGENT` now resolves
  to the Kilo Code row.
- The canary probe records whether `KILO_CLIENT`, `KILO_PARENT_PID` and `KILO_PLATFORM` reach
  the server: the variables Kilo's VS Code extension hands on and its CLI does not. The server
  reads none of them.
- Kilo Code canary scenarios in `test/canary/agents/kilo-code/`: what the server sees of a CLI
  session, its parent included; images; E2E-8 in text mode; the per-server and the default
  timeout; the degraded path. `pnpm canary -- --agent kilo-code` runs them on free models of
  the Kilo Gateway, and `canary.yml` gains a `kilo-code` job that skips without
  `KILO_API_KEY`.
- Documentation: registering the server in Kilo Code (`docs/install-without-app.md`), its row in
  the support-level table (`docs/index.md`), and what was measured against both surfaces
  (`docs/agent-facts.md`).

## [1.6.0] - 2026-09-11

GitHub Copilot is the fifth agent in the capability table, on both of its surfaces — VS Code's
chat and the Copilot CLI — measured against VS Code 1.137.0 and the CLI 1.0.83 rather than
assumed. It is supported at `base` level: images reach the model, the CLI honours a per-server
timeout and cancels a call it cuts, but no end-of-turn hook answers this server's hook on both
surfaces in a way the agent acts on. VS Code is the second editor-hosted agent, and the first
that names its workspace in no variable: a server it starts now asks the MCP client for its
roots. The public formats and the channel definition are unchanged since `0.1.0`.

### Added

- The `copilot` row of the capability table is `supported`, with the values measured on
  2026-09-11: `clientInfo.name` `Visual Studio Code` from VS Code and `copilot-cli` from the
  CLI, images in tool results, the CLI's per-server field `timeout` (in milliseconds), an MCP
  cancellation when a call is cut, a default timeout that is only bounded from below (a 90 s
  call ran uncut in the CLI, and VS Code's MCP client sets none), and no end-of-turn hook. An
  entry written by hand with no `HANDOFF_AGENT` now resolves to the Copilot row from either
  handshake.
- The project folder of a session an editor started, when the editor names its workspace in no
  variable, is the first `file:` root its MCP client lists. VS Code starts its servers in the
  user's home folder and names the window's folders only as roots; the server asks for them
  between the handshake and `hello`, for at most two seconds, and keeps the working directory
  when there are none — a window with no folder open. Cursor, which names its workspace in
  `WORKSPACE_FOLDER_PATHS`, is unchanged, and so is every session that is not an editor's.
- GitHub Copilot canary scenarios in `test/canary/agents/copilot/`: VS Code's session identity,
  measured by launching a VS Code of the harness's own with a starter extension, with no agent
  request; what the server sees of a CLI session, images, and the hooks around a turn; E2E-8
  in text mode; the per-server and the default timeout; the degraded path.
  `pnpm canary -- --agent copilot` runs them. Each CLI run spends the account's AI credits, so
  the set runs by hand and is not in `canary.yml`.
- Documentation: registering the server in GitHub Copilot, on both surfaces
  (`docs/install-without-app.md`), its row in the support-level table (`docs/index.md`), and
  what was measured against VS Code and the Copilot CLI (`docs/agent-facts.md`).

## [1.5.0] - 2026-09-11

Cursor is the fourth agent in the capability table, on both of its surfaces, measured against
Cursor 3.20.10 and its Agent CLI rather than assumed. It is supported at `base` level: images
reach the model and a call that times out is cancelled rather than abandoned, but no
end-of-turn hook of Cursor can reach this server's hook, and Cursor has no per-server timeout
to raise. It is also the first editor-hosted agent: Cursor's editor starts this server from
its own extension host, in the user's home folder, and the server now says so to the app. The
public formats and the channel definition are unchanged since `0.1.0`; the session identity
travels in an optional field `hello` already had. `1.2.0` and `1.3.0` stay unreleased for
good: a number below `1.4.0` would read as a downgrade to an installation's in-place update,
so the adapters that follow `1.4.0` take `1.5.0` onward.

### Added

- The `cursor` row of the capability table is `supported`, with the values measured on
  2026-09-11: `clientInfo.name` `cursor-vscode` from the editor and `Cursor` from the CLI,
  images in tool results, no per-server timeout field, a default timeout of 60 000 ms (the
  CLI's, where the MCP SDK cuts a call and cancels it), and no end-of-turn hook. An entry
  written by hand with no `HANDOFF_AGENT` now resolves to the Cursor row from either handshake.
- The session identity of an editor-hosted session (`src/adapters/editor.ts`). A server whose
  chain shows that an editor of the VS Code family started it — `VSCODE_PID` names one of its
  ancestors, and every process in between runs the editor's own executable — sends
  `session_identity: "ancestor_chain:editor"` in the `capability_row` of `hello`, with the
  editor in its chain. Every other session is keyed on its parent, as before. On Windows such a
  server walks its chain with one PowerShell query, about 0.7 s once per session; the hook and
  every other session still spawn nothing there.
- The project folder of a session Cursor's editor started is the first workspace folder it
  names in `WORKSPACE_FOLDER_PATHS`, not the home folder the editor starts its servers in.
- Cursor canary scenarios in `test/canary/agents/cursor/`: the editor's session identity,
  measured by launching an editor of the harness's own on a throw-away project, with no agent
  request; what the server sees of a CLI session, images, and the hooks at the end of a turn;
  E2E-8 in text mode; the degraded path; the default timeout. `pnpm canary -- --agent cursor`
  runs them. Each CLI run spends one of the account's requests, so the set runs by hand and is
  not in `canary.yml`.
- Documentation: registering the server in Cursor (`docs/install-without-app.md`), its row in
  the support-level table (`docs/index.md`), and what was measured against Cursor
  (`docs/agent-facts.md`).

## [1.4.0] - 2026-09-11

OpenCode is the third agent in the capability table, measured against the real OpenCode CLI
rather than assumed. It is supported at `base` level, like Codex: it shows the images of a
tool result and honours a per-server timeout, but offers no end-of-turn hook to register. It
is also the first agent whose default tool timeout is a measured value rather than a lower
bound: sixty seconds, which the 50 s heartbeat stays ahead of. The public formats and the
channel definition are unchanged since `0.1.0`. `1.2.0` and `1.3.0` are not released, and
will not be: the adapters that follow take `1.5.0` onward.

### Added

- The `opencode` row of the capability table is `supported`, with the values measured against
  OpenCode 1.18.29: `clientInfo.name` `opencode`, images in tool results, the per-server
  timeout field `timeout` (in milliseconds), no end-of-turn hook, an MCP cancellation when a
  call times out, and a default timeout of 60 000 ms (`tool_timeout_ms_default`). An entry
  written by hand with no `HANDOFF_AGENT` now resolves to the OpenCode row from the handshake.
- OpenCode canary scenarios in `test/canary/agents/opencode/`: what the server sees of an
  OpenCode session, images in tool results, E2E-8 in text mode, the per-server and the default
  timeout, and the degraded path against a scripted overlay. `pnpm canary -- --agent opencode`
  runs them alone, on a free OpenRouter model by default; every run is isolated from the
  user's own OpenCode configuration (an inline configuration, an empty `XDG_CONFIG_HOME`,
  project configuration off) and deletes the session it leaves in OpenCode's history.
- An OpenCode job in `.github/workflows/canary.yml`, which runs on `OPENROUTER_API_KEY`, skips
  without it, and diffs the published OpenCode against `test/canary/last-opencode-version`.
- Documentation: registering the server in OpenCode (`docs/install-without-app.md`), its row
  in the support-level table (`docs/index.md`), and what was measured against OpenCode
  (`docs/agent-facts.md`).

## [1.1.0] - 2026-09-11

Codex is the second agent in the capability table, measured against the real Codex CLI
rather than assumed. It is supported at `base` level: it shows the images of a tool result
and honours a per-server timeout, but `codex exec` runs no end-of-turn hook, so what keeps a
long handoff alive is the heartbeat and the text of the instruction — and a canary now
proves that path against the real agent. The public formats and the channel definition are
unchanged since `0.1.0`.

### Added

- The `codex` row of the capability table is `supported`, with the values measured against
  Codex 0.153.4: `clientInfo.name` `codex-mcp-client`, images in tool results, the
  per-server timeout field `tool_timeout_sec` (in seconds), no end-of-turn hook, no MCP
  cancellation when a call times out, and a default timeout that is only bounded from below
  and therefore stays unset. An entry written by hand with no `HANDOFF_AGENT` now resolves
  to the Codex row from the handshake.
- Codex canary scenarios in `test/canary/agents/codex/`: what the server sees of a Codex
  session, images in tool results, E2E-8 in text mode, the per-server and the default
  timeout, and the degraded path — the heartbeat, the resume, and a deferral the agent has
  to remember with no hook to remind it — against a scripted overlay.
  `pnpm canary -- --agent codex` runs them alone, and every run is isolated from the user's
  own Codex configuration (`--ignore-user-config`, apps and plugins off, `--ephemeral`).
- A second tool in the canary probe, `image_probe`, which returns one small square of a
  random colour for the model to name; the probe also reports whether `USERDOMAIN` and
  `USERNAME` reached the server and which folder the agent started it in. Both exist only
  under `HANDOFF_CANARY=1`.
- A Codex job in `.github/workflows/canary.yml`, which runs on `OPENAI_API_KEY`, skips
  without it, and diffs the published Codex against `test/canary/last-codex-version`.
- Documentation: registering the server in Codex, including the approval mode it needs
  (`docs/install-without-app.md`), the support level of each agent (`docs/index.md`), and
  what was measured against Codex (`docs/agent-facts.md`).

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
