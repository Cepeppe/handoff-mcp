# The internal channel

> **This protocol is internal, subject to change without notice.**
>
> Unlike the schemas in [`schemas/`](../schemas/), which are a promise to anyone who writes an
> agent or reads a runbook, the channel is the private conversation between the
> `handoff-mcp` server and an overlay application. Its definition lives in this open
> repository because the server must be buildable and testable from here alone — not because
> it is published. Any release may change it, and both peers ship from the same release.

The definition is [`protocol/channel/channel.v1.schema.json`](../protocol/channel/channel.v1.schema.json),
the version is the single integer in [`protocol/channel/protocol_version`](../protocol/channel/protocol_version),
and [`protocol/channel/README.md`](../protocol/channel/README.md) is the reference: methods,
error codes, timeouts, framing rules and the golden message sequences. This page is the part
that concerns anybody who is not writing a codec — what the socket is, what protects it, and
what it is allowed to carry.

## What it is

One local stream socket: a Unix domain socket at `~/.handoff/app.sock` on macOS, a named pipe
on Windows. No TCP port, so no other host can reach it and the operating system's permissions
apply for free. Messages are JSON-RPC 2.0 objects, one per line, UTF-8 (NDJSON), capped at
16 MiB.

The overlay listens; servers connect to it. The overlay never launches, restarts or
supervises a server — the server is a child of the agent, and it is the agent's to manage.
A server whose connection drops keeps retrying (1, 2, 5, 10, then 30 seconds), degrading
every new call to [text mode](text-mode.md) meanwhile, and re-attaches its pending calls when
the channel comes back.

## Authentication

A per-installation token: 32 random bytes as 64 lowercase hexadecimal characters in
`~/.handoff/channel.token`, written with user-only permissions and read by both peers at
every connection attempt, so a regenerated token is picked up without restarting anything.
There are no per-session tokens; they would add nothing and would leak into configuration
files.

The first message on a connection must be `hello`, within two seconds, carrying the token and
the protocol version. The token is compared in constant time and the version for equality. A
failure is answered and the connection closes.

The overlay does not verify server identity beyond the token. The server is open by design
and the user controls what is registered in their agent, so any server presenting the right
token and the right protocol version is served — including one installed from npm.

## The threat model

Stated verbatim, because a security boundary you have to infer is not a boundary:

> The token protects against other users of the same machine and against accidental
> connections. It does not protect against a malicious process already running as the same
> user; that is the operating system's boundary.

That is the honest extent of it. Everything on both sides of this socket runs as one OS user.
A process already running as you can read `~/.handoff/channel.token`, and at that point it
can do anything you can do — the token is not what stands between you and it. What the token
does buy is real and worth having: another user on a shared machine cannot connect, and
nothing connects to the overlay by accident.

Beyond the token: operating-system permissions on the endpoint (mode `0600` for the socket
file, a DACL granting the current user only for the named pipe), the message size cap, schema
validation of every message on both sides, nothing received is ever evaluated, and a ten
second timeout on non-blocking requests. A malformed or unknown message closes the connection
rather than being answered.

## What crosses it

Handoff traffic, and nothing else. There is no network in this: the socket is local, the
server makes no outbound connection of any kind, and neither peer sends anything anywhere
else.

Screenshot pixels cross **only** from the overlay to the server, inside an outcome, after the
person has seen and accepted the mandatory preview. The server holds them in memory for the
duration of the tool result and nothing else; they are never written to disk here and never
travel in the other direction.

Values that matched a [certain-secret pattern](../patterns/certain-secrets.v1.json) are
already masked before they reach the socket — the scan happens at ingress, when the spec
enters the server, so a masked value is masked everywhere downstream.

## Versioning

`protocol_version` must be **equal** on both sides. There is no negotiation and no support for
older versions: both binaries ship from one release, so a mismatch means an npm-installed
server meeting an overlay of another version, or a stale application. On mismatch the overlay
answers with its own version and closes; the server keeps retrying every five minutes in case
the application is updated, and serves every call in text mode with an instruction to update
it.

Because of that answer, the schema accepts any positive integer as the `protocol_version` of a
`hello`. A peer speaking a version we do not know must still be understood well enough to be
told to update, rather than dropped as a framing error.

## If you are writing a codec

Read [`protocol/channel/README.md`](../protocol/channel/README.md) and validate against the
schema; the golden sequences in [`fixtures/channel/`](../fixtures/channel/) are one file per
flow and are replayed by the test doubles on both sides, so they cannot drift from the real
peers. And read the notice at the top of this page again: the stability promise is the one
thing this repository deliberately withholds.
