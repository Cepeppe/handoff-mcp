# The canary harness

What this directory does, and the rules that are not negotiable. The measurements it
produced are in [`docs/agent-facts.md`](../../docs/agent-facts.md); read that first if you
want the answers rather than the machinery.

A canary is not a gate (TECHNICAL-DESIGN §11.1, DD-34). Everything that can be tested
without a language model is a merge gate and lives in `test/unit`, `test/contract` and
`test/integration`. What lives here needs a real agent — Claude Code, and since T-066 Codex
— real credentials and real money, so `vitest.config.ts` excludes this directory outright:
`pnpm test` never touches it and `pnpm canary` is the only way in.

```
pnpm build && pnpm canary            # every scenario of both agents
pnpm canary -- --agent codex         # one agent's scenarios
pnpm canary -- --list                # what exists, without spending anything
pnpm canary -- observe               # one of them
```

## The three rules

1. **The agent never sees the user's own MCP servers.** For Claude Code that is
   `--strict-mcp-config`, always: without it the agent loads every MCP server configured on
   the machine the canary runs on — on a developer's machine, their own accounts.
   `workspace.ts` puts the flag in unconditionally and `test/unit/canary/harness.test.ts`
   fails if it ever comes out. Codex has no such flag, and a `-c mcp_servers.…` override
   _merges_ with the user's servers, so `agents/codex/workspace.ts` passes
   `--ignore-user-config` instead and turns off `apps` and `plugins`, the two ways a Codex
   session reaches connected accounts; `test/unit/canary/codex.test.ts` pins all three.
2. **`CLAUDECODE` is cleared for the child, always.** Claude Code refuses to run nested
   inside another Claude Code session, and this harness is normally started from one.
3. **`HANDOFF_HOME` is a temporary folder, always.** The probe writes there, the token file
   of a real installation lives there, and a canary must never be pointed at `~/.handoff/`.

## The parts

| File                        | What it is                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `workspace.ts`              | Pure: the MCP configuration, the project settings, the child environment, the command line   |
| `runner.ts`                 | One Claude Code run: build the throw-away project, spawn `claude`, collect the three sources |
| `classify.ts`               | Protocol failure or model behaviour, and the single retry §11.5 allows                       |
| `scenarios/`                | The Claude Code scenarios, one file per group of assumptions                                 |
| `hooks/record-stop.mjs`     | The recording Stop hook of A-05, A-06 and A-11                                               |
| `agents/codex/workspace.ts` | Pure: the `codex exec` command line, the `-c` overrides that declare our server, the env     |
| `agents/codex/runner.ts`    | One Codex run: spawn `codex exec --json`, map its events onto the same `CanaryRun`           |
| `agents/codex/app.ts`       | `test/fake-app`, bundled on the fly, for the scenario that needs an overlay listening        |
| `agents/codex/*.ts`         | The Codex scenarios, and the checks they share (`scenario.ts`)                               |
| `cli.ts`                    | Pure: the `--agent` / `--list` command line                                                  |
| `main.ts`                   | `pnpm canary`: run, classify, retry once, report, write `results/last-run.json`              |
| `last-claude-version`       | The Claude Code version the recorded facts were measured against; `canary.yml` diffs it      |
| `last-codex-version`        | The same for Codex                                                                           |

The deterministic half — the configuration shapes, the environment, the command lines, the
event mapping, the classifier — is unit-tested in `test/unit/canary/`, and that is
deliberate: a malformed MCP entry would make every canary fail for a reason that has
nothing to do with the agent, and the report would look like an agent regression.

## The three sources of truth

A scenario reads a run from three sides, and which side an assertion reads decides whether
it is a protocol failure or a model one:

- **the transcript** — the messages the agent printed: `stream-json` for Claude Code, the
  `--json` events for Codex, both mapped onto one shape. This is what the model did, and an
  assertion on it is a model assertion.
- **the observations** — `$HANDOFF_HOME/canary/observations.jsonl`, written by the canary
  probe **inside the server** (`src/mcp/canary.ts`, active only under `HANDOFF_CANARY=1`).
  This is what the protocol did, and it does not depend on the model having behaved.
- **the hook records** — `$HANDOFF_HOME/canary/hook.jsonl`, written by `record-stop.mjs`.
  Codex runs no hook under `codex exec`, so its runs have none.

The Codex degraded-path scenario adds a fourth: what the scripted overlay received, which is
where the heartbeat's `handoff.detach_call` and every resume show up.

## Writing a scenario

Give it an id, the assumption ids it covers, the run options, a `check` that returns
assertions and a `facts` that returns what was _measured_ — the two are not the same, and
half of Appendix B is about the number rather than about the tick. Then add it to
`scenarios/index.ts` or `agents/codex/index.ts`, cheapest first. A Codex scenario's id
starts with `codex-`.

Three things learnt the hard way and worth not re-learning:

- **Do not tell the model what not to call.** In Claude Code 2.1.263 an MCP tool reaches the
  model through its own `ToolSearch` first, so "do not call any other tool" forbids the call
  that makes the wanted call possible. The scenario then fails as a model failure for a
  reason that is the harness's fault.
- **Name the server in a Codex prompt.** "Call the tool `handoff_runbooks` of the MCP server
  `handoff`" is what Codex 0.153.4 acts on reliably. And every tool that is not annotated
  read-only needs `default_tools_approval_mode = "approve"` on our entry, which the harness
  writes; without it `codex exec` refuses the call and the run looks like a model failure.
- **Prefer an observation to a transcript assertion** whenever both would work. A protocol
  fact asserted through the model's behaviour becomes a flaky test; the same fact read from
  the observation file is deterministic.
