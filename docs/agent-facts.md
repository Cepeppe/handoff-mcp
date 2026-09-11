# Measured agent facts

Everything this server does with an agent rests on facts about that agent: that a tool call
can block, that the `env` block of an MCP entry reaches the server process, that an
end-of-turn hook can ask the run to continue. None of those are ours to decide, so none of
them are assumed here — each one is **measured against the real agent** by the canary
harness in `test/canary/`, and this page is what the harness measured, when, and against
which version.

The canary is not a gate. It runs on demand, it costs real usage, and a model that ignores a
prompt is not a defect of this server; a failing measurement is an alert to triage, and a
failing _protocol_ measurement is what a release should stop for. The distinction is made by
the harness itself and is explained under [The classifier](#the-classifier).

## Running it

```bash
pnpm build          # the canary runs the real dist/handoff-mcp.cjs, not the sources
pnpm canary         # every scenario of every agent
pnpm canary -- --agent opencode                # one agent's scenarios
pnpm canary -- observe a03-timeout-honoured    # only these
pnpm canary -- --list                          # what exists, without spending anything
```

`claude`, `codex`, `opencode` and Cursor's `agent` must be on `PATH` and logged in for their
scenarios, and the Cursor editor scenario needs Cursor installed where it installs itself.
Each run builds a throw-away project under the system temporary directory with its own
`HANDOFF_HOME`, so nothing touches `~/.handoff/`, and the report is written to
`test/canary/results/last-run.json` (git-ignored).

| Variable                        | Effect                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HANDOFF_CANARY_MODEL`          | The Claude Code model to run against. Default `sonnet`, so a run stays cheap.                                                                                        |
| `HANDOFF_CANARY_CODEX_MODEL`    | The Codex model to run against. Default `gpt-5.6-luna`, the one Codex's own list calls fast and affordable.                                                          |
| `HANDOFF_CANARY_OPENCODE_MODEL` | The OpenCode model to run against, as `provider/model`. Default `openrouter/thinkingmachines/inkling-small:free`: free, so a run costs nothing, and it reads images. |
| `HANDOFF_CANARY_CURSOR_MODEL`   | The model Cursor's CLI runs on. Default `auto`, Cursor's own choice and the one its Free plan offers.                                                                |
| `HANDOFF_CANARY_CODEX`          | The `codex` program to start, when it is not the one on `PATH`.                                                                                                      |
| `HANDOFF_CANARY_OPENCODE`       | The `opencode` program to start, when it is not the one on `PATH`.                                                                                                   |
| `HANDOFF_CANARY_CURSOR`         | Cursor's `agent` program to start, when it is not the one on `PATH`.                                                                                                 |
| `HANDOFF_CANARY_CURSOR_EDITOR`  | Cursor's editor executable, when it is not where Cursor installs itself.                                                                                             |
| `HANDOFF_CANARY_KEEP=1`         | Keeps each run's temporary project, for reading a failure by hand.                                                                                                   |
| `HANDOFF_CANARY_SERVER`         | The bundle the MCP entry runs, instead of `dist/handoff-mcp.cjs` of this checkout. A release points it at the tarball it is about to publish.                        |

Two rules of the harness are not options. **A run never reaches the MCP servers configured on
the machine it runs on**: for Claude Code `--strict-mcp-config` is always passed; for Codex,
which has no such flag and merges a `-c mcp_servers` override with the user's own servers,
every run is `codex exec --ephemeral --ignore-user-config` with `apps` and `plugins` turned
off, which are how a Codex session reaches connected accounts. OpenCode has neither flag, so
our server is declared inline in `OPENCODE_CONFIG_CONTENT`, `XDG_CONFIG_HOME` points at an
empty folder of the run so that the user's global configuration never loads, project
configuration and Claude Code's files are switched off, and the session each run leaves in
OpenCode's history is deleted afterwards. Cursor's CLI has neither flag either: our server is
declared in the run's own project, whose `.cursor/cli.json` allows its tools with the one rule
`Mcp(handoff:*)` and never `--force`, and what each run leaves under `~/.cursor/` is deleted
afterwards; a `~/.cursor/mcp.json` of the user's would still load, and none exists on the
machine these facts were measured on. Cursor's editor is launched with a user-data folder and
a home folder of the run's own, so the `~/.cursor/mcp.json` it reads is the run's. And
`CLAUDECODE` is always cleared for the child,
because Claude Code refuses to run nested inside another Claude Code session and the harness
is normally started from one.

The server itself takes part: with `HANDOFF_CANARY=1` in the MCP entry's `env` block it
registers two extra tools, `sleep_ms` and `image_probe`, and writes an observation file under
`$HANDOFF_HOME/canary/`. Without that variable — every ordinary run, every installed server,
every other test — none of it exists. What the probe records is names and resolved values,
never the value of an environment variable and never anything from a spec.

## What was measured

**Claude Code 2.1.263 · Windows 11 (win32-x64) · model `claude-sonnet-5` · 2026-09-08.**
All five scenarios passed; the whole suite took about three minutes and cost $0.33.

### Identity and configuration

| Fact                                                   | Measured value                                           |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `clientInfo.name` in the `initialize` handshake (A-08) | `claude-code`                                            |
| `clientInfo.version`                                   | `2.1.263`, the CLI version                               |
| `env` block of the MCP entry reaches the server (A-02) | Yes — `HANDOFF_AGENT` arrived and resolved the row       |
| Resolved capability row                                | `claude-code`, support `full`                            |
| `CLAUDE_PROJECT_DIR` set for the server process (A-24) | Yes, and equal to the working directory                  |
| Server processes started per session                   | One                                                      |
| Registration precedes the first tool call (A-01)       | Yes; `system`/`init` also reports the server `connected` |

`clientInfo.name` is now in `src/adapters/capabilities.json` as
`match.client_names: ["claude-code"]`, which is what makes an entry written by hand — with
no `HANDOFF_AGENT` — resolve to the full row instead of `unknown` (§5.6 step 2).

### Environment-variable stripping (A-23)

A pair of variables was put in the `env` block of the MCP entry, `HANDOFF_PROBE` and
`HANDOFF_PROBE_TOKEN`, identical but for the substring `TOKEN`. **Both arrived**, so no
stripping was observed for a server declared through `--mcp-config`.

That is not the whole of A-23, and the gap is deliberate. The assumption is about a server
declared in **project scope** (a `.mcp.json` discovered in the project folder), and
reproducing that shape means running without `--strict-mcp-config` — which would load every
MCP server configured on the machine the canary runs on, including the operator's own
accounts. The harness will not do that. The consequence for this repository is nil either
way: `ENV_VAR_NAMES` in `src/config.ts` contains no name holding `TOKEN`, `SECRET`,
`PASSWORD`, `KEY` or `AUTH`, and `test/unit/env-names.test.ts` fails the build if one
appears. The two probe names are deliberately **not** in that list, which is why the probe
looks them up by name rather than declaring them.

### Tool timeouts (A-03, A-04) and cancellation (A-09)

Measured with `sleep_ms`, the canary-only tool, against a 120 s sleep.

| Where the timeout was written                                 | Configured | Call ended     | After     |
| ------------------------------------------------------------- | ---------- | -------------- | --------- |
| `env.MCP_TOOL_TIMEOUT` in the project `.claude/settings.json` | 20 000 ms  | cancelled      | 20 037 ms |
| `timeout` field of the MCP server entry                       | 20 000 ms  | cancelled      | 20 040 ms |
| nothing configured (bounded probe, 70 s sleep)                | —          | ran to the end | 70 004 ms |

- **A-03 holds.** `MCP_TOOL_TIMEOUT` set in the settings `env` block is inherited by the
  server process and bounds its tool calls, in milliseconds.
- **A-04 holds.** The per-server `timeout` field exists, is honoured, and is in
  milliseconds too. This is the measurement the T-026 decision (OI-02) rests on.
- **A-09 holds.** In both cases the server received an MCP cancellation — the handler's
  `AbortSignal` fired — rather than being left to finish into a void. The agent saw the
  tool result as an error.
- **The default timeout is only bounded from below.** A call with nothing configured ran
  for 70 s and was not cut short, which is all a probe that has to terminate can prove. The
  documented default is very long (A-03 records ≈ 28 h). `tool_timeout_ms_default` for
  `claude-code` therefore stays `null` in the capability table: a lower bound written into
  that field would make the heartbeat arithmetic of §5.6 state something that was never
  measured, while `null` already yields the safe answer — the 50 s heartbeat of the
  `unknown` row — and the installer normally writes `HANDOFF_TOOL_TIMEOUT_MS`, which
  outranks both.

### The Stop hook (A-05, A-06, A-11)

A recording hook was declared in the temporary project's `.claude/settings.json` and ran
under `claude -p` with no extra flag, so **A-06 holds**: `--setting-sources` was not needed
for project settings to be loaded.

The payload carried the five fields A-05 names — `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `stop_hook_active` — and six more this version adds: `prompt_id`,
`permission_mode`, `effort`, `last_assistant_message`, `background_tasks`, `session_crons`.
Nothing reads the extra six; they are recorded so that a field disappearing is noticed.

`{"decision":"block","reason":"…"}` on stdout **continued the run**: the reason reached the
model as a `Stop hook feedback:` message, the model answered again, and the hook was
invoked a second time with `stop_hook_active: true`. **A-05 holds.** One cosmetic detail:
the CLI also emits a `stop-hook-error` notification when a hook blocks, which is how a block
surfaces in the interface and not a sign that anything failed.

**A-11 holds.** The hook's own process-ancestor chain — twelve generations deep on Windows —
contains the pid of the agent process that launched the MCP server. The hook is not a direct
child of the agent (its parent is the shell the agent spawned it through), so the _chain_,
not the parent, is what the app has to intersect (SRV-17, DD-22).

### Text mode (E2E-8)

With no overlay listening, `handoff_to_user` answered `status: "text_mode"` with the spec
rendered as the block of §5.9, and the agent presented the steps in the chat. Three turns.
The rest of §11.5's end-to-end scenarios need the overlay and are not run from this
repository (see `TASKS.md` §0.4 item 3).

### How an MCP tool actually reaches the model

Worth knowing before writing any prompt for this harness: in 2.1.263 an MCP tool is **not**
placed directly in the model's context. It appears in the session's tool list, and the model
reaches it through its own `ToolSearch` first. A prompt saying "do not call any other tool"
therefore forbids the one call that makes the wanted call possible, and the scenario fails —
as a model failure — for a reason that is the harness's fault rather than the agent's. The
scenarios here say what to call and never what not to call.

## Codex CLI

**Codex CLI 0.153.4 · Windows 11 (win32-x64) · model `gpt-5.6-luna`, reasoning effort low ·
2026-09-10.** All six scenarios passed on the first attempt, in about four and a half
minutes, most of it the two bounded sleeps. Codex reports tokens rather than a price: the
most expensive run, the degraded path, used about 88 000 input tokens (71 000 of them
cached) and 385 output tokens.

### Identity and configuration

| Fact                                                   | Measured value                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Configuration                                          | `~/.codex/config.toml`, one `[mcp_servers.<name>]` table per server                                           |
| Non-interactive command                                | `codex exec --json …`: one JSON event per line on stdout, the prompt as the last argument                     |
| `clientInfo.name` in the `initialize` handshake (A-08) | `codex-mcp-client`                                                                                            |
| `clientInfo.version`                                   | `0.153.4`, the CLI version                                                                                    |
| `env` block of the MCP entry reaches the server (A-02) | Yes, whole: `HANDOFF_AGENT` resolved the row, and `HANDOFF_PROBE_TOKEN` arrived beside `HANDOFF_PROBE` (A-23) |
| The rest of the server's environment                   | A whitelist of Codex's own; `USERDOMAIN` and `USERNAME` are on it, so the server finds the app's pipe         |
| The server's working directory (A-24)                  | The folder Codex was started in (`-C`); no project-folder variable is set                                     |
| Server processes started per session                   | One, and `initialize` precedes the first tool call (A-01)                                                     |
| Images in tool results (A-07)                          | Reach the model: the colour of `image_probe` was named correctly in both runs                                 |
| End-of-turn hook                                       | None that `codex exec` runs (below)                                                                           |

`clientInfo.name` is in `src/adapters/capabilities.json` as
`match.client_names: ["codex-mcp-client"]`, so an entry written by hand without
`HANDOFF_AGENT` still resolves to the Codex row.

**Every tool that is not annotated read-only needs an approval.** `codex exec` answers that
request with a refusal — "MCP tool call requires approval, but approval policy is never" —
and the interactive client stops to ask on every call. `handoff_runbooks` is read-only;
`handoff_to_user` and `handoff_verify` are not. `default_tools_approval_mode = "approve"` on
the entry lifts it, and is what [Installing the server on its
own](install-without-app.md#registering-it-in-codex) tells a user to write.

### Tool timeouts and cancellation (A-04, A-09)

Measured with `sleep_ms` against a 120 s sleep. Codex does not tell the server when it gives
up on a call, so the cut is timed from outside: from the probe's record of the call to the
moment Codex printed its end.

| Where the timeout was written      | Configured | Call ended                                                   | After      |
| ---------------------------------- | ---------- | ------------------------------------------------------------ | ---------- |
| `tool_timeout_sec` of the entry    | 20 s       | cut; the agent saw "timed out awaiting tools/call after 20s" | 20 007 ms  |
| nothing configured (bounded probe) | —          | ran to the end                                               | 120 018 ms |

- **The per-server field exists, is honoured, and is in seconds** — not milliseconds as in
  Claude Code. Thirty minutes is `tool_timeout_sec = 1800`.
- **No MCP cancellation.** When the timeout cuts a call, Codex stops waiting and tells the
  server nothing: the probe's sleep was still running when the session ended.
  `cancellation_notifications` is `false`. Nothing depends on it — the heartbeat detaches the
  call before any timeout (§5.7).
- **The default timeout is only bounded from below**, at more than 120 s.
  `tool_timeout_ms_default` stays `null`, for the reason given for Claude Code above, and the
  server heartbeats at 50 s, well inside the bound.

### The end-of-turn hook

Codex 0.153.4 has a hooks feature: the binary knows `SessionStart`, `UserPromptSubmit`,
`Stop` and `SubagentStop`, and the interactive client reviews new hooks before trusting them.
But no hook declared for a `codex exec` session ran — not from the project's
`.codex/hooks.json` with the project marked trusted and made a git repository, not from
`-c hooks=…`, not with the user configuration loaded, and not with
`--dangerously-bypass-hook-trust`; not even `SessionStart`. A hook the interactive client
might run after its review cannot be measured by a probe that has to terminate, and only
measured behaviour may be relied on (PRIN-11). So `stop_hook` is `false`, the level is
`base`, and the instruction in a `deferred` or `parked` outcome tells a Codex agent that
nothing will remind it.

### The degraded path (FM-03, FM-04)

This is the reason Codex is the second agent: with no hook, the heartbeat and the text of the
instruction are all that keep a long handoff alive. Measured against the real Codex with
`test/fake-app` listening and no timeout configured:

1. The first `handoff_to_user` call was answered `in_progress` after **50 022 ms** — the 50 s
   heartbeat of a row with no known timeout — and the overlay received `handoff.detach_call`
   with reason `heartbeat`.
2. Codex resumed, as that instruction says. The overlay reported that the user had deferred
   the step, and the instruction Codex received was the no-hook variant: "Nothing will remind
   you: keep <id> in your notes for this turn".
3. Codex resumed again before finishing, by itself, and received the final
   `confirmed_by_user`.

Three results, two resumes, and no channel line refused by the schema in either direction.

### Text mode (E2E-8)

With no overlay listening, `handoff_to_user` answered `status: "text_mode"` with the spec
rendered as the block of §5.9, and Codex presented the steps in its reply. One turn.

## OpenCode

**OpenCode 1.18.29 · Windows 11 (win32-x64) · model
`openrouter/thinkingmachines/inkling-small:free` · 2026-09-11.** All six scenarios passed on
the first attempt, in about three minutes, most of it the two timeouts and the heartbeat. The
model is a free OpenRouter model, so the run cost nothing; OpenCode reports tokens and a price
for every step, and the longest run, the degraded path, used about 1 300 input and 190 output
tokens.

### Identity and configuration

| Fact                                                     | Measured value                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration                                            | `~/.config/opencode/opencode.json`, or under `$XDG_CONFIG_HOME` when it is set — on Windows too; JSON with comments allowed, one entry per server under `mcp`           |
| Project configuration                                    | An `opencode.json` in the project, merged over the global one                                                                                                           |
| Non-interactive command                                  | `opencode run --format json …`: one JSON event per line on stdout, the prompt last                                                                                      |
| `clientInfo.name` in the `initialize` handshake (A-08)   | `opencode`                                                                                                                                                              |
| `clientInfo.version`                                     | `1.18.29`, the CLI version                                                                                                                                              |
| `environment` of the MCP entry reaches the server (A-02) | Yes, whole: `HANDOFF_AGENT` resolved the row, and `HANDOFF_PROBE_TOKEN` arrived beside `HANDOFF_PROBE` (A-23)                                                           |
| The rest of the server's environment                     | OpenCode's own, whole; `USERDOMAIN` and `USERNAME` are in it, so the server finds the app's pipe                                                                        |
| The server's working directory (A-24)                    | The folder OpenCode was started in, which OpenCode reads from `PWD` when that variable is set rather than from its own working directory                                |
| Server processes started per session                     | One, and `initialize` precedes the first tool call (A-01)                                                                                                               |
| The names the model sees                                 | `handoff_handoff_to_user`, `handoff_handoff_verify`, `handoff_handoff_runbooks`: OpenCode prefixes every tool with its server's name                                    |
| Approval before a call                                   | None: `opencode run` calls an MCP tool without asking                                                                                                                   |
| Images in tool results (A-07)                            | Reach a model that reads images: the colour of `image_probe` was named. With a text-only model the text of the result still arrives and the model says it sees no image |
| End-of-turn hook                                         | None to register (below)                                                                                                                                                |

`clientInfo.name` is in `src/adapters/capabilities.json` as `match.client_names: ["opencode"]`,
so an entry written by hand without `HANDOFF_AGENT` still resolves to the OpenCode row.

Whether an image reaches the model depends on the model the user picked in OpenCode, which
the server cannot know. The row says `images_in_results: true` because the failure the other
way is harmless: the image block travels beside the text, and a model that cannot read it
still reads every word of the outcome (PRIN-10).

### Tool timeouts and cancellation (A-04, A-09)

Measured with `sleep_ms` against a 120 s sleep. OpenCode hands the entry's `timeout` to the
MCP SDK as the request timeout of the call, and the SDK sends the server a real cancellation
when it runs out, so both cuts are timed by the probe inside the server as well as by
OpenCode's own record of the call.

| Where the timeout was written | Configured | Call ended                                                                    | Server    | OpenCode  |
| ----------------------------- | ---------- | ----------------------------------------------------------------------------- | --------- | --------- |
| `timeout` of the entry        | 20 000 ms  | cut; the agent saw "MCP error -32001: Request timed out"; the server was told | 20 003 ms | 20 006 ms |
| nothing configured            | —          | cut the same way                                                              | 59 944 ms | 60 006 ms |

- **The per-server field exists, is honoured, and is in milliseconds**, as in Claude Code:
  thirty minutes is `"timeout": 1800000`.
- **A real MCP cancellation.** The probe's sleep ended `aborted` at the moment of the cut, so
  `cancellation_notifications` is `true`.
- **The default is a value, not a bound.** OpenCode's own configuration schema describes the
  field as the timeout of every request to the server, five seconds when unset; a tool call
  with nothing configured is not cut at five seconds but at sixty, the default of the MCP SDK
  OpenCode passes the call to. `tool_timeout_ms_default` is therefore `60000`. The heartbeat
  it gives is still the 50 s floor (§5.6), ten seconds before a cut that is now known rather
  than guessed; the installer's thirty minutes make it moot.

### The end-of-turn hook

OpenCode 1.18.29 offers no command the agent runs at the end of a turn and whose answer it
obeys: what it has are plugins, JavaScript modules loaded into OpenCode's own process. A
plugin is code inside the agent, not the hook of this server's `hook stop`, and only measured
behaviour may be relied on (PRIN-11). So `stop_hook` is `false`, the level is `base`, and the
instruction in a `deferred` or `parked` outcome tells an OpenCode agent that nothing will
remind it.

### The degraded path (FM-03, FM-04)

The same flow as for Codex, measured against the real OpenCode with `test/fake-app` listening
and no timeout configured:

1. The first `handoff_to_user` call was answered `in_progress` after **50 013 ms**, the 50 s
   heartbeat, and the overlay received `handoff.detach_call` with reason `heartbeat`. With
   OpenCode this is more than a margin: ten seconds later OpenCode would have cut the call
   itself.
2. OpenCode resumed, as that instruction says. The overlay reported that the user had deferred
   the step, and the instruction OpenCode received was the no-hook variant.
3. OpenCode resumed again before finishing, by itself, and received the final
   `confirmed_by_user`.

Three results, two resumes, and no channel line refused by the schema in either direction.

### Text mode (E2E-8)

With no overlay listening, `handoff_to_user` answered `status: "text_mode"` with the spec
rendered as the block of §5.9, and OpenCode presented the steps in its reply.

### A free model has a cost of its own

A free OpenRouter model is served from a shared pool, and a busy one answers "temporarily
rate-limited upstream" (measured once, on another free model). The run then ends with an
`error` event before any tool is called and is reported as a harness failure; run it again,
or name another model with `HANDOFF_CANARY_OPENCODE_MODEL`. A paid model works the same way,
as long as the account can pay for the 32 000 output tokens OpenCode asks every request for.

## Cursor

**Cursor 3.20.10 and its Agent CLI 2026.09.10-fd3934a · Windows 11 (win32-x64) · model `auto`
· 2026-09-11.** All five scenarios passed on the first attempt: the editor's session identity
in 13 s with no agent request, and the four CLI runs in about three minutes, which spent four
of the account's requests on the Free plan. Cursor reports tokens and no price; the longest
run, the degraded path, used about 17 600 input and 670 output tokens.

Cursor has two surfaces, and they are measured two ways. The **editor** starts the servers of
`~/.cursor/mcp.json` as a window opens, before any chat, so its side of a session is measured
by launching an editor of the harness's own — a fresh user-data folder, and a home folder of
the run's so that its `~/.cursor/mcp.json` is the run's — and reading the registration. Its
chat cannot be driven from a script, so nothing about a tool call is measured through it. The
**CLI**, `agent -p`, runs a whole turn and is measured like Codex and OpenCode.

### Identity and configuration

| Fact                                  | Editor                                                                                                                                                                        | CLI                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configuration                         | `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project, one entry per server under `mcpServers`                                                                             | The same two files                                                                                                                                                                                                                   |
| Non-interactive command               | —                                                                                                                                                                             | `agent -p --output-format stream-json …`: one JSON event per line, the prompt last                                                                                                                                                   |
| `clientInfo.name` (A-08)              | `cursor-vscode`                                                                                                                                                               | `Cursor`                                                                                                                                                                                                                             |
| `clientInfo.version`                  | `1.0.0`                                                                                                                                                                       | `1.0.0`                                                                                                                                                                                                                              |
| What starts the server                | The extension host, a `Cursor.exe` whose parent is the editor's main `Cursor.exe`, as the window opens                                                                        | The CLI's own `node.exe`                                                                                                                                                                                                             |
| Server processes                      | One per window                                                                                                                                                                | One per `-p` run; `agent mcp list-tools` starts it twice                                                                                                                                                                             |
| The server's working directory (A-24) | The user's home folder, unless the entry sets `cwd`; the workspace is in `WORKSPACE_FOLDER_PATHS`, the workspace folders joined by commas                                     | The folder the CLI works in                                                                                                                                                                                                          |
| `env` of the MCP entry (A-02, A-23)   | Arrives whole, `HANDOFF_PROBE_TOKEN` beside `HANDOFF_PROBE`                                                                                                                   | Arrives whole, `HANDOFF_PROBE_TOKEN` beside `HANDOFF_PROBE`                                                                                                                                                                          |
| The rest of the server's environment  | The extension host's own, whole: `VSCODE_PID` (the editor's main process), `VSCODE_CWD`, `VSCODE_IPC_HOOK` and the others, plus `WORKSPACE_FOLDER_PATHS` and `npm_config_yes` | A short list of its own: `APPDATA`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `LOGONSERVER`, `PATH`, `PROCESSOR_ARCHITECTURE`, `PROGRAMFILES`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` |
| `USERDOMAIN` and `USERNAME`           | Present, so the server finds the app's pipe                                                                                                                                   | Present                                                                                                                                                                                                                              |
| Approval before the server loads      | None, for a server of the user file                                                                                                                                           | A server of a project file is refused until approved: `agent mcp enable`, or `--approve-mcps` for one run                                                                                                                            |
| Approval before a call                | Not measured                                                                                                                                                                  | Print mode refuses a tool that is not annotated read-only unless a permission rule allows it; `Mcp(handoff:*)` in the project's `.cursor/cli.json` is the narrowest rule, and it was enough                                          |
| How the model reaches the tools       | Not measured                                                                                                                                                                  | Through Cursor's own `getMcpToolsToolCall` first, then by name, as `handoff-<tool>`                                                                                                                                                  |
| Images in tool results (A-07)         | Not measured                                                                                                                                                                  | Reach the model: the colour of `image_probe` was named                                                                                                                                                                               |

`clientInfo.name` is in `src/adapters/capabilities.json` as
`match.client_names: ["cursor-vscode", "Cursor"]`, so an entry written by hand without
`HANDOFF_AGENT` resolves to the Cursor row from either surface.

### The session identity of an editor (R-12)

What makes the editor the hard case of the design's risk R-12, measured plainly: the server's
parent is not an agent but the editor's extension host, and one server serves every chat of a
window. Two windows are two extension hosts, and nothing ties a hook or a request to the right
one except the editor in the chain and the workspace folder.

- **A server the editor started says so now.** `src/adapters/editor.ts` finds the process
  `VSCODE_PID` names among its ancestors, with nothing in between but the editor's own
  executable, and the server sends `session_identity: "ancestor_chain:editor"` in the
  `capability_row` of `hello`, the chain with the editor in it, and the first workspace folder
  of `WORKSPACE_FOLDER_PATHS` as `project_dir`. Measured by `cursor-editor-identity`: the
  editor the harness launched was the second process of the chain, after the extension host,
  and `project_dir` was the workspace while the working directory was the home folder.
- **On Windows that takes the names in the chain**, so such a server walks it with one
  PowerShell query, 0.6 to 0.8 s measured, once, before it registers. Every other server and
  the hook still spawn nothing there.
- **A session the CLI starts keeps the parent key.** Its parent is the CLI, no `VSCODE_PID`
  reaches it, and its `hello` carries no `session_identity` (measured by the degraded-path
  run). So does a server started through a launcher such as `npx`, which sits between it and
  the editor.

### Tool timeouts and cancellation (A-04, A-09)

Cursor reads no timeout from an MCP entry: neither the editor's MCP client nor the CLI's has a
field for one (read from the 3.20.10 bundle and from the CLI's code). What limits a call:

| Surface | Limit                                                                                                  | How it is known                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI     | The MCP SDK's 60 000 ms request timeout, since the CLI passes none; the SDK cancels the call           | Measured: a 90 s `sleep_ms` ended `aborted` by an MCP cancellation after 59 999 ms, and the agent saw "MCP error -32001: Request timed out" |
| Editor  | An idle timeout of 120 000 ms that restarts at every progress notification, and an hour in all at most | Read from the bundle, not measured                                                                                                          |

`tool_timeout_ms_default` is therefore `60000`, the shorter of the two, and
`cancellation_notifications` is `true`. The heartbeat it gives is the 50 s floor, ten seconds
before the CLI's cut. `per_server_timeout_field` is `null`, and nothing an installer writes can
raise the limit — which also means an installer must not write `HANDOFF_TOOL_TIMEOUT_MS` for
Cursor: a larger value there would move the heartbeat past the cut.

### The end-of-turn hook

Cursor has hooks of its own — `~/.cursor/hooks.json` and a project's `.cursor/hooks.json`,
with `stop` and `subagentStop` among twenty-one events — and it also loads Claude Code's `Stop`
and `SubagentStop` hooks from `~/.claude/settings.json` and a project's `.claude/` files as its
own. None of them reaches this server's hook:

- **Under `agent -p` none ran.** The observation run declared a `stop` hook in the project's
  `.cursor/hooks.json` and a `Stop` hook in its `.claude/settings.json`, and neither was
  invoked.
- **The payload is not Claude Code's.** A Cursor `stop` hook is handed `conversation_id`,
  `generation_id`, `model`, `status`, `loop_count`, the token counts, `session_id`,
  `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email` and `transcript_path`,
  and no `stop_hook_active` (read from the CLI's code). `handoff-mcp hook stop` requires it, so
  it answers such a payload — with the event named `stop` or `Stop` — neutrally and silently,
  before it reads the token or opens anything: measured with the built bundle, exit 0, nothing
  on stdout, `hook_input_unusable` in its debug log.
- **So the Claude Code hook costs nothing in Cursor.** On a machine where it is installed,
  Cursor may run it with Cursor's payload; it stays silent, never blocks a Cursor turn and
  cannot fire twice with anything.
- And Cursor's answer is not a block: a `stop` hook may answer `followup_message`, which
  Cursor submits as the next user message, at most five times by default.

So `stop_hook` is `false`, the level is `base`, and a `deferred` or `parked` outcome tells a
Cursor agent that nothing will remind it.

### The degraded path (FM-03, FM-04)

The flow of Codex and OpenCode, against the real CLI with `test/fake-app` listening:

1. The first `handoff_to_user` call was answered `in_progress` after **50 013 ms**, the
   heartbeat, ten seconds before the CLI would have cut it.
2. The CLI resumed, as that instruction says. The overlay reported that the user had deferred
   the step, and the instruction the CLI received was the no-hook variant.
3. The CLI resumed again before finishing, by itself, and received the final
   `confirmed_by_user`.

Three results, two resumes, and no channel line refused by the schema in either direction.

### Text mode (E2E-8)

With no overlay listening, `handoff_to_user` answered `status: "text_mode"` with the spec
rendered as the block of §5.9, and the CLI presented the steps in its reply.

### What a run leaves behind

`agent -p` has no ephemeral mode: every run leaves `~/.cursor/projects/<slug of the
workspace>/` and a conversation under `~/.cursor/chats/`. The runner deletes the entries a run
added to those two folders and nothing else. The editor scenario's own Cursor lives in the
run's temporary folder and is closed, with everything it started, when the server has
registered.

## The scenarios

| Scenario                      | Covers                                           | What it does                                                          |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `observe`                     | A-01, A-02, A-05, A-06, A-08, A-11, A-23, A-24   | One `handoff_runbooks` call with the recording Stop hook installed    |
| `e2e-08-text-mode`            | E2E-8                                            | One `handoff_to_user` call with no overlay listening                  |
| `a03-timeout-honoured`        | A-03, A-09                                       | `sleep_ms` past `MCP_TOOL_TIMEOUT`                                    |
| `a04-per-server-timeout`      | A-04, A-09                                       | `sleep_ms` past the per-server `timeout` field                        |
| `a03-timeout-default`         | A-03                                             | `sleep_ms` for 70 s with nothing configured                           |
| `codex-observe`               | A-01, A-02, A-08, A-23, A-24, SRV-19             | One `handoff_runbooks` call, read from the server's side              |
| `codex-image`                 | A-07                                             | One `image_probe` call; the model names the colour                    |
| `codex-e2e-08-text-mode`      | E2E-8                                            | One `handoff_to_user` call with no overlay listening                  |
| `codex-per-server-timeout`    | A-04, A-09                                       | `sleep_ms` past `tool_timeout_sec = 20`                               |
| `codex-degraded-path`         | FM-03, FM-04, SRV-20                             | Heartbeat, resume, deferral and resume, against `fake-app`            |
| `codex-default-timeout`       | FM-04                                            | `sleep_ms` for 120 s with nothing configured                          |
| `opencode-observe`            | A-01, A-02, A-08, A-23, A-24, SRV-19             | One `handoff_runbooks` call, read from the server's side              |
| `opencode-image`              | A-07                                             | One `image_probe` call; the model names the colour                    |
| `opencode-e2e-08-text-mode`   | E2E-8                                            | One `handoff_to_user` call with no overlay listening                  |
| `opencode-per-server-timeout` | A-04, A-09                                       | `sleep_ms` past `"timeout": 20000`                                    |
| `opencode-degraded-path`      | FM-03, FM-04, SRV-20                             | Heartbeat, resume, deferral and resume, against `fake-app`            |
| `opencode-default-timeout`    | FM-04, A-09                                      | `sleep_ms` for 120 s with nothing configured; cut at the 60 s default |
| `cursor-editor-identity`      | R-12, SRV-17, SRV-18, SRV-19, A-08               | Cursor's editor, launched on a throw-away project; no agent request   |
| `cursor-observe`              | A-01, A-02, A-05..A-08, A-11, A-23, A-24, SRV-19 | One `handoff_runbooks` call, one `image_probe` call, the hooks        |
| `cursor-e2e-08-text-mode`     | E2E-8                                            | One `handoff_to_user` call with no overlay listening                  |
| `cursor-degraded-path`        | FM-03, FM-04, SRV-20, R-12                       | Heartbeat, resume, deferral and resume, against `fake-app`            |
| `cursor-default-timeout`      | FM-04, A-04, A-09                                | `sleep_ms` for 90 s with nothing configured; cut at the 60 s default  |

Not covered here, and why: **A-07** is measured for Codex, OpenCode and Cursor's CLI through
`image_probe`; the Claude Code scenarios do not run it, and for Claude Code it rests on E2E-3,
which needs an overlay. Nothing about a tool call is measured through Cursor's editor, whose
chat cannot be driven from a script.
**A-10** (`/mcp reconnect`) is interactive and stays a manual check; **A-12..A-26** are about
platforms, OCR, capture and packaging rather than about the agent.

## The classifier

Every assertion declares what it looked at, and that decides what happens when it fails:

- **protocol** — the shape of the run is wrong: the agent did not start, the server did not
  register, an observation the server writes without the model's help is missing or says the
  wrong thing, a tool result carried the wrong `status`. Never retried, because a second
  sampling of the model cannot change it.
- **model** — the run was well formed and the model did not do what the prompt asked. Retried
  exactly once (§11.5).
- **note** — an observation the design does not depend on. Reported, never decisive. A-09 is
  the one Appendix B marks that way itself.

## When to re-run it

After every Claude Code, Codex, OpenCode or Cursor update, and before any release that changes
how the server talks to an agent. The workflow `.github/workflows/canary.yml` does the same
thing on a `workflow_dispatch` for the first three, comparing the npm dist-tags of
`@anthropic-ai/claude-code`, `@openai/codex` and `opencode-ai` against
`test/canary/last-claude-version`, `test/canary/last-codex-version` and
`test/canary/last-opencode-version`; each agent's job skips gracefully when its API key is not
configured, which is the current state. Cursor has no job and no version file: every run of
its CLI spends one of the account's requests and the editor scenario opens a window, so
`pnpm canary -- --agent cursor` is run by hand, after a Cursor update, and rarely.

When a run's numbers differ from the tables above, update this page in the same commit as
whatever the difference forced, and bump the version file of that agent.
