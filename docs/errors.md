# The error catalogue

An error is an MCP tool result with `isError: true` whose text block carries

```json
{
  "error": {
    "code": "SPEC_INVALID",
    "message": "The handoff spec is not valid.",
    "problems": [
      {
        "path": "steps[0].values[0]",
        "problem": "`endpoint_url` is not a key of values.",
        "fix": "Unknown value key `endpoint_url` in steps[0].values; declare it in `values` or remove it. Known keys: (none)."
      }
    ]
  }
}
```

`code` is machine-readable and from the closed list below. `message` says what went wrong.
`problems` says where, and what to change: one entry per problem, all of them at once, never
the first one only — an agent that has to make five round trips to learn about five typos is
an agent that gives up and does the work itself.

Errors **never contain the contents of a spec**. A value may have been treated as a secret,
and an error message is the last place that should be discovered. They cite paths, field
names, limits and expected shapes only.

An outcome is never an error. `failed`, `abandoned` and `not_verified` are results of the
work, not faults of the call; only the codes below produce `isError: true`.

## The codes

| Code                       | When                                                                  | What to do                                                                                     |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SPEC_INVALID`             | The schema or one of the semantic rules S2–S6 rejected the spec       | Fix the paths in `problems` and call again. Each problem has its own `fix`                     |
| `SPEC_VERSION_UNSUPPORTED` | `spec_version` is higher than this server understands                 | Update the server, or lower `spec_version`                                                     |
| `SHAPE_AMBIGUOUS`          | The call is not exactly one of open, continue and resume              | Send exactly one shape. Nothing else may be combined with them                                 |
| `HANDOFF_NOT_FOUND`        | No handoff has that id                                                | Check the id; they look like `hf_xxxxxxxxxx`. The overlay lists open and orphan handoffs       |
| `HANDOFF_NOT_WAITING`      | A `reply` with no pending question and no `replacement_steps`         | Nobody asked you anything: wait for the outcome, or send `replacement_steps`                   |
| `HANDOFF_FINAL`            | `replacement_steps` on a handoff that is closed                       | Open a new handoff, and only for a different goal                                              |
| `NO_VERIFY_IN_SPEC`        | `handoff_verify` on a handoff whose spec carried no `verify`          | That handoff is confirmed by the user. Put `verify` in the spec if you want to verify it       |
| `APP_DISCONNECTED`         | A continue, a resume or a `handoff_verify` found no overlay listening | Retry in a few seconds with the same `handoff_id`; if it stays unreachable, nothing is running |
| `CHANNEL_AUTH_FAILED`      | The overlay rejected the connection token                             | `~/.handoff/channel.token` does not match the overlay. Reinstall, or repair from its settings  |
| `PROTOCOL_MISMATCH`        | Server and overlay speak different channel protocol versions          | Update the overlay; it bundles the server version that matches it                              |
| `RUNBOOKS_UNREADABLE`      | The runbook folder exists but cannot be read                          | Check the permissions on `~/.handoff/runbooks`                                                 |
| `INTERNAL`                 | Something unexpected                                                  | Retry the call once. If it fails again, the message is what to report                          |

The exact `message` and `fix` sentences are in
[`schemas/tool-contract.v1.md`](../schemas/tool-contract.v1.md), section 5, which is what the
server generates them from.

## Three that are worth understanding

**`APP_DISCONNECTED` is not what an open call gets.** An open call with nothing listening
degrades to [text mode](text-mode.md) instead, and a call that was _already_ blocking when the
connection dropped does not fail either: it waits for the channel and re-attaches. This code
is only for the three non-blocking calls — continue, resume and `handoff_verify` — which have
an existing handoff to talk about and no way to do it. In text mode it is therefore the normal
answer to all three, because no handoff was ever created.

**`SHAPE_AMBIGUOUS` usually means a control field ended up inside the spec.** `handoff_id`,
`resume`, `request_id`, `reply`, `replacement_steps` and `ignore_runbook` belong at the top
level of the tool input, beside `spec`, never within it. Nested there they would be silently
ignored, so rule S2 catches them and says so.

**`CHANNEL_AUTH_FAILED` and `PROTOCOL_MISMATCH` do not stop the handoff.** Both come back
from a blocking open as a `text_mode` outcome — the work still happens, in the chat — with the
sentence above added as a second text block of the tool result, so the reason reaches you
without changing what the outcome means.

## Reading `problems`

`path` is the location in the document you sent, written the way the document is indexed:
`goal`, `steps[0].text`, `values.endpoint_url`, `steps[0].values[0]`. It is 0-based, like
JSON. The 1-based numbers a person sees — "step 2 of 4" — are the overlay's counter and live
in `current_step.index`; they are not the same numbering, and mixing them up is the usual
cause of a fix applied to the wrong step.

A missing required field is reported at the path of the field that is absent; an unknown field
at the path of the unknown field, because `warnings` for `warning` has to be findable.

## Offline

`handoff-mcp validate <spec.json>` prints exactly the same object and exits 1, so a spec can
be checked with no agent and no overlay:

```console
$ handoff-mcp validate spec.json
{
  "error": {
    "code": "SPEC_INVALID",
    …
  }
}
```

Exit 0 on a valid spec with a one-line summary, 1 on an invalid one, 2 when the file cannot
be read. [`fixtures/specs/invalid/`](../fixtures/specs/invalid/) holds one example per rule,
each paired with a `.expected.json` naming the code and the exact path — which is also the
parity suite any second implementation is checked against.
