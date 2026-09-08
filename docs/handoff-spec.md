# The handoff spec

A handoff spec is the JSON document an agent writes to describe one unit of human work. It
is the input of `handoff_to_user` and the first of the three public promises: anything can
produce one, and any implementation must accept exactly the documents this schema accepts.

- Schema: [`handoff-spec.v1.schema.json`](../schemas/handoff-spec.v1.schema.json) (JSON
  Schema draft 2020-12)
- Examples: [`fixtures/specs/valid/`](../fixtures/specs/valid/), and one invalid example per
  rule in [`fixtures/specs/invalid/`](../fixtures/specs/invalid/)
- Offline check: `handoff-mcp validate <spec.json>`

## An example

```json
{
  "spec_version": 1,
  "goal": "Register the Stripe webhook for payment events",
  "where": "Stripe Dashboard → Developers → Webhooks",
  "url": "https://dashboard.stripe.com/webhooks",
  "why_human": "Requires access to the production Stripe account.",
  "values": {
    "endpoint_url": "https://api.myapp.example/webhooks/stripe",
    "events": ["checkout.session.completed", "invoice.paid"]
  },
  "secrets": {
    "STRIPE_WEBHOOK_SECRET": ".env"
  },
  "steps": [
    { "text": "Click Add endpoint and paste the endpoint URL.", "values": ["endpoint_url"] },
    {
      "text": "Select the events checkout.session.completed and invoice.paid.",
      "values": ["events"]
    },
    { "text": "Save and copy the signing secret." },
    { "text": "Paste it into .env as STRIPE_WEBHOOK_SECRET." }
  ],
  "verify": "Check that STRIPE_WEBHOOK_SECRET exists in .env without reading its value, then send a test event from the dashboard and verify it reaches /webhooks/stripe with a valid signature.",
  "lang": "en"
}
```

## Fields

Objects are closed at every level except `values` and `secrets`, whose keys you choose. An
unknown field is an error rather than a silently dropped one, because `warnings` for
`warning` should be caught by the validator and not by a puzzled user.

| Field             | Required | Type            | What it is                                                                                                                        |
| ----------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `spec_version`    | yes      | integer         | `1`. Checked before the schema, so a future version gets one clear answer instead of a list of unknown fields.                    |
| `goal`            | yes      | string          | What the person is achieving, in their words, not yours.                                                                          |
| `where`           | yes      | string          | The place the work happens: a dashboard path, a settings pane, a physical thing.                                                  |
| `url`             | no       | string          | A link that opens that place, if one exists.                                                                                      |
| `why_human`       | yes      | string          | Why you cannot do it yourself. The user reads this to decide whether to trust the request.                                        |
| `values`          | yes      | object          | Every value the person must type or paste, taken from the project. May be `{}`.                                                   |
| `secrets`         | no       | object          | Variable name → destination file, for values the person will copy _from_ the place they are working in. Names only; never values. |
| `steps`           | yes      | array of object | The steps, shown one at a time.                                                                                                   |
| `steps[].text`    | yes      | string          | One action. Not a paragraph of alternatives.                                                                                      |
| `steps[].url`     | no       | string          | A link for that step alone.                                                                                                       |
| `steps[].values`  | no       | array of string | Which of the top-level `values` this step needs; they are shown next to it.                                                       |
| `steps[].warning` | no       | string          | Something irreversible or surprising about this step.                                                                             |
| `verify`          | no       | string          | What _you_ will check afterwards, with your own tools. Its presence is what makes a handoff verifiable.                           |
| `lang`            | no       | string          | BCP-47 tag of the language the texts are written in.                                                                              |

### Limits

The overlay that shows a spec is a narrow panel and error messages have to stay readable, so
every string and every collection is bounded. The limits are generous for real handoffs; the
alternative — none — turns a 200-step spec or a 50 KB step text into a broken panel.

| Path                 | Limit                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| `goal`, `where`      | 1–300 characters                                                                |
| `why_human`          | 1–1000                                                                          |
| `url`, `steps[].url` | ≤ 2048, scheme in `http`, `https`, `ms-settings:`, `x-apple.systempreferences:` |
| `values`             | ≤ 50 keys; key `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`                                |
| `values[*]`          | a string ≤ 4096, or an array of 1–100 strings of ≤ 4096                         |
| `secrets`            | ≤ 20 keys; name 1–128; destination file 1–1024                                  |
| `steps`              | 1–50 objects (never strings)                                                    |
| `steps[].text`       | 1–2000                                                                          |
| `steps[].values`     | 1–20 names, each declared in `values` (omit the field rather than send `[]`)    |
| `steps[].warning`    | 1–300                                                                           |
| `verify`             | 1–4000                                                                          |
| `lang`               | BCP-47 shape `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`                                 |

