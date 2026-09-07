# Tool contract v1

The three MCP tools of `handoff-mcp`, their input schemas, the exact texts the server sends
back to an agent, and the error catalogue.

This document is **normative and machine-read**. `build/gen-contract.mjs` parses the blocks
and tables below and writes `src/mcp/generated/contract.ts`; the server imports the texts
from there and never spells them out in code, so a description in this file and the
description an agent sees cannot drift. `pnpm gen` regenerates the file, `pnpm build` runs
the generator first, and `test/unit/contract-gen.test.ts` fails the build when the committed
file is not what this document produces.

The server is published as the npm package `baton-handoff-mcp` and installed as the
executable `handoff-mcp`; agents run it as a stdio MCP server (`npx baton-handoff-mcp`).
Tool names, the shared folder `~/.handoff/` and the field names below are concept-bound and
final. Every text here is English only: it is read by agents, not by users, whatever the
`lang` of the spec.

## How this document is machine-read

| Construct                               | Meaning                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| ` ```json tool-input <tool> `           | The JSON Schema registered with MCP as that tool's `inputSchema`    |
| ` ```text tool-description <tool> `     | The verbatim description text of that tool                          |
| ` ```json tool-annotations <tool> `     | The MCP tool annotations: `title`, `readOnlyHint`, `openWorldHint`  |
| `<!-- contract-table: instructions -->` | The table right below it carries the per-status `instruction` texts |
| `<!-- contract-table: errors -->`       | The table right below it carries the error catalogue                |

Untagged fenced blocks (plain ` ```json `) are examples and are ignored by the generator.

Four rules make the extraction exact:

- **`$ref` to a schema file is inlined.** Inside a `tool-input` block, `"$ref"` pointing at a
  file next to this one (only `handoff-spec.v1.schema.json` today) is resolved at generation
  time: the referenced schema replaces the object, its `$defs` are hoisted to the root of the
  tool input schema so that internal `#/$defs/...` references keep resolving, and its
  `$schema`, `$id` and `title` are dropped. A `description` written next to the `$ref` wins
  over the one in the referenced file. The registered schema is therefore self-contained, and
  the spec format has exactly one source: `handoff-spec.v1.schema.json`.
- **Table cells are raw strings.** The `instruction`, `message` and `fix` cells are the exact
  bytes the agent receives. They carry no markdown: no backticks, no emphasis, and no `|`,
  which would end the cell. That is why field names appear bare in them.
- **`<id>` is the only placeholder.** The server substitutes it with the `handoff_id` of the
  outcome before returning. Statuses whose outcome has `handoff_id: null` (`runbook_match`
  and `text_mode`) carry no `<id>`.
- **Two instruction variants.** Statuses that mention the Stop hook have one row per variant:
  `stop_hook` when the session's capability row has `stop_hook: true`, `no_stop_hook`
  otherwise. `both` means the single text is used either way.

---

## 1. `handoff_to_user`

One blocking tool that opens a handoff, continues it, or re-attaches to it. **One flat input
object**: the server infers which of the three shapes was meant from the fields present, and
rejects any other combination with `SHAPE_AMBIGUOUS`. A top-level `oneOf` would express the
three shapes better, but several agent runtimes flatten or mishandle `oneOf` in tool schemas,
so the shapes are spelled out in the description instead.

Shape inference: exactly one of `spec`, `reply` (with `handoff_id`) or `resume` must be
present. A continue on a handoff with no pending question or screenshot is
`HANDOFF_NOT_WAITING`, unless `replacement_steps` is present, which makes it a correction
round (allowed while the handoff is `failed`, `active` or `deferred`). A resume of a handoff
that already reached a final state returns that outcome again with `already_delivered: true`.
A resume of a handoff whose call is attached to another session detaches that call with
`transferred_to_other_session`.

The call returns only when the handoff ends, at the first event that needs the agent, at the
heartbeat, on transfer, or on error.

### Input schema

