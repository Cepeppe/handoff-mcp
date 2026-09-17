# `fake-app` — the scripted channel listener

An open implementation of the **app's** half of the internal channel (`TECHNICAL-DESIGN`
§11.3), for the server's own integration tests. It listens on the real endpoint — a named
pipe on Windows, a Unix socket elsewhere — validates every line against
`protocol/channel/channel.v1.schema.json`, records everything it receives, and answers from
a **scenario**.

Its counterpart on the other side is `handoff-app/tests/fake-server`, a channel client that
plays the server's part against the real app. Both doubles replay the same golden sequences
in `fixtures/channel/`, which is what keeps either fake from drifting away from the peer it
imitates.

```ts
import { FakeApp, loadScenario } from '../fake-app';

const app = await FakeApp.start({ scenario: loadScenario('f02-happy-path') });
// `app.env` carries HANDOFF_HOME: give it to the peer so both derive the same endpoint,
// and the token is already in `<HANDOFF_HOME>/channel.token` for it to read.
await app.waitFor(() => app.sessions.length === 1, 5_000, 'a registration');
…
await app.stop(); // stops listening, drops every connection, removes the temporary folder
```

`FakeApp.start()` creates a private `HANDOFF_HOME` under the temporary folder, so a test can
never meet the app the owner is actually running (implementation decision 4). Pass `home` to use
your own, `token` to choose the token, `helloTimeoutMs` to shorten the two-second budget of
§6.2, and `refuse` to make every `hello` fail with `auth_failed` or `protocol_unsupported`.

## What it does on its own, without a scenario

- **Framing.** NDJSON, UTF-8, one message per line, `CHANNEL_MAX_MESSAGE_BYTES` (16 MiB).
  A longer line, a line that is not JSON and a line the schema rejects each close the
  connection and land in `violations`. The **raw line** is what gets validated, before
  anything classifies it: the server's decoder is deliberately tolerant (§6.3) and the app
  is not.
- **`hello`.** It must be the first message and it must arrive within two seconds. The token
  is compared in constant time against the token file, the protocol version for equality.
  A failure is answered with `-32001 auth_failed` or `-32002 protocol_unsupported` and the
  connection closes. `role: "server"` is given a `ses_…`; `role: "hook"` is given
  `session_ref: null`, served one `hook.stop` and closed (§6.2).
- **`ping`** in either direction: an incoming one is answered with `{}` immediately.
- **Defaults** for every request a scenario does not script: an open gets a fresh `hf_` id
  (or the `request_id` it carries), a continue gets `{ ok: true }`, a resume gets
  `{ state: "active" }`, a `hook.stop` gets the neutral `{ block: false }`. A `handoff.verify`
  with no rule is answered `not_found` and the gap is recorded in `gaps[]`, because there is
  no sensible outcome to invent.
- **Outgoing lines are validated too**, against the same schema. A double that answers with
  a message the real app could not send teaches the server a protocol that does not exist,
  so such a line is dropped into `violations` instead of going out.

## What a test reads afterwards

| Field                | What it holds                                                             |
| -------------------- | ------------------------------------------------------------------------- |
| `recorded[]`         | Everything received, with the connection and the role it arrived on       |
| `received()`         | The same, as bare messages: the `→` half of a golden sequence             |
| `expectations()`     | The methods received, in the notation `expect` uses                       |
| `sent[]`             | Everything sent: the `←` half                                             |
| `violations[]`       | Lines either side got wrong. A green run leaves this empty                |
| `gaps[]`             | Where the scenario said nothing and a default had to be invented          |
| `sessions[]`         | Every `session_ref` handed out                                            |
| `remaining()`        | The actions the scenario has not reached. Empty means the script finished |
| `goldenComparison()` | `{ actual, expected }`: what was received against the golden's `→` lines  |
| `goldenAnswers()`    | The same for the `←` lines                                                |

`mark()` is for the sequences that "begin after a successful registration" — every file
except `f01`, `f10` and the two refusals. Register, call `mark()`, and the golden comparison
starts where the fixture does.

Both comparisons are **modulo identifiers and timestamps**: every `hf_`, `call_`, `ses_` and
`rb_` value becomes `<hf#1>`, `<call#1>` and so on, numbered by first appearance within that
sequence, JSON-RPC ids become `<id#n>` the same way, and any RFC 3339 instant becomes `<at>`.
So two different ids stay different and an id reused where the golden reuses one stays equal
— which is the property the flows are about. Everything else is compared exactly, key order
apart. A scenario's `ignore` list is the only escape hatch, and it is written down in the
file.

## Writing a scenario

A scenario is a **queue**, and everything follows from that. The head is either

