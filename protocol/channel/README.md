# Internal channel protocol, version 1

> **This protocol is internal, subject to change without notice.**
>
> This is not a public interface. Unlike the schemas in `../../schemas/`, which are a
> promise to anyone who writes an agent or reads a runbook, the channel is the private
> conversation between the `handoff-mcp` server and the overlay app. It lives in this open
> repository because the server must be buildable and testable from here alone, not because
> it is published. Any release may change it, and both peers ship from the same release.

The definition is machine-readable in `channel.v1.schema.json`; the version it defines is
in `protocol_version`, a file containing a single integer. Golden message sequences are in
`../../fixtures/channel/`. This file is the reference for whoever writes a codec;
[`../../docs/channel.md`](../../docs/channel.md) is the shorter page for everybody else —
what the socket is, what protects it, and what it is allowed to carry.

## Transport and framing

- One local stream socket: a Unix domain socket on macOS, a named pipe on Windows. No TCP
  port, so no other host can reach it and the operating system's permissions apply for free.
- Messages are **JSON-RPC 2.0** objects, **one per line**, UTF-8, newline-delimited (NDJSON).
- `CHANNEL_MAX_MESSAGE_BYTES` is **16 MiB**. A longer line closes the connection.
- Binary payloads (a screenshot PNG) travel base64-encoded inside JSON. Screenshot pixels
  cross the channel only from app to server, inside an outcome, after the user has seen the
  mandatory preview; the server holds them only for the duration of the tool result.

## Connection lifecycle

The app listens and servers connect; the app never launches, restarts or supervises a
server. One connection carries one peer.

1. **Connected.** The app accepts the socket. The socket file is created with mode `0600`;
   on Windows the pipe carries a DACL granting access to the current user only. A stale
   socket file left by a crash is removed at startup after a failed liveness connect.
2. **Authenticated.** The first message must be `hello`, within **2 s**. The app compares the
   token in constant time and compares the protocol version for equality. A failure is
   answered with a JSON-RPC error and the connection closes; the app logs the attempt with
   no token material and delays further accepts from a failing peer by 1 s.
3. **Registered** (`role: "server"`). The app assigns a `session_ref` and returns it. The
   connection then carries handoff traffic until EOF, `session.bye`, `app.shutdown` or a
   protocol violation.
4. **Hook served** (`role: "hook"`). The app answers one `hook.stop` and the connection
   closes. No session is registered, so the `hello` result carries `session_ref: null`.

A server whose connection drops keeps retrying with backoff (1, 2, 5, 10, then 30 s
forever); calls degrade to text mode meanwhile, and pending calls re-attach with
`handoff.resume` once the channel is back.

## Authentication and threat model

Authentication is a **per-installation token**: 32 random bytes stored as 64 lowercase hex
characters in `~/.handoff/channel.token`, written by the installer with user-only
permissions and read by both peers at every connection attempt, so a regenerated token is
picked up without a restart. There are no per-session tokens: they add nothing and leak into
configuration files.

The threat model is declared, verbatim from the requirements (SRV-08):

> The token protects against other users of the same machine and against accidental
> connections. It does not protect against a malicious process already running as the same
> user; that is the operating system's boundary.

The app does not verify server identity beyond the token: the server is open by design, and
the user controls what is registered in their agent. Any server presenting the token and the
right protocol version is served, including one installed from npm.

Beyond the token: OS permissions on the endpoint, the message size cap, schema validation of
every message, no dynamic evaluation of anything received, and a 10 s request timeout for
non-blocking requests. Blocking waits are not requests — an outcome arrives as a
notification — so they have no timeout.

## Versioning

`protocol_version` must be **equal** on both sides; there is no negotiation and no support
for older versions. Both binaries ship from one release, so a mismatch means an
npm-installed server or a stale app, and text mode is the correct degraded state for both.

On mismatch the app answers `protocol_unsupported` carrying its own version and closes. The
server logs it, keeps retrying every 5 minutes in case the app is updated, and serves every
call in text mode with an instruction to update the app, which bundles the matching server.

Because of that answer, the schema accepts **any** positive integer as the
`protocol_version` of a `hello`: a peer speaking version 2 must still parse well enough to
be told to update, instead of being dropped as a framing error. Everywhere else — the
`hello` result, the `protocol_unsupported` payload — the version is pinned to the constant
this schema defines.

## Methods and notifications

Requests carry `id`; notifications do not. `→` is server to app, `←` is app to server.