```json tool-input handoff_to_user
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "spec": {
      "description": "Open shape. The handoff spec to hand to the user. Control fields never go inside it.",
      "$ref": "handoff-spec.v1.schema.json"
    },
    "request_id": {
      "description": "Open shape, optional. The id of a request the user opened from the overlay; the new handoff takes that id.",
      "type": "string",
      "pattern": "^hf_[0-9a-hjkmnp-tv-z]{10}$"
    },
    "ignore_runbook": {
      "description": "Open shape, optional. Skip the runbook safety net. Set it once you have seen a runbook_match result and decided.",
      "type": "boolean"
    },
    "handoff_id": {
      "description": "Continue shape. The handoff this reply belongs to.",
      "type": "string",
      "pattern": "^hf_[0-9a-hjkmnp-tv-z]{10}$"
    },
    "reply": {
      "description": "Continue shape. Your answer to the user's question or screenshot, shown on the current step.",
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "replacement_steps": {
      "description": "Continue shape, optional. Replaces the steps that remain and opens a correction round. Validated like the spec's steps, including the rule that every name listed in a step's values must be a key of the handoff's values.",
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": { "$ref": "handoff-spec.v1.schema.json#/$defs/step" }
    },
    "resume": {
      "description": "Resume shape. Re-attach to an existing handoff, from any session of this installation.",
      "type": "string",
      "pattern": "^hf_[0-9a-hjkmnp-tv-z]{10}$"
    }
  }
}
```

### Description

```text tool-description handoff_to_user
Hands a human step to the user through the local overlay and waits until the user finishes it or needs you. Use it when a step must be done by a person: credentials, OAuth apps, DNS, IAM, billing, confirmations, OS or application settings.
Before writing a spec, call `handoff_runbooks(where, goal)` and start from a matching runbook if one exists.
Three ways to call it. (1) Open: `{ "spec": {...}, "request_id"?: "hf_…", "ignore_runbook"?: true }`, where `spec` follows handoff-spec v1: `spec_version` 1, `goal`, `where`, optional `url` (http, https, ms-settings:, x-apple.systempreferences: only), `why_human`, `values` (name → string or list; every value the user must type or paste, taken from the project), optional `secrets` (variable name → destination file, for values the user copies from the dashboard; never their values), `steps` (objects `{ text, url?, values?, warning? }`, shown one at a time), optional `verify`, optional `lang`. (2) Continue: `{ "handoff_id", "reply", "replacement_steps"? }` to answer a question or a screenshot on the current step; `replacement_steps` replaces the remaining steps. (3) Resume: `{ "resume": "hf_…" }` to re-attach after an interrupted call, from any session; a resume of a finished handoff returns its outcome again with `already_delivered: true`.
The call blocks while the user works and returns an outcome JSON with `status`, `final` and `instruction`. Follow `instruction`. `in_progress` means call again with `resume` at once. `deferred` means continue other work and call `resume` before you finish your turn. `parked` means the user will resume it; mention the id in your final summary. `awaiting_verification` means run the verification yourself and report it with `handoff_verify`.
Rules. Never read the values listed in `secrets`; verify only their presence or their effect. Do not open a second handoff for the same goal; continue the same one. If a call fails because the server was disconnected, reconnect the server (for example `/mcp reconnect handoff`) and call `resume` with the same id. If the overlay app is not running the result is `status: text_mode`: present the spec in chat, guide the user step by step and collect the result in chat; in that mode nothing is logged and no verified state exists.
Errors come back as `{ "error": { "code", "message", "problems": [{ "path", "problem", "fix" }] } }`; fix the named field and call again.
```

### Annotations

```json tool-annotations handoff_to_user
{
  "title": "Hand a step off to the user",
  "readOnlyHint": false,
  "openWorldHint": false
}
```

---

## 2. `handoff_verify`

Reports the verification the agent performed after the user finished the steps. A handoff
reaches `verified` or `failed` only through this call. A report for a handoff whose spec
carried no `verify` is rejected with `NO_VERIFY_IN_SPEC`: such a handoff is already confirmed
by the user. A report that arrives after the handoff became `not_verified` by timeout or
disconnect is still accepted while the handoff is younger than seven days, re-finalises it,
and is logged as late.

