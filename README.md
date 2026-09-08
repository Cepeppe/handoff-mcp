# handoff-mcp

`handoff-mcp` is an MCP server that lets a coding agent hand a unit of work over to the
human in front of the machine: the agent describes the work as a handoff spec, the call
blocks while the person does it, and the agent gets back a structured outcome. It is
usable alone, in text mode: with no overlay application listening, the spec is rendered
as text in the tool result and the handoff happens in the chat, so the server works in
any MCP client. The public formats (spec, outcome, runbook) and the tool contract are
MIT-licensed and versioned; the npm package is `baton-handoff-mcp`. Status: work in
progress, nothing is stable yet.

## Running it as an MCP server

`handoff-mcp` (or `handoff-mcp serve`, the same thing) speaks MCP over stdio and registers
three tools:

| Tool               | What it does                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handoff_to_user`  | Opens a handoff from a spec, continues it with a reply, or re-attaches to it with `resume`. One flat input object; the server infers which of the three you meant. |
| `handoff_verify`   | Reports the verification you performed after the user finished.                                                                                                    |
| `handoff_runbooks` | Searches the saved runbooks before you write a spec.                                                                                                               |

Every answer is an outcome with `status`, `final` and `instruction`: read `instruction` and
do what it says. Mistakes come back as `{ "error": { "code", "message", "problems" } }` with
a path and a fix per problem, never quoting the spec. `schemas/tool-contract.v1.md` is the
contract, and it is what the descriptions the agent reads are generated from.

With the overlay application listening, the call **blocks** while the person works and
returns on the first thing that needs you: a question, a screenshot, a deferral, the end of
the handoff. Two answers are not the end of it. `in_progress` is the heartbeat — it arrives
shortly before your own tool timeout so the call ends on our terms rather than being cut off,
and the instruction tells you to call `resume` at once. `deferred` means carry on with
something else and resume before you conclude. A resume works from any session, and resuming
a handoff that is already finished returns its outcome again with `already_delivered: true`,
so retrying is always safe.

Without the overlay application listening, the server still works: an open answers
`status: text_mode` with the spec rendered as text — every value the certain-secret patterns
matched masked out — so the handoff happens in the chat. Nothing is logged and no verified
state exists in that mode, so continuing, resuming and verifying answer `APP_DISCONNECTED`
instead.

## Validating a spec offline

`handoff-mcp validate <spec.json>` runs the same pipeline the tool runs — the published
schema, then the semantic rules — and answers with the same JSON error an agent would get,
so a spec can be checked without an agent and without the overlay:

```console
$ handoff-mcp validate spec.json
spec.json: valid handoff spec (spec_version 1, 4 steps, 2 values, 1 secret, verify present)
```

It exits 0 on a valid spec, 1 with `{ "error": { "code", "message", "problems" } }` on an
invalid one (every problem at once, each with a path and what to change), and 2 when the
file cannot be read. Errors never quote the contents of the spec: they name paths, fields,
limits and expected shapes only. From a checkout, `pnpm build` once and then
`pnpm handoff-mcp validate <spec.json>`.

## Searching the saved runbooks offline

A runbook is a recipe saved from a handoff that worked, as a JSON file in
`~/.handoff/runbooks/` (`%USERPROFILE%\.handoff\runbooks\` on Windows).
`handoff-mcp runbooks search` applies the same rule the `handoff_runbooks` tool applies and
prints the same result, so a person can see what an agent would be offered:

```console
$ handoff-mcp runbooks search --where "Stripe Dashboard > Developers > Webhooks" \
    --goal "Set up Stripe webhook for payment notifications" --lang en
{
  "runbooks": [
    {
      "id": "rb_2b9x4d7fkq",
      "matched_words": ["stripe", "webhook", "payment"],
      "draft_spec": { "…": "the runbook as a spec, with [name] where the values go" },
      "values_to_fill": { "endpoint_url": "…", "events": "…" }
    }
  ]
}
```

A runbook matches when its `where` is the same place after normalisation — case, arrows and
the other separators are ignored — **and** the two goals share at least one word beyond
stop-words. There is no fuzzy similarity and no model: `matched_words` says exactly which
words matched. Results are ranked by shared words, then by how recently the runbook was last
verified, and at most five come back.

`--lang` is a BCP-47 tag and selects the stop-word list; without it the shipped lists are
used together. The draft spec is deliberately not yet valid — its values are empty strings —
so nothing can open a handoff with blanks in it: fill `values_to_fill` first.

It exits 0 with a possibly empty list, and 1 with a `RUNBOOKS_UNREADABLE` error when the
folder exists but cannot be read; a folder that is not there is simply an empty list. Files
that could not be parsed are named on stderr and skipped, never fatal. `HANDOFF_HOME`
overrides `~/.handoff` for tests.

## Checking an installation

`handoff-mcp doctor` prints what this server resolved and what it can actually reach, which
is the first thing to look at when something is not behaving:

```console
$ handoff-mcp doctor
server
  version                    0.1.0
  protocol_version           1
  …
agent
  agent_id                   claude-code
  support                    full
  tool_timeout_ms            1800000 (MCP_TOOL_TIMEOUT)
  …
token
  path                       /home/g/.handoff/channel.token
  status                     ok
  mode                       0600
channel
  endpoint                   /home/g/.handoff/app.sock
  status                     reachable
  app_version                1.0.0
  …
doctor: nothing to repair
```

The channel line is a real connection — a hello followed by a goodbye — so it distinguishes
an overlay that is simply not running, which is normal and degrades every call to text mode,
from one that refused the token or speaks another protocol version, which is not. The token
itself is never printed. It exits 0 when there is nothing to repair and 1 otherwise, with one
`problem:` line per thing to fix at the end of the report.

## The Stop hook

`handoff-mcp hook stop` is the subcommand an agent runs at the end of a turn. It reads the
hook payload on its stdin, asks the overlay application whether anything is still waiting for
the user, and prints a decision when it is:

```console
$ echo '{"session_id":"…","hook_event_name":"Stop","stop_hook_active":false,"cwd":"."}' \
    | handoff-mcp hook stop
{"decision":"block","reason":"Handoff hf_7k3m9p2q4r is deferred: resume it before you stop."}
```

It never blocks on uncertainty: a missing application, a refused token, a malformed payload,
an answer that comes too late — all of them print nothing and exit 0. It connects within
500 ms, spends at most 1800 ms in all and hard-exits at 1950 ms, and it makes no attempt to
retry, because the next end of turn is a fresh chance. Installing the hook is the overlay
application's job; nothing has to be configured to run the subcommand by hand.

## Development

Node 22 is the minimum supported version (`engines.node`); `.nvmrc` and `.node-version`
pin 24, which is what CI and development use. Install with `pnpm install`, then:

| Script               | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm build`         | Bundles `src/` into `dist/handoff-mcp.cjs`, the file `bin` points at |
| `pnpm handoff-mcp`   | Runs that bundle: `pnpm handoff-mcp validate <spec.json>`            |
| `pnpm test`          | Runs the Vitest suites, except the canaries                          |
| `pnpm test:contract` | Runs the contract suite alone                                        |
| `pnpm lint`          | ESLint, type-aware                                                   |
| `pnpm format`        | Prettier, in place (`pnpm format:check` to only check)               |
| `pnpm typecheck`     | `tsc --noEmit`                                                       |