| Direction | Method                | Kind         | Params                                                                                                                                    | Result                                       |
| --------- | --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| →         | `hello`               | request      | `protocol_version, token, role, server_version, identity, agent_id, client, capability_row`; for hooks `hook` instead of the agent fields | `app_version, protocol_version, session_ref` |
| →         | `handoff.open`        | request      | `call_id, spec, secret_treated[], request_id?`                                                                                            | `handoff_id, resumed_from`                   |
| →         | `handoff.continue`    | request      | `call_id, handoff_id, reply, replacement_steps?`                                                                                          | `ok: true`                                   |
| →         | `handoff.resume`      | request      | `call_id, handoff_id, session_ref?`                                                                                                       | `state, outcome?, resumed_from?`             |
| →         | `handoff.verify`      | request      | `handoff_id, verify {ok, detail}`                                                                                                         | `outcome`                                    |
| →         | `handoff.detach_call` | notification | `handoff_id, call_id, reason`                                                                                                             | —                                            |
| →         | `hook.stop`           | request      | none                                                                                                                                      | `block, reason?`                             |
| →         | `session.bye`         | notification | none                                                                                                                                      | —                                            |
| ←         | `handoff.event`       | notification | `call_id, handoff_id, outcome, image?`                                                                                                    | —                                            |
| ←         | `app.shutdown`        | notification | `reason`                                                                                                                                  | —                                            |
| ↔         | `ping`                | request      | none                                                                                                                                      | `{}`                                         |

`ping` is sent after 30 s of silence; two missed pings mean the connection is dead.

`handoff.event` delivers an outcome to the call that is waiting; the server resolves that
call. `handoff.detach_call` tells the app that a call stopped waiting and why, so a tab can
say "waiting for the agent to resume" instead of pretending the agent is listening; nothing
depends on it, because the app queues outcomes regardless.

Payloads reference the public schemas rather than repeating them: `spec` and
`replacement_steps` point at `handoff-spec.v1.schema.json`, `outcome` and `secret_treated`
at `handoff-outcome.v1.schema.json`. Register all three schemas in the same validator.

`image` is the one payload that is **not** in a public schema. The published outcome is a
closed object and carries no pixels, only `screenshot.image_attached`, so a screenshot the
user sent as an image travels beside its outcome as base64 PNG, on the two messages that
can carry a screenshot outcome: `handoff.event` and the snapshot of `handoff.resume` (a
screenshot queued while no call was attached). It is absent whenever
`screenshot.mode` is not `image`; the server attaches it as the MCP `content[1]` image
block only when the session's `images_in_results` is true, and holds it in memory only for
the duration of that tool result (§6.6, §4.7.4).

## Errors

The `message` field carries the error name; the numeric `code` is its wire form. A malformed
or unknown message is **not** answered with an error object: the connection closes.

| Code     | Name                   | When                                                                        |
| -------- | ---------------------- | --------------------------------------------------------------------------- |
| `-32001` | `auth_failed`          | The token does not match.                                                   |
| `-32002` | `protocol_unsupported` | The versions differ. `data.protocol_version` is the app's.                  |
| `-32010` | `unknown_value_key`    | A continue names a value the spec does not declare. `data.keys` lists them. |
| `-32011` | `not_waiting`          | A reply with no pending question and no `replacement_steps`.                |
| `-32012` | `final`                | `replacement_steps` on a handoff that is closed.                            |
| `-32013` | `no_verify_in_spec`    | `handoff.verify` on a spec without `verify`.                                |
| `-32014` | `not_found`            | Unknown `handoff_id`.                                                       |

`-32001` and `-32002` are the two codes the design fixes; the numbers of the five
application errors are chosen here, inside the JSON-RPC range reserved for implementation
errors, and are part of this protocol version.

## Timeouts

| What                                  | Budget                                   |
| ------------------------------------- | ---------------------------------------- |
| `hello` after the socket is accepted  | 2 s                                      |
| A non-blocking request                | 10 s                                     |
| `ping`                                | every 30 s of silence, two missed → dead |
| The hook: connect / total / hard exit | 500 ms / 1 800 ms / 1 950 ms             |

## Reading the schema

A whole line validates against `channel.v1.schema.json`. The top-level `oneOf` separates
requests, notifications, responses and error responses; inside each group the branches are
discriminated by `method`, and the two `hello` shapes by `role`. A response carries no
method, so it is identified by the shape of its `result`; the seven results are mutually
exclusive by their required fields.