## The rules the schema cannot express

These run after the schema, produce the same [`SPEC_INVALID`](errors.md) error, and each has
a fixture of its own in [`fixtures/specs/invalid/`](../fixtures/specs/invalid/) marked
`"schema_valid": true`.

| Rule | What it checks                                                                                                                    | Why                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1   | `spec_version` is not higher than this server supports                                                                            | Answered as `SPEC_VERSION_UNSUPPORTED`, before the schema runs                              |
| S2   | The control fields `handoff_id`, `resume`, `request_id`, `reply`, `replacement_steps`, `ignore_runbook` are **not** inside `spec` | They belong at the top level of the tool input; nested, they would silently do nothing      |
| S3   | Every name in `steps[].values` is a key of the top-level `values`                                                                 | A step that cites an undeclared value shows the user a blank                                |
| S4   | No `{{placeholder}}` anywhere                                                                                                     | Placeholders exist only in runbooks; one left in a spec means an unfilled recipe            |
| S5   | The URL scheme is one of the four allowed                                                                                         | Anything else is shown as plain text in the step rather than opened                         |
| S6   | No string is empty once trimmed                                                                                                   | The schema bounds the raw length; this rejects `"   "` and the empty values of a draft spec |
| S7   | The certain-secret scan                                                                                                           | Never an error: it produces `secret_treated` (below)                                        |

Every problem is reported at once, each with the path of the offending location, what is
wrong there and what to change — `goal`, `steps[0].text`, `values.endpoint_url`,
`steps[0].values[0]`. Paths are indexed from 0, like the document; the 1-based numbers a
person sees are the step counter of the overlay. Errors never quote the contents of a spec,
because a value may have been treated as a secret.

## Values, and values that look like secrets

`values` is what the person will type or paste _into_ the place they are working in: an
endpoint URL, a project id, a list of event names. `secrets` is the other direction — the
variable names they will copy _out_ of that place and where those belong — and it carries
names and destinations only, never a value.

Before a spec goes anywhere, every value and every text field is scanned with the public
[certain-secret patterns](../patterns/certain-secrets.v1.json). A match is not an error: the
matched span is masked, and the outcome reports it in `secret_treated` as
`{ "location": "values.api_key", "kind": "api_key" }`. `kind` is the family — `private_key`,
`api_key`, `token`, `webhook_secret`, `webhook_url`, `jwt` — never the id of the pattern that
matched, so the report does not name the vendor of the secret. `url` and `steps[].url` are
not scanned: they are already confined to three schemes and are meant to be opened.

The masking replaces the matched span, not the field: a step that reads "paste `sk_live_…`
into .env" keeps its instruction and loses only the key. A value that _is_ a secret becomes
the mask alone.

The practical rule for an agent: put a live credential in a spec and it will be masked, which
means the person will not receive it. Reference it by name in `secrets` instead.

## Verification

`verify` is what you will run afterwards. Its presence changes the end of the handoff: with
it, the last "Done" returns `awaiting_verification` and you are expected to report the result
with `handoff_verify`; without it, the handoff ends as `confirmed_by_user`. A handoff is
never recorded as verified on trust — see [the outcome](outcome.md).

Write `verify` so that it can be run without reading anything listed in `secrets`: check that
a variable exists, or that its effect is visible, not what it contains.

## Continuing a handoff

`replacement_steps` — sent alongside `handoff_id` and `reply`, not inside a spec — replaces
the steps that have not been done yet. Each item is a step object, validated with the same
schema and the same rules S3 to S6, with S3 checked against the `values` the handoff already
has. That is the correction path after a failed verification: start the replacement at the
actual error, not at step 1.

## Versions

The server accepts its own `spec_version` and every previous one. A higher one is rejected
with `SPEC_VERSION_UNSUPPORTED` and the advice to update the server or lower the version. See
[Versions and compatibility](versioning.md).