### Input schema

```json tool-input handoff_verify
{
  "type": "object",
  "additionalProperties": false,
  "required": ["handoff_id", "verify"],
  "properties": {
    "handoff_id": {
      "description": "The handoff you verified.",
      "type": "string",
      "pattern": "^hf_[0-9a-hjkmnp-tv-z]{10}$"
    },
    "verify": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ok", "detail"],
      "properties": {
        "ok": {
          "description": "true if the check passed, false if it failed, null if you could not verify.",
          "type": ["boolean", "null"]
        },
        "detail": {
          "description": "Exactly what you ran and what you observed, or why you could not verify. Never quote a value listed in the spec's secrets.",
          "type": "string",
          "minLength": 1,
          "maxLength": 4000
        }
      }
    }
  }
}
```

### Description

```text tool-description handoff_verify
Reports the result of the verification you performed after the user finished a handoff. `ok: true` if the check passed, `false` if it failed, `null` if you could not verify; `detail` says exactly what you ran and what you observed, or why you could not verify. Never invent a result: `null` with an honest reason is recorded as "not verified", which is better than a false pass. Never read values listed in the spec's `secrets`; check presence or effect only. On `false` you may correct the handoff by calling `handoff_to_user` with the same `handoff_id` and `replacement_steps` that start from the actual error. A late report for a handoff that timed out is accepted.
```

### Annotations

```json tool-annotations handoff_verify
{
  "title": "Report the verification of a handoff",
  "readOnlyHint": false,
  "openWorldHint": false
}
```

---

## 3. `handoff_runbooks`

Searches the runbooks the overlay saved in `~/.handoff/runbooks/`. Read-only: it opens
nothing and changes nothing. It returns `{ "runbooks": [ … ] }` with the fields the
`runbooks` array of an outcome carries, including a `draft_spec` and its `values_to_fill`.

### Input schema

```json tool-input handoff_runbooks
{
  "type": "object",
  "additionalProperties": false,
  "required": ["where", "goal"],
  "properties": {
    "where": {
      "description": "Where the work happens: the service, application or settings panel, as you would write it in a spec.",
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "goal": {
      "description": "What must be achieved, as you would write it in a spec. Words shared with a saved runbook are what matches.",
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "lang": {
      "description": "Optional BCP-47 tag of the language you wrote where and goal in.",
      "type": "string",
      "pattern": "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$"
    }
  }
}
```

### Description

```text tool-description handoff_runbooks
Searches the user's saved runbooks in `~/.handoff/runbooks/` for a previous verified execution of the same kind of step: same `where` (normalised) and shared words in `goal`. Call it before writing a handoff spec. Each result carries `trust` (verified or confirmed_by_user), `last_verified_at` so you can weigh freshness, `last_run_failed_at`, the executed steps with their annotations, a `draft_spec` and `values_to_fill`. Fill the values from the current project and pass the completed spec to `handoff_to_user` with `ignore_runbook: true`.
```

### Annotations

```json tool-annotations handoff_runbooks
{
  "title": "Search saved runbooks",
  "readOnlyHint": true,
  "openWorldHint": false
}
```

---

## 4. Statuses and instruction texts

Every outcome carries `status`, `final` and `instruction`. `status` is one enumeration over
the final states of a handoff and the reasons a blocking call came back, so an agent branches
on one field. `instruction` is the fallback that has to hold when hooks, a raised tool
timeout or images in results are not available: an agent that only reads `instruction` still
behaves correctly.

The `status` column below is exactly the `status` enum of `handoff-outcome.v1.schema.json`;
the generator fails if the two ever differ.

<!-- contract-table: instructions -->

