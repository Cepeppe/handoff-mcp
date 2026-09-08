# Installing the server on its own

`handoff-mcp` works with nothing else installed. Registered in any MCP client, it validates
specs, masks secrets, searches runbooks and returns a spec the agent walks the person through
in the chat — [text mode](text-mode.md). Read that page first for what this does and does not
give you.

This page is the manual route. An overlay application, if you have one, registers the server
for you and this is not the path you want.

## Getting the server

```console
$ npx -y baton-handoff-mcp --version
```

The npm package is `baton-handoff-mcp` and its single binary is `handoff-mcp`, so `npx` runs
it from the package name; `npx -y -p baton-handoff-mcp handoff-mcp` is the explicit spelling
of the same thing. Requires Node 22 or later.

> **While this is unreleased**, the registry holds a placeholder that only reserves the name:
> it prints a notice and exits. Until the first real publish, use a checkout —
> `pnpm install && pnpm build` — and point your client at `node <path>/dist/handoff-mcp.cjs`.
> Each tagged release also builds a standalone executable per platform that needs no Node at
> all; see [Building the executables](build-sea.md).

## Registering it in Claude Code

Add one entry to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "handoff": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "baton-handoff-mcp"],
      "env": {
        "HANDOFF_AGENT": "claude-code"
      }
    }
  }
}
```

Project scope is `.mcp.json` in the project folder, with the same object. Restart the client,
or reconnect the server, and `handoff_to_user`, `handoff_verify` and `handoff_runbooks`
appear in its tool list.

Any other MCP client works the same way: a stdio server, one command, no arguments. What
changes is the name and the shape of that client's configuration file.

## Set `HANDOFF_AGENT`

**This is the one setting worth getting right.** The server keeps a capability table with one
row per agent — how long a call may block, whether images can travel in a tool result,
whether an end-of-turn hook exists — and it resolves the row in this order:

1. the `HANDOFF_AGENT` environment variable;
2. the `clientInfo.name` of the MCP handshake, matched against the names each row knows;
3. the `unknown` row.

Step 2 is a fallback, not a promise: what a client sends in `clientInfo.name` is undocumented
and changes between versions, so it is recorded empirically rather than relied upon. Without
step 1 you can silently land on `unknown`, which heartbeats every 50 seconds and assumes no
images and no hook. Everything still works — that is what `base` support means — but you get
the cautious version of it.

The value is the agent id from the table: `claude-code` today, with `codex`, `cursor`,
`copilot` and `opencode` reserved for their adapters. `handoff-mcp doctor` prints the row it
resolved and whether it came from `HANDOFF_AGENT` or from the `unknown` row — it has no MCP
handshake of its own, so it cannot show you step 2.

## Optional: let a call block for longer

The interesting handoffs take longer than a default tool timeout. Nothing breaks when you
leave this alone — the server returns `in_progress` shortly before the timeout would have
hit, the agent calls back with `resume`, and the loop continues for as long as the work takes
— but each round trip costs a turn, so raising the timeout is worth it if your client allows.

- If your client supports a **per-server timeout**, raise it for this entry alone. In Claude
  Code that is a `"timeout"` field, in milliseconds, next to `"command"`.
- Set `HANDOFF_TOOL_TIMEOUT_MS` in the entry's `env` to the same number, so the server knows
  what you configured and can heartbeat one minute before it rather than guessing.
- Claude Code also reads a global `MCP_TOOL_TIMEOUT` from `~/.claude/settings.json`. It
  applies to **every** MCP server of that client, not only this one, which is why it is worth
  preferring the per-server field.

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "baton-handoff-mcp"],
  "env": { "HANDOFF_AGENT": "claude-code", "HANDOFF_TOOL_TIMEOUT_MS": "1800000" },
  "timeout": 1800000
}
```

The heartbeat is the configured timeout minus one minute, never less than 50 seconds.

## Optional: the end-of-turn hook

`handoff-mcp hook stop` is the subcommand an agent runs at the end of a turn. It asks whether
anything is still waiting for the person and, if so, prints a decision that stops the agent
once so it comes back to it.