Objects are closed: unknown fields are rejected everywhere. That is the schema's contract,
and the app enforces it on every incoming message. The **server** is deliberately more
tolerant at runtime and ignores unknown fields it receives in a result, so that a patch
release of the app does not break a stale server needlessly.

Details worth knowing before writing a codec:

- **`identity`** carries `pid`, `ppid`, `ancestors[]`, `cwd`, and `project_dir` for a server.
  A hook sends no `project_dir`. `ancestors` is best effort: on macOS the peer walks its own
  chain, on Windows it sends an empty list, because spawning PowerShell would cost more than
  the hook's entire budget. The one exception is a server an editor may have started
  (`VSCODE_PID` in its environment), which walks its chain on Windows too, once, with one
  PowerShell query: its session identity is read from the names in that chain. The app
  resolves the full chain itself from its native process table and uses the union, so
  nothing is lost. For a server the editor started, `project_dir` is the editor's workspace
  folder, not its working directory, which Cursor's editor and VS Code both set to the user's
  home folder: the first folder of `WORKSPACE_FOLDER_PATHS` where the editor sets it (Cursor),
  else the first `file:` root the editor's MCP client lists (VS Code), which the server asks
  for between the handshake and `hello`. A window with no folder open has neither, and its
  `project_dir` is then the working directory.
- **`capability_row`** is the row the server already resolved for this session. The app
  adapts its UI to it — hiding "Send image" when `images_in_results` is false — and owns no
  agent facts of its own. The five required fields are the ones the design's example sends;
  the optional ones are the remaining columns of the capability table. `session_identity` is
  the one optional field that is resolved per session rather than per agent, and it travels
  only as `ancestor_chain:editor`, for a session the editor itself started: the app keys such
  a session on the editor in its chain and on its workspace folder, not on the server's
  parent. A `capability_row` without it is keyed on the parent.
- **`hook.agent_id` and `hook.agent_type`** are the agent's own `SubagentStop` fields, and
  have nothing to do with the capability table's `agent_id`. `transcript_path`, which the
  agent also writes on the hook's stdin, is deliberately not forwarded.
- **`session_ref` in `handoff.resume`** is optional. The methods table does not list it and
  the calls section does; the connection already identifies the session, so a peer may send
  it and the app may ignore it.
- **`params` is always present**, as `{}` when a method takes none.
- **Ids** are positive integers, increasing per connection and per peer, so the two peers may
  reuse the same numbers in opposite directions. Strings are accepted for JSON-RPC
  conformance.

## Golden sequences

`../../fixtures/channel/*.jsonl` holds one file per flow. Each line is
`{"dir": "→"|"←", "msg": {...}}`, with the direction of the table above. They are replayed
by both test doubles — `test/fake-app/` here and `tests/fake-server` in the app — so the
fakes cannot drift from the real peers, and `test/contract/channel.test.ts` checks that
every line validates, that every method appears, and that the sequences are internally
consistent: an answer answers a request that was sent, a `call_id` belongs to a call that was
opened or resumed, and one flow file concerns one handoff.

| File                          | Flow                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `f01-register.jsonl`          | Session start, registration, keep-alive in both directions, the app quitting |
| `f02-happy-path.jsonl`        | Agent-opened handoff, done, verified                                         |
| `f04-ask-reply.jsonl`         | A question and a screenshot, each answered with a reply                      |
| `f05-defer-park.jsonl`        | Deferred, resumed, deferred again and parked                                 |
| `f06-heartbeat-resume.jsonl`  | The call detaches at the heartbeat and the agent resumes                     |
| `f07-user-request.jsonl`      | A user-opened request: the handoff takes the request id                      |
| `f08-failed-correction.jsonl` | Failed verification, replacement steps, verified in round 2                  |
| `f10-hook-block.jsonl`        | A Stop hook connects and is told to block                                    |
| `f11-transfer.jsonl`          | Cancellation, transfer to another session, late verification accepted        |
| `auth-failed.jsonl`           | A `hello` with the wrong token                                               |
| `protocol-mismatch.jsonl`     | A `hello` with another protocol version                                      |

Each sequence except `f01`, `f10` and the two refusals begins after a successful
registration. Every golden `handoff.open` reports an empty `secret_treated`; the non-empty
shape, the neutral hook answer and the five application errors are asserted directly in the
contract test rather than written into a flow that does not produce them.
