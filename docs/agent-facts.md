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
pnpm canary         # every scenario
pnpm canary -- observe a03-timeout-honoured    # only these
pnpm canary -- --list                          # what exists, without spending anything
```

`claude` must be on `PATH` and logged in. Each run builds a throw-away project under the
system temporary directory with its own `HANDOFF_HOME`, so nothing touches `~/.handoff/`,
and the report is written to `test/canary/results/last-run.json` (git-ignored).

| Variable                | Effect                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `HANDOFF_CANARY_MODEL`  | The model to run against. Default `sonnet`, so a run stays cheap.  |
| `HANDOFF_CANARY_KEEP=1` | Keeps each run's temporary project, for reading a failure by hand. |

Two rules of the harness are not options. **`--strict-mcp-config` is always passed**, so a
run can never reach the MCP servers configured on the machine it runs on; and `CLAUDECODE`
is always cleared for the child, because Claude Code refuses to run nested inside another
Claude Code session and the harness is normally started from one.

The server itself takes part: with `HANDOFF_CANARY=1` in the MCP entry's `env` block it
registers one extra tool, `sleep_ms`, and writes an observation file under
`$HANDOFF_HOME/canary/`. Without that variable — every ordinary run, every installed
server, every other test — neither exists. What the probe records is names and resolved
values, never the value of an environment variable and never anything from a spec.

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

## The scenarios

| Scenario                 | Covers                                         | What it does                                                       |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| `observe`                | A-01, A-02, A-05, A-06, A-08, A-11, A-23, A-24 | One `handoff_runbooks` call with the recording Stop hook installed |
| `e2e-08-text-mode`       | E2E-8                                          | One `handoff_to_user` call with no overlay listening               |
| `a03-timeout-honoured`   | A-03, A-09                                     | `sleep_ms` past `MCP_TOOL_TIMEOUT`                                 |
| `a04-per-server-timeout` | A-04, A-09                                     | `sleep_ms` past the per-server `timeout` field                     |
| `a03-timeout-default`    | A-03                                           | `sleep_ms` for 70 s with nothing configured                        |

Not covered here, and why: **A-07** (images in tool results) needs a screenshot and an
overlay; **A-10** (`/mcp reconnect`) is interactive and stays a manual check; **A-12..A-26**
are about platforms, OCR, capture and packaging rather than about the agent.

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

After every Claude Code update, and before any release that changes how the server talks to
an agent. The workflow `.github/workflows/canary.yml` does the same thing on a
`workflow_dispatch`, comparing the npm dist-tag of `@anthropic-ai/claude-code` against
`test/canary/last-claude-version`; it skips gracefully when no API key is configured, which
is the current state.

When a run's numbers differ from the table above, update this page in the same commit as
whatever the difference forced, and bump `test/canary/last-claude-version`.