It is only useful with an overlay listening — it is that overlay that knows what is still
open — so in text mode there is nothing to register. With one running, add it to
`~/.claude/settings.json` under both `Stop` and `SubagentStop`, with the same command and a
5 second timeout, so a hung hook can never hold the agent:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "handoff-mcp hook stop", "timeout": 5 }]
      }
    ]
  }
}
```

The command has to be one the agent can start immediately: an absolute path to the standalone
executable, or `handoff-mcp` if the package is installed globally. **Not `npx`** — the whole
hook has a budget of 1.8 seconds, and a cold `npx` spends more than that before the
subcommand begins.

The hook never blocks on uncertainty: no overlay, a refused token, a malformed payload or an
answer that comes too late all print nothing and exit 0.

## Check it: `doctor`

```console
$ handoff-mcp doctor
server
  version                    0.2.0
  protocol_version           1
  capabilities_version       1
  node                       v24.18.0
  platform                   win32 x64
  home                       C:\Users\you\.handoff
  log_level                  error

agent
  agent_id                   claude-code
  display_name               Claude Code
  resolved_from              HANDOFF_AGENT
  support                    full
  table_status               supported
  images_in_results          true
  stop_hook                  true
  subagent_stop_hook         true
  session_identity           parent_pid
  user_request_delivery      clipboard_focus, stop_hook
  cancellation_notifications true
  tool_timeout_ms            1800000 (HANDOFF_TOOL_TIMEOUT_MS)
  heartbeat_after_ms         1740000
  per_server_timeout_field   timeout

token
  path                       C:\Users\you\.handoff\channel.token
  status                     missing
  mode                       -

channel
  endpoint                   \\.\pipe\handoff-dd6a31da8ac3a91c
  status                     not probed (the token file is missing)

runbooks
  path                       C:\Users\you\.handoff\runbooks
  status                     ok
  count                      1

problem: the channel token file is missing: install the app, or repair the installation from its settings
```

It is the first thing to look at when the behaviour is not what you expected: it says which
capability row was resolved and from where, what the tool timeout resolved to, whether the
token file is readable and with which permissions, and whether anything is listening on the
socket. The token itself is never printed.

The report above is the normal state of a server installed on its own: there is no token
file, because the token is written by the overlay's installer, so there is nothing to probe
the socket with. `doctor` calls that a problem and exits 1. **In text mode it is not one** —
every call simply degrades, which is what you asked for — and the report is written for the
common case, where the token is missing because an installation went wrong.

With a token present and no overlay running, the channel section reads

```text
channel
  endpoint                   \\.\pipe\handoff-dd6a31da8ac3a91c
  status                     not reachable (ENOENT)
                             the app is not running; every call degrades to text mode
```

and `doctor` ends with `doctor: nothing to repair` and exits 0. Otherwise it exits 1, with one
`problem:` line per thing to fix, for a token that cannot be used or was refused, a protocol
version mismatch, or a runbook folder that exists but cannot be read.

## Check a spec: `validate`

```console
$ handoff-mcp validate spec.json
spec.json: valid handoff spec (spec_version 1, 4 steps, 2 values, 1 secret, verify present)
```

The same pipeline the tool runs — the published schema, then the semantic rules — with the
same JSON error an agent would receive, so a spec can be checked with no agent and no
overlay. Exit 0 when valid, 1 with `{ "error": … }` listing every problem at once, 2 when the
file cannot be read. Errors name paths and expected shapes and never quote the contents of
the spec.

`handoff-mcp runbooks search --where … --goal …` does the same for the matching rule: it
prints exactly what the `handoff_runbooks` tool would return.

## The environment

| Variable                  | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `HANDOFF_AGENT`           | The agent id, authoritative over the handshake. Set it                |
| `HANDOFF_TOOL_TIMEOUT_MS` | The tool timeout you actually configured, in milliseconds             |
| `MCP_TOOL_TIMEOUT`        | Claude Code's own global timeout; read as a fallback for that agent   |
| `HANDOFF_MCP_LOG`         | `error` (default) or `debug`. Logging goes to stderr, never to a file |
| `HANDOFF_HOME`            | Overrides `~/.handoff`. For tests                                     |

None of these names contains `TOKEN`, `SECRET`, `PASSWORD`, `KEY` or `AUTH`, because Claude
Code strips those substrings from the environment of a server declared in project scope. A
variable of ours that carried one would silently vanish exactly where it was needed.

Nothing the server logs contains a spec value: ids, codes, sizes and timings only.

## What it needs from your machine

The runbook folder `~/.handoff/runbooks/` and, if an overlay is running, the token file
`~/.handoff/channel.token` and the socket beside it. Nothing else: no configuration file of
its own, no state directory, no network connection of any kind.
