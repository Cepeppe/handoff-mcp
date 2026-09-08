# handoff-mcp

An MCP server that lets a coding agent hand one unit of work to the human at the machine and
wait for the result.

Some steps are not the agent's to take: creating an OAuth app, clicking through a billing
console, granting a permission the operating system will only grant to a person. Today an
agent stops and writes a paragraph of instructions into the chat, and everything after that —
which step you are on, what you typed, whether it worked — lives in nobody's head but yours.

`handoff-mcp` makes that exchange a structured one. The agent writes a **handoff spec**: the
goal, where the work happens, why a person has to do it, the values to use, the steps, and
what the agent will verify afterwards. The call blocks. When the work is done the agent gets
back an **outcome**: what happened, and what to do next.

The formats are public and versioned, the server is MIT, and it works on its own in any MCP
client. An overlay application may connect to it over a local socket to show the handoff to
the user; this repository documents the socket, not that application.

**Status: work in progress. Nothing is stable yet.**

## Install

```console
$ npx -y baton-handoff-mcp --version
```

Then register it as a stdio MCP server. In Claude Code, one entry in `~/.claude.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "baton-handoff-mcp"],
      "env": { "HANDOFF_AGENT": "claude-code" }
    }
  }
}
```

`HANDOFF_AGENT` is worth setting: it tells the server which agent it is talking to, and
therefore how long a call may block and what the results may contain. The full route, the
optional timeout and hook settings, and what `doctor` should print are in
[Installing the server on its own](docs/install-without-app.md).

> Until the first real release is published, the registry holds a placeholder that reserves
> the name. Build from a checkout instead: `pnpm install && pnpm build`, then point your
> client at `node <path>/dist/handoff-mcp.cjs`.

## What it looks like with nothing else installed

With nothing listening on the local socket, the server still works. It validates the spec,
masks anything matching a certain-secret pattern, and hands the agent the spec as text to walk
the person through in the chat:

```json
{
  "status": "text_mode",
  "final": false,
  "handoff_id": null,
  "app_reachable": false,
  "instruction": "The overlay app is not running. Present the spec in spec_text to the user in chat, walk them through the steps one at a time, and collect the result in chat. Nothing is logged and no verified state exists in this mode: there is no handoff to resume and no verification to report.",
  "spec_text": "…"
}
```

```text
# Handoff (text mode): Register the Stripe webhook for payment events
Where: Stripe Dashboard → Developers → Webhooks  [https://dashboard.stripe.com/webhooks]
Why a person: Requires access to the production Stripe account.
Values (from the project):
  - endpoint_url: https://api.myapp.example/webhooks/stripe
  - events: checkout.session.completed, invoice.paid
Steps:
  1. Click Add endpoint and paste the endpoint URL.   (values: endpoint_url)
  2. Select the events checkout.session.completed and invoice.paid.   (values: events)
  3. Save and copy the signing secret.
  4. Paste it into .env as STRIPE_WEBHOOK_SECRET.
After the steps, the user copies these values into project files (never paste them in chat):
  - STRIPE_WEBHOOK_SECRET → .env
Verification you must perform afterwards: Check that STRIPE_WEBHOOK_SECRET exists in .env without reading its value, then send a test event from the dashboard and verify it reaches /webhooks/stripe with a valid signature.
```

That is [text mode](docs/text-mode.md), and it is a supported way to use this: a validated
spec, one step at a time, values named and kept out of prose, secrets masked before anybody
can paste them. What it does not have is memory — no log, no verified state, nothing to
resume — and the instruction says so, because in that mode the instruction is all the agent
has.

Two commands do the same work offline, with no agent at all:

```console
$ handoff-mcp validate spec.json
spec.json: valid handoff spec (spec_version 1, 4 steps, 2 values, 1 secret, verify present)

$ handoff-mcp runbooks search --where "Stripe Dashboard > Developers > Webhooks" \
    --goal "Set up the Stripe webhook" --lang en
{ "runbooks": [ … ] }
```

## Documentation

| Page                                                      | What is in it                                             |
| --------------------------------------------------------- | --------------------------------------------------------- |
| [Overview](docs/index.md)                                 | What the server is, the public promises, support levels   |
| [The handoff spec](docs/handoff-spec.md)                  | Every field, the limits, the rules, secret handling       |
| [The outcome](docs/outcome.md)                            | Every status and field, verification                      |
| [The tool contract](docs/tool-contract.md)                | The three tools and the texts an agent reads              |
| [Text mode](docs/text-mode.md)                            | The degraded path and exactly what it does not give you   |
| [The runbook format](docs/runbook-format.md)              | Saved recipes, placeholders, the matching rule            |
| [The error catalogue](docs/errors.md)                     | Every code, and what to do about it                       |
| [Installing without the app](docs/install-without-app.md) | The manual route, `doctor`, `validate`, the environment   |
| [Versions and compatibility](docs/versioning.md)          | What each version number promises                         |
| [The internal channel](docs/channel.md)                   | The local socket, its threat model, its lack of a promise |
| [Building the executables](docs/build-sea.md)             | The standalone per-platform build                         |
| [Measured agent facts](docs/agent-facts.md)               | What was measured against the real agent, and when        |

The machine-readable contract is in [`schemas/`](schemas/): the three JSON Schemas and
[`tool-contract.v1.md`](schemas/tool-contract.v1.md), from which the texts the server sends
are generated. [`patterns/`](patterns/) holds the certain-secret patterns and the stop-word
lists, [`fixtures/`](fixtures/) the examples every implementation is checked against.

## Development

Node 22 is the minimum supported version (`engines.node`); `.nvmrc` and `.node-version` pin
24, which is what CI and development use. Install with `pnpm install`, then:

| Script               | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm build`         | Bundles `src/` into `dist/handoff-mcp.cjs`, the file `bin` points at |
| `pnpm handoff-mcp`   | Runs that bundle: `pnpm handoff-mcp validate <spec.json>`            |
| `pnpm test`          | Runs the Vitest suites, except the canaries                          |
| `pnpm test:contract` | Runs the contract suite alone                                        |
| `pnpm lint`          | ESLint, type-aware                                                   |
| `pnpm format`        | Prettier, in place (`pnpm format:check` to only check)               |
| `pnpm typecheck`     | `tsc --noEmit`                                                       |
| `pnpm check:links`   | Every relative link in the Markdown resolves                         |

## Licence

MIT — see [`LICENSE`](LICENSE). That covers the server, the schemas, the patterns, the
channel definition and the fixtures.