- a **reply rule** — `delayHello`, `onOpen`, `onContinue`, `onResume`, `onVerify`,
  `answerHookStop` — which waits there until a request of its method arrives, or
- an **emission** — `emitEvent`, `sendPing`, `sendAppShutdown`, `dropConnection` — which
  fires `afterMs` after reaching the head and advances, or
- a **barrier**, `awaitMessage`, which waits for one `→` message and then advances.

A request whose method is not the head's is answered with the default above and leaves the
queue alone, so a scenario never has to enumerate traffic it does not care about. Two rules
for the same method in a row are consumed in order, which is how `f08` answers the first
`handoff.verify` with `failed` and the second with `verified`.

### The two forms of a scenario file

**Derived from a golden** — the eleven files in `scenarios/` are all of this kind:

```json
{
  "scenario": "f02-happy-path",
  "flow": "F-02",
  "why": "Agent-opened handoff to verified: the app answers the open, pushes awaiting_verification and answers the verify.",
  "golden": "f02-happy-path.jsonl",
  "expect": ["handoff.open", "handoff.verify"],
  "send": ["onOpen", "emitEvent", "onVerify"]
}
```

The actions are derived from the fixture, so **no payload is ever copied out of it**.
`expect` (the `→` methods, with `(result)` or `(error)` for a response) and `send` (the
action kinds) are written down for a reader, and loading the file compares them against the
derivation: a fixture edited under a scenario fails loudly instead of leaving a fake that
answers last month's protocol. `afterMs` sets the delay of every derived emission, and
`ignore` lists paths — `params.identity` — that belong to whichever peer is driving.

**Hand-written**, for a case no golden carries — this is the form T-020 and T-021 will
mostly use:

```json
{
  "scenario": "unknown-value-key",
  "why": "A continue naming a value the spec never declared.",
  "actions": [
    { "onOpen": { "handoff_id": "hf_7k3m9p2q4r" } },
    { "emitEvent": { "outcome": { "…": "…" } }, "afterMs": 250 },
    { "onContinue": { "error": { "name": "unknown_value_key", "keys": ["endpoint_url"] } } }
  ]
}
```

An action names **exactly one** key of the DSL plus an optional `afterMs`; anything else is
refused when the file loads, so a typo cannot become a scenario that silently does nothing.
`parseScenario(document, name)` builds one from an object, which is the convenient form
inside a test.

### The actions

| Action                                                | Answers / does                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `delayHello { ms }`                                   | The app takes `ms` to answer `hello`                                       |
| `onOpen { handoff_id?, resumed_from?, error? }`       | `handoff.open`. No id means a fresh one; `$request_id` takes the request's |
| `onContinue { error? }`                               | `handoff.continue`, `{ ok: true }` unless an error is given                |
| `onResume { state, outcome?, resumed_from?, error? }` | `handoff.resume`, the snapshot of §5.7                                     |
| `onVerify { outcome, error? }`                        | `handoff.verify`                                                           |
| `answerHookStop { block, reason? }`                   | `hook.stop`; `reason` is required when `block` is true                     |
| `emitEvent { outcome, handoff_id? }`                  | `handoff.event` to the live call of the connection                         |
| `sendPing`                                            | A `ping` request from the app                                              |
| `sendAppShutdown { reason }`                          | The `app.shutdown` notification                                            |
| `dropConnection`                                      | The socket dies with whatever was in flight                                |
| `awaitMessage { expect }`                             | Waits for one `→` message before the queue advances                        |

`error` is one of the five application errors of §6.3 — `unknown_value_key` (with `keys`),
`not_waiting`, `final`, `no_verify_in_spec`, `not_found` — by name; the code comes from
`protocol/channel/README.md`.

The string `$handoff_id`, anywhere inside an outgoing payload, becomes the handoff the
connection is working on, so a scenario derived from a golden works unchanged when a live
peer chooses a different id.

## Two things the scenarios cannot decide

- **`auth-failed` needs a peer with the wrong token.** The refusal is the fake's own
  decision, not a scripted answer, so its scenario has no actions; the test that replays it
  starts the fake with a token the golden's `hello` does not carry.
- **F-03 (runbook safety net) and F-09 (text mode) have no scenario**, because they put
  nothing on the channel: in F-03 the server answers the agent itself, and in F-09 there is
  no app to answer at all. `fixtures/channel/` has no file for them either, and
  `test/contract/channel.test.ts` pins that the folder holds exactly eleven.

## Running it

`test/fake-app/fake-app.test.ts` is the self-test and runs with `pnpm test`. It loads every
scenario, replays every golden over a real socket, drives the fake with the channel client of
`src/channel/client.ts`, and — last in the file — plants a mutation and requires the golden
comparison to fail, because a comparison that has never failed is a comparison nobody has
checked.
