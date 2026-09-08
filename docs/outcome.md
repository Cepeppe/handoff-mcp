# The outcome

An outcome is what `handoff_to_user` and `handoff_verify` return. It is the second public
promise: one object, always the same shape, whatever happened.

- Schema: [`handoff-outcome.v1.schema.json`](../schemas/handoff-outcome.v1.schema.json)
- One example per status: [`fixtures/outcomes/`](../fixtures/outcomes/)
- The exact `instruction` text of every status:
  [`tool-contract.v1.md`](../schemas/tool-contract.v1.md), section 4

## Three fields decide everything

`status` says what happened. `final` says whether this handoff is over. `instruction` says,
in English, what to do next.

**Read `instruction` and do what it says.** It is written to be sufficient on its own: an
agent with no end-of-turn hook, no raised tool timeout and no image support still behaves
correctly if it follows the instruction, because the instruction is adapted to what the
session actually supports. Branching on `status` is the efficient path, not the necessary
one.

Every field is always present — `null` or `[]` where it does not apply — so nothing has to
branch on absence.

## The statuses

`status` is one enumeration over both the final states of a handoff and the reasons a
blocking call came back, so there is one field to branch on.

| `status`                       | `final` | Returned when                                                   | What you do                                                                          |
| ------------------------------ | ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `in_progress`                  | no      | The heartbeat, shortly before your tool timeout would have hit  | Call again with `{"resume": "<id>"}` **now**. This is not the end of it.             |
| `question`                     | no      | The person asked something on the current step                  | Answer with `{"handoff_id", "reply"}`                                                |
| `screenshot`                   | no      | The person sent what they see, as an image or as extracted text | Answer the same way; the screenshot is about the current step                        |
| `deferred`                     | no      | The person deferred the step once                               | Do other work, then `resume` before you conclude your turn                           |
| `parked`                       | no      | The person deferred it twice                                    | Do not resume; mention the id as pending in your summary                             |
| `awaiting_verification`        | no      | The last step is done and the spec had a `verify`               | Run the verification yourself, then call `handoff_verify`                            |
| `confirmed_by_user`            | yes     | The last step is done and the spec had no `verify`              | Nothing further                                                                      |
| `verified`                     | yes     | `handoff_verify` with `ok: true`                                | Nothing further; a runbook was saved                                                 |
| `failed`                       | yes     | `handoff_verify` with `ok: false`                               | Correct it with `replacement_steps` starting at the actual error, or tell the person |
| `not_verified`                 | yes     | `ok: null`, or the verification window expired                  | A late report is still accepted for seven days                                       |
| `abandoned`                    | yes     | The person abandoned the handoff                                | Do not retry the same steps; ask how to proceed                                      |
| `transferred_to_other_session` | no      | Another session resumed this handoff                            | Nothing further with it                                                              |
| `runbook_match`                | no      | A new spec matched saved runbooks; **no handoff was opened**    | Fill `values_to_fill` and call again with `ignore_runbook: true`                     |
| `text_mode`                    | no      | No overlay is listening                                         | Present `spec_text` in chat; see [text mode](text-mode.md)                           |

An outcome is never an MCP error, whatever its status: `failed`, `abandoned` and
`not_verified` are results. Only the [error catalogue](errors.md) produces `isError: true`.

`final: true` means this handoff will produce nothing more on its own. It does not always
mean there is nothing left to do: `failed` invites a correction round, and `not_verified`
still accepts a late report.

## The fields

| Field               | Type             | Content                                                                                                                         |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `outcome_version`   | integer          | `1`                                                                                                                             |
| `handoff_id`        | string or null   | `hf_` + 10 characters. Null only for `runbook_match` and `text_mode`, where no handoff exists                                   |
| `status`            | string           | The table above                                                                                                                 |
| `final`             | boolean          | Whether this handoff is over                                                                                                    |
| `instruction`       | string           | What to do next, in English                                                                                                     |
| `round`             | integer ≥ 1      | A failed verification opens round 2 on the same handoff                                                                         |
| `current_step`      | object or null   | `{ index, total, text }`, `index` 1-based, matching the "2 of 4" the person sees                                                |
| `user_text`         | string or null   | The question, the comment sent with a screenshot, or the reason typed with Defer or Abandon                                     |
| `screenshot`        | object or null   | `{ mode, text, image_attached, width, height, redactions, ocr_engine }`                                                         |
| `context`           | object or null   | For `question` and `screenshot`: `{ goal, where, step, step_values }`, so the answer can be written without re-reading the spec |
| `skipped_steps`     | array of integer | 1-based indices skipped in the current round                                                                                    |
| `notes`             | array            | `{ step, text, at }` — what the person wrote down while doing it                                                                |
| `secret_treated`    | array            | `{ location, kind }` for every value the certain patterns matched                                                               |
| `verify`            | object or null   | `{ ok, detail, reported_at, late }` once reported                                                                               |
| `deferral_count`    | integer          | 0, 1 or 2; the second deferral parks the handoff                                                                                |
| `resumed_from`      | object or null   | `{ agent, project }` when the call comes from a different session than the one that opened it                                   |
| `app_reachable`     | boolean          | False only in `text_mode`                                                                                                       |
| `already_delivered` | boolean          | True when a `resume` returns a final outcome you have already been given                                                        |
| `runbooks`          | array            | Only for `runbook_match`; see [the runbook format](runbook-format.md)                                                           |
| `spec_text`         | string or null   | Only for `text_mode`: the spec rendered for the chat                                                                            |

