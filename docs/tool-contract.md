# The tool contract

Three MCP tools, and the exact texts an agent reads. The normative document is
[`schemas/tool-contract.v1.md`](../schemas/tool-contract.v1.md): the input schema, the
description and the annotations of each tool, the `instruction` sentence of every outcome
status and the error catalogue. This page is the guided tour of it.

The contract is machine-read. `build/gen-contract.mjs` turns that document into
`src/mcp/generated/contract.ts`, which is what the server actually registers and sends, and a
test regenerates it and compares bytes. The published texts and the texts an agent receives
therefore cannot drift: change the document, run `pnpm gen`, or CI fails.

## `handoff_to_user`

> Hand a step off to the user.

One flat input object, and the server infers which of three calls you meant from the fields
you sent. (A top-level `oneOf` would have been the tidier schema, but several agent runtimes
flatten or mishandle it, and a shape an agent cannot send is worth nothing.)

| Shape        | Send                                                | Meaning                                                            |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| **Open**     | `{ "spec": {…}, "request_id"?, "ignore_runbook"? }` | Start a new handoff from a [spec](handoff-spec.md)                 |
| **Continue** | `{ "handoff_id", "reply", "replacement_steps"? }`   | Answer a question or a screenshot on the current step              |
| **Resume**   | `{ "resume": "hf_…" }`                              | Re-attach to a handoff after an interrupted call, from any session |

Exactly one of `spec`, `reply` (with `handoff_id`) and `resume` may be present; anything else
is [`SHAPE_AMBIGUOUS`](errors.md).

The call **blocks** while the person works. It comes back on the first thing that needs you —
a question, a screenshot, a deferral, the end of the handoff — or at the heartbeat, or when
another session takes the handoff over. Every return is an [outcome](outcome.md).

Two things about it are worth knowing before you write a client:

- **`in_progress` is not the end.** It is the heartbeat: the server returns it shortly before
  your own tool timeout would have cut the call off, so the call ends on our terms with a
  result rather than on yours with a timeout. The instruction tells you to call `resume`
  immediately, and that is a loop you can stay in for as long as the work takes.
- **`resume` is idempotent and safe.** Resuming a finished handoff returns its outcome again
  with `already_delivered: true`. Retrying after a disconnection is therefore never harmful,
  and it is the documented recovery path when the server was restarted under you.

`ignore_runbook` skips the safety net described below. `request_id` links the handoff to a
request the person opened themselves, and the handoff then takes that id, so one thing keeps
one identity from "waiting for a spec" to its final state.

## `handoff_verify`

> Report the verification of a handoff.

Input `{ handoff_id, verify: { ok: true | false | null, detail } }`; returns an
[outcome](outcome.md). `detail` says what you ran and what you observed, or why you could not
check. See [Verification](outcome.md#verification).

## `handoff_runbooks`

> Search saved runbooks.

Input `{ where, goal, lang? }`; returns `{ "runbooks": [ … ] }`. Call it **before** writing a
spec: if the person has already done this work and it was verified, start from what worked
rather than from your guess. Each result carries the executed steps with their annotations, a
`draft_spec` and the `values_to_fill` you have to complete. See
[the runbook format](runbook-format.md).

The tool is read-only and it never fails because of one bad file: an unparseable runbook is
skipped with a warning on stderr.

## The runbook safety net

An open call whose spec matches saved runbooks does **not** open a handoff. It comes back
`runbook_match` with the matches, so the person is not walked through a worse version of
something they have already solved. Fill `values_to_fill`, then call again with the completed
spec and `ignore_runbook: true`.

That is the one place where the server answers an open call by itself, and it is the reason
`handoff_id` may be null in an outcome.

## What the session's capabilities change

The server resolves one capability row per session and adapts three things to it:

- **Images.** An image block accompanies a screenshot outcome only when the client accepts
  images in tool results. Otherwise the person is offered the text path and the extracted text
  arrives in `screenshot.text`.
- **Heartbeat timing.** From the tool timeout the session actually has: the environment
  variable the installer wrote, or the client's own timeout, or the row's default, or 50
  seconds for an unknown client.
- **The `deferred` and `parked` instructions.** When the agent runs an end-of-turn hook, the
  text says the hook will stop it once if it forgets. When it does not, the text says plainly
  that nothing will remind it. A promise of a safety net that is not there would be worse than
  no promise.

Nothing else changes. See [support levels](index.md#support-levels).

## Errors

Errors are MCP tool results with `isError: true` whose text block is
`{ "error": { "code", "message", "problems": [{ "path", "problem", "fix" }] } }`. They cite
paths and expected shapes only, never the contents of a spec. The full list is
[the error catalogue](errors.md).
