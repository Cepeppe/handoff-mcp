# handoff-mcp documentation

`handoff-mcp` is an MCP server through which a coding agent hands one unit of work to the
person at the machine and waits for the result. The agent writes a **handoff spec** — the
goal, where the work happens, why a person has to do it, the values to use, the steps — and
calls a tool that blocks. The person does the work. The agent gets back an **outcome**: a
structured object saying what happened and what to do next.

That is the whole idea. Everything below is the contract around it.

## The three public promises

The server is one implementation; these three are the interface, and they are what this
repository publishes under MIT so that anything can produce or read them.

| Promise                               | File                                                                          | Who writes it                    | Who reads it                                 |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| [The handoff spec](handoff-spec.md)   | [`handoff-spec.v1.schema.json`](../schemas/handoff-spec.v1.schema.json)       | The agent, as the tool's input   | The server validates it, an overlay shows it |
| [The outcome](outcome.md)             | [`handoff-outcome.v1.schema.json`](../schemas/handoff-outcome.v1.schema.json) | The server, as the tool's result | The agent branches on `status`               |
| [The tool contract](tool-contract.md) | [`tool-contract.v1.md`](../schemas/tool-contract.v1.md)                       | This repository, normatively     | The server generates its texts from it       |

Two more formats are public without being promises of the same weight: the
[runbook format](runbook-format.md), which is what the saved recipes in
`~/.handoff/runbooks/` look like, and the
[certain-secret patterns](../patterns/certain-secrets.v1.json), the high-precision regexes
that decide which values are masked before they leave the machine.

The [internal channel protocol](channel.md) is not a promise: it lives in this repository so
that the server can be built and tested from here alone, and it may change in any release.

## Where to start

| If you want to                                               | Read                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Use the server in your own MCP client, with nothing else     | [Installing without the app](install-without-app.md) |
| Write a spec, or make a client that produces one             | [The handoff spec](handoff-spec.md)                  |
| Read what comes back                                         | [The outcome](outcome.md)                            |
| Know exactly which tools exist and what their texts say      | [The tool contract](tool-contract.md)                |
| Understand what the server does when no overlay is listening | [Text mode](text-mode.md)                            |
| Read or write the saved recipes                              | [The runbook format](runbook-format.md)              |
| Understand an error the server returned                      | [The error catalogue](errors.md)                     |
| Know what a version number promises                          | [Versions and compatibility](versioning.md)          |
| Understand the socket between the server and an overlay      | [The internal channel](channel.md)                   |
| Build the standalone executables                             | [Building the executables](build-sea.md)             |
| Know which agent behaviours were measured, and when          | [Measured agent facts](agent-facts.md)               |

## What the server does, and what it does not

It **does** validate a spec against the published schema and the semantic rules, mask values
that match a certain-secret pattern before they go anywhere, search the user's saved
runbooks, hold the blocking call open across a long piece of human work, heartbeat before the
agent's own tool timeout expires so the call ends on our terms, and answer every call with an
outcome carrying an `instruction` the agent can follow with nothing else.

It **does not** click, type or read the screen; it makes no network connection of any kind;
it calls no model; and it never writes a file of yours. Its only storage is what it reads:
the runbook folder and the connection token under `~/.handoff/`. The single exception is a
test switch nobody sets in normal use: with `HANDOFF_CANARY=1` the server registers two
extra tools and records what it observed about the agent under `$HANDOFF_HOME/canary/`,
which is how the facts in [measured agent facts](agent-facts.md) were obtained.

An overlay application may connect to the server over a local socket to show the handoff to
the user; that application is a separate, closed product, and this repository documents only
the socket it connects on. With nothing listening, the server still works —
[text mode](text-mode.md) is the documented degraded path, and it is what remote agents get
as well.

## Support levels

The server keeps a static capability table (`src/adapters/capabilities.json`) with one row
per agent, because the answers differ: how long a tool call may block, whether images can
travel in a tool result, whether the agent runs an end-of-turn hook. The row is resolved once
per session, from `HANDOFF_AGENT` if the environment sets it, otherwise from the
`clientInfo.name` of the MCP handshake, otherwise from the `unknown` row.

| Level         | What it means                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`        | A long, configurable tool timeout, images in tool results, and an end-of-turn hook that can remind the agent about an unfinished handoff.                                                       |
| `base`        | No end-of-turn hook: what keeps a long handoff alive is the blocking call, the `in_progress` heartbeat and the `instruction` text. Images travel only where the row says the client shows them. |
| `unsupported` | Reserved for an agent that cannot make a blocking call at all. No such row ships.                                                                                                               |

`base` is not a broken mode: the instruction in every outcome is written so that an agent
which reads nothing else still behaves correctly. The rows that ship today:

| Agent (`HANDOFF_AGENT`) | Level  | Images in tool results | End-of-turn hook | Per-server timeout field               |
| ----------------------- | ------ | ---------------------- | ---------------- | -------------------------------------- |
| `claude-code`           | `full` | yes                    | yes              | `timeout`, in milliseconds             |
| `codex`                 | `base` | yes                    | no               | `tool_timeout_sec`, in seconds         |
| `cursor`                | `base` | yes                    | no               | none                                   |
| `copilot`               | `base` | yes                    | no               | `timeout`, in milliseconds (the CLI's) |
| `opencode`              | `base` | yes                    | no               | `timeout`, in milliseconds             |
| `unknown` (any other)   | `base` | no                     | no               | —                                      |

Every value of a shipped row was measured against the real agent;
[measured agent facts](agent-facts.md) says when, and against which version. `copilot` is
GitHub Copilot on both of its surfaces, VS Code's chat and the Copilot CLI.

One fact belongs to a session rather than to its agent: whether an editor started the server.
A CLI agent starts it itself, and the overlay keys that session on the server's parent. An
editor of the VS Code family — Cursor's, and VS Code, where Copilot runs — starts it from its
own extension host, once per window, so the server tells the overlay to key that session on
the editor and on its workspace folder instead; the [channel](channel.md) carries it as
`session_identity`. The workspace folder is the one Cursor names in `WORKSPACE_FOLDER_PATHS`,
or, where an editor names it in no variable, as VS Code does, the first of the roots its MCP
client lists. Cursor's CLI and the Copilot CLI share their editor's row and are keyed on
their parent like any other CLI agent.

Remote agents (an agent running in the cloud rather than on your machine) find no socket and
get [text mode](text-mode.md) with no extra code. That works, and it is not supported: there
is no overlay, no log and no verified state on the other side.

`handoff-mcp doctor` prints the row it resolved, where it resolved it from, and what it can
reach. It is the first thing to look at when the behaviour is not what you expected.

## Licence

MIT, including the schemas, the patterns, the channel definition and the fixtures. See
[`LICENSE`](../LICENSE).
