# The canary harness

What this directory does, and the rules that are not negotiable. The measurements it
produced are in [`docs/agent-facts.md`](../../docs/agent-facts.md); read that first if you
want the answers rather than the machinery.

A canary is not a gate (TECHNICAL-DESIGN §11.1, DD-34). Everything that can be tested
without a language model is a merge gate and lives in `test/unit`, `test/contract` and
`test/integration`. What lives here needs the real Claude Code, real credentials and real
money, so `vitest.config.ts` excludes this directory outright: `pnpm test` never touches it
and `pnpm canary` is the only way in.

```
pnpm build && pnpm canary            # every scenario
pnpm canary -- --list                # what exists, without spending anything
pnpm canary -- observe               # one of them
```

## The three rules

1. **`--strict-mcp-config`, always.** Without it the agent loads every MCP server configured
   on the machine the canary runs on — on a developer's machine, that means their own
   accounts. `workspace.ts` puts the flag in unconditionally and
   `test/unit/canary/harness.test.ts` fails if it ever comes out.
2. **`CLAUDECODE` is cleared for the child, always.** Claude Code refuses to run nested
   inside another Claude Code session, and this harness is normally started from one.
3. **`HANDOFF_HOME` is a temporary folder, always.** The probe writes there, the token file
   of a real installation lives there, and a canary must never be pointed at `~/.handoff/`.

## The parts

| File                    | What it is                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `workspace.ts`          | Pure: the MCP configuration, the project settings, the child environment, the command line |
| `runner.ts`             | One run: build the throw-away project, spawn `claude`, collect the three sources of truth  |
| `classify.ts`           | Protocol failure or model behaviour, and the single retry §11.5 allows                     |
| `scenarios/`            | One file per group of assumptions; each turns a run into assertions and facts              |
| `hooks/record-stop.mjs` | The recording Stop hook of A-05, A-06 and A-11                                             |
| `main.ts`               | `pnpm canary`: run, classify, retry once, report, write `results/last-run.json`            |
| `last-claude-version`   | The version the recorded facts were measured against; `canary.yml` diffs it                |

The deterministic half — the configuration shapes, the environment, the command line, the
classifier — is unit-tested in `test/unit/canary/`, and that is deliberate: a malformed MCP
entry would make every canary fail for a reason that has nothing to do with the agent, and
the report would look like an agent regression.

## The three sources of truth

A scenario reads a run from three sides, and which side an assertion reads decides whether
it is a protocol failure or a model one:

- **the transcript** — the `stream-json` messages the agent printed. This is what the model
  did, and an assertion on it is a model assertion.
- **the observations** — `$HANDOFF_HOME/canary/observations.jsonl`, written by the canary
  probe **inside the server** (`src/mcp/canary.ts`, active only under `HANDOFF_CANARY=1`).
  This is what the protocol did, and it does not depend on the model having behaved.
- **the hook records** — `$HANDOFF_HOME/canary/hook.jsonl`, written by `record-stop.mjs`.

## Writing a scenario

Give it an id, the assumption ids it covers, the run options, a `check` that returns
assertions and a `facts` that returns what was _measured_ — the two are not the same, and
half of Appendix B is about the number rather than about the tick. Then add it to
`scenarios/index.ts`, cheapest first.

Two things learnt the hard way and worth not re-learning:

- **Do not tell the model what not to call.** In Claude Code 2.1.263 an MCP tool reaches the
  model through its own `ToolSearch` first, so "do not call any other tool" forbids the call
  that makes the wanted call possible. The scenario then fails as a model failure for a
  reason that is the harness's fault.
- **Prefer an observation to a transcript assertion** whenever both would work. A protocol
  fact asserted through the model's behaviour becomes a flaky test; the same fact read from
  the observation file is deterministic.