| status                       | final | variant      | instruction                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in_progress                  | no    | both         | The user is still working on this handoff. This is not the end of it: call handoff_to_user again now with {"resume": "<id>"} to keep waiting.                                                                                                                                                                                                                          |
| question                     | no    | both         | The user asked a question on the current step. Answer it: call handoff_to_user with {"handoff_id": "<id>", "reply": "your answer"}. Add replacement_steps only if the remaining steps must change.                                                                                                                                                                     |
| screenshot                   | no    | both         | The user sent what they see at the current step, as an image or as extracted text. Answer on this step: call handoff_to_user with {"handoff_id": "<id>", "reply": "your answer"}. Add replacement_steps only if the remaining steps must change.                                                                                                                       |
| deferred                     | no    | stop_hook    | The user deferred this step. Park it, continue work that does not depend on it, then call handoff_to_user with {"resume": "<id>"} before you conclude your turn. The Stop hook will stop you once if you forget.                                                                                                                                                       |
| deferred                     | no    | no_stop_hook | The user deferred this step. Park it, continue work that does not depend on it, then call handoff_to_user with {"resume": "<id>"} before you conclude your turn. Nothing will remind you: keep <id> in your notes for this turn.                                                                                                                                       |
| parked                       | no    | stop_hook    | The user deferred this step twice. Do not resume it now: it stays in the overlay until the user picks it up. Mention <id> as still pending in your final summary. The Stop hook will stop you once if you forget.                                                                                                                                                      |
| parked                       | no    | no_stop_hook | The user deferred this step twice. Do not resume it now: it stays in the overlay until the user picks it up. Mention <id> as still pending in your final summary. Nothing will remind you: keep <id> in your notes for this turn.                                                                                                                                      |
| awaiting_verification        | no    | both         | The user finished the steps and the spec asked for a verification. Perform it yourself with your own tools, then report it: call handoff_verify with handoff_id <id>, verify.ok set to true, false or null, and a verify.detail saying exactly what you ran and what you observed. Never read the values listed in secrets: check their presence or their effect only. |
| confirmed_by_user            | yes   | both         | The handoff is complete and recorded as confirmed by the user. Nothing further is expected for <id>.                                                                                                                                                                                                                                                                   |
| verified                     | yes   | both         | Recorded as verified, and a runbook was saved so the next run of this work can start from it. Nothing further is expected for <id>.                                                                                                                                                                                                                                    |
| failed                       | yes   | both         | The verification failed. If you can correct it, call handoff_to_user with handoff_id <id> and replacement_steps that start from the actual error; otherwise tell the user what went wrong and stop.                                                                                                                                                                    |
| not_verified                 | yes   | both         | Recorded as not verified. If you can still verify it, call handoff_verify with handoff_id <id>: a late report is accepted for seven days and is recorded as late.                                                                                                                                                                                                      |
| abandoned                    | yes   | both         | The user abandoned handoff <id>. Do not retry the same steps and do not open a new handoff for the same goal: ask the user how they want to proceed.                                                                                                                                                                                                                   |
| transferred_to_other_session | no    | both         | Another session took over handoff <id> and now receives its outcome. Do nothing further with it.                                                                                                                                                                                                                                                                       |
| runbook_match                | no    | both         | No handoff was opened. A saved runbook already covers this kind of work: start from it. Fill values_to_fill from the current project and call handoff_to_user again with the completed spec and ignore_runbook set to true. If none of the runbooks fits, call again with your own spec and the same flag.                                                             |
| text_mode                    | no    | both         | The overlay app is not running. Present the spec in spec_text to the user in chat, walk them through the steps one at a time, and collect the result in chat. Nothing is logged and no verified state exists in this mode: there is no handoff to resume and no verification to report.                                                                                |

### Text mode

`text_mode` is the degraded path, and the only one where the server answers without the
overlay: `handoff_id` is null, `app_reachable` is false, and `spec_text` carries the spec
rendered as Markdown, values masked where the certain detector matched. Nothing is persisted,
so there is nothing to resume and nothing to verify — which is exactly what the instruction
tells the agent, because in this mode the instruction is all the agent has.

### The Stop hook variants

`deferred` and `parked` ask the agent to come back to a handoff later. When the session's
capability row says the agent supports a Stop hook, the server writes the variant that names
it, because the hook really will stop the agent once and remind it. When it does not, the
text says so plainly rather than promising a safety net that is not there.

---

## 5. Error catalogue