## Screenshots

A screenshot is always the person's decision, never the agent's request, and it always
passes through a preview they have to accept. What arrives here is the result of that.

`screenshot.mode` is `"image"` or `"text"`. In text mode the extracted text is in
`screenshot.text` and `image_attached` is false. In image mode the pixels arrive as a second
MCP content block (`image/png`), and `image_attached` says so — but only when the session's
capability row allows images in tool results. When it does not, the person is offered the
text path instead, so the information still reaches you.

`redactions` is how many regions were painted over before the image left the machine.

## An example

```json
{
  "outcome_version": 1,
  "handoff_id": "hf_7k3m9p2q4r",
  "status": "screenshot",
  "final": false,
  "instruction": "The user sent what they see at the current step, as an image or as extracted text. Answer on this step: call handoff_to_user with {\"handoff_id\": \"hf_7k3m9p2q4r\", \"reply\": \"your answer\"}. Add replacement_steps only if the remaining steps must change.",
  "round": 1,
  "current_step": {
    "index": 2,
    "total": 4,
    "text": "Select the events checkout.session.completed and invoice.paid."
  },
  "user_text": "I only see 'checkout.session.async_payment_succeeded'",
  "screenshot": {
    "mode": "text",
    "text": "Select events to listen to\n[search] checkout\ncheckout.session.async_payment_failed\n…",
    "image_attached": false,
    "width": 2880,
    "height": 1800,
    "redactions": 0,
    "ocr_engine": "vision"
  },
  "context": {
    "goal": "Register the Stripe webhook for payment events",
    "where": "Stripe Dashboard → Developers → Webhooks",
    "step": { "index": 2, "total": 4, "text": "Select the events…", "url": null, "warning": null },
    "step_values": { "events": ["checkout.session.completed", "invoice.paid"] }
  },
  "skipped_steps": [],
  "notes": [
    { "step": 1, "text": "Button is called 'Add destination' now", "at": "2026-09-07T10:12:03Z" }
  ],
  "secret_treated": [],
  "verify": null,
  "deferral_count": 0,
  "resumed_from": null,
  "app_reachable": true,
  "already_delivered": false,
  "runbooks": [],
  "spec_text": null
}
```

## How it arrives over MCP

- `content[0]` is a text block carrying the outcome JSON. Every client can read it, which is
  why it is always there.
- `content[1]` is the image block, when there is one.
- `structuredContent` carries the same object, and the tool declares an `outputSchema`, so a
  client that implements typed output gets the object without parsing the text.

The `outputSchema` the server registers is the published outcome schema with the spec schema
embedded under `$defs`. That matters if you validate outcomes yourself: the file on disk
refers to the spec schema by its absolute `$id` for `runbooks[].draft_spec`, so it does not
compile on its own. Register all three schemas in one validator, or embed as the server does.

## Verification

`handoff_verify` takes `{ handoff_id, verify: { ok, detail } }`.

| `ok`    | The handoff becomes | Also                                           |
| ------- | ------------------- | ---------------------------------------------- |
| `true`  | `verified`          | A runbook is saved or refreshed                |
| `false` | `failed`            | Final, but a correction round is still allowed |
| `null`  | `not_verified`      | The honest answer when you could not check     |

Never invent a result. `null` with a `detail` saying why is recorded as "not verified", which
is a better outcome than a false pass — the whole point of the format is that "verified"
means something. A report that arrives after the handoff timed out is accepted for seven days
and recorded as late.

`handoff_verify` on a handoff whose spec had no `verify` is
[`NO_VERIFY_IN_SPEC`](errors.md): that handoff is confirmed by the user, and an agent that
wants a verification puts `verify` in the spec.