An error is an MCP tool result with `isError: true` whose text block is
`{ "error": { "code", "message", "problems": [{ "path", "problem", "fix" }] } }`. `message`
is the sentence below; `fix` is the sentence below repeated on each problem, except for
`SPEC_INVALID`, whose fix is written per problem by the validator (a missing field, a broken
limit and a bad URL scheme each get their own). Errors never contain spec values, which may
have been treated as secrets: they cite paths and expected shapes only.

<!-- contract-table: errors -->

| code                     | message                                                           | fix                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SPEC_INVALID             | The handoff spec is not valid.                                    | (per problem)                                                                                                                                 |
| SPEC_VERSION_UNSUPPORTED | This server does not support that spec_version.                   | Update the server or lower spec_version.                                                                                                      |
| SHAPE_AMBIGUOUS          | The call does not match exactly one of the three shapes.          | Send exactly one shape: open with spec, continue with handoff_id and reply, or resume with resume. Nothing else may be combined with them.    |
| HANDOFF_NOT_FOUND        | No handoff exists with that id.                                   | Check the id; ids look like hf_xxxxxxxxxx. The overlay lists open and orphan handoffs.                                                        |
| HANDOFF_NOT_WAITING      | That handoff is not waiting for a reply.                          | The user has not asked anything; wait for the outcome or send replacement_steps.                                                              |
| HANDOFF_FINAL            | That handoff has already reached a final state.                   | This handoff is closed; open a new one only for a different goal.                                                                             |
| NO_VERIFY_IN_SPEC        | That handoff's spec carries no verify.                            | This handoff is confirmed by the user; include verify in the spec if you want to verify.                                                      |
| APP_DISCONNECTED         | The overlay app is not reachable.                                 | The overlay app is not reachable right now. Retry in a few seconds with the same handoff_id; if it stays unreachable, the app is not running. |
| CHANNEL_AUTH_FAILED      | The overlay app rejected the connection token.                    | The token file ~/.handoff/channel.token does not match the app. Reinstall or repair from the app settings.                                    |
| PROTOCOL_MISMATCH        | The server and the app speak different channel protocol versions. | Server and app versions do not match. Update the app (it bundles the matching server).                                                        |
| RUNBOOKS_UNREADABLE      | The runbooks folder could not be read.                            | Check permissions on ~/.handoff/runbooks.                                                                                                     |
| INTERNAL                 | The server hit an unexpected error.                               | Retry the same call once. If it fails again, the message above is what to report.                                                             |

`APP_DISCONNECTED` is returned only for the non-blocking calls — continue, resume and
`handoff_verify`. An opening call does not fail when the app is unreachable: it degrades to
`text_mode`, and a call already blocking waits for the channel to come back and re-attaches.

---

## 6. How an outcome is returned over MCP

`handoff_to_user` and `handoff_verify` both return an outcome validated against
`handoff-outcome.v1.schema.json`, mapped onto an MCP tool result like this:

- `content[0]` is a text block carrying the outcome JSON. Every client can read it, which is
  why it is always present.
- `content[1]` is an image block (`image/png`, base64) — but only when
  `screenshot.mode` is `"image"` **and** the session's capability row has
  `images_in_results: true`. When the client cannot show images the user is offered the text
  path instead, and the outcome carries the extracted text with `image_attached: false`.
- `structuredContent` carries the same outcome object, and the tool declares its
  `outputSchema`, so clients that implement typed output get the object without parsing the
  text block.

An outcome is never `isError`, whatever its status: `failed`, `abandoned` and `not_verified`
are results, not faults. Only the errors of §5 are `isError`.

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"outcome_version\":1,\"handoff_id\":\"hf_7k3m9p2q4r\",\"status\":\"verified\", …}"
    }
  ],
  "structuredContent": {
    "outcome_version": 1,
    "handoff_id": "hf_7k3m9p2q4r",
    "status": "verified"
  },
  "isError": false
}
```

`handoff_runbooks` returns `{ "runbooks": [ … ] }` the same way: a text block with the JSON
and the same object in `structuredContent`.
