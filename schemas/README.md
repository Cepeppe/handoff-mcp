# Public schemas

Three JSON Schemas (draft 2020-12), published under MIT with the server. They are a public
promise: any agent can produce a spec against `handoff-spec.v1`, any client can read an
outcome against `handoff-outcome.v1`, and anyone can read the runbook files the app writes
in `~/.handoff/runbooks/` against `handoff-runbook.v1`.

| File                             | Who produces it                                                     | Who reads it                                         |
| -------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `handoff-spec.v1.schema.json`    | The agent, as the input of `handoff_to_user`                        | The server validates it, the overlay shows it        |
| `handoff-outcome.v1.schema.json` | The server, as the result of `handoff_to_user` and `handoff_verify` | The agent branches on `status`; the log stores it    |
| `handoff-runbook.v1.schema.json` | The overlay, one file per saved recipe                              | The server, which converts it back into a draft spec |

Each schema has a stable `$id` under
`https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/schemas/`. The `$id` is an
identifier, not a promise that the document is fetched at runtime: implementations load the
files that ship with the package. The outcome schema references the spec schema by that
`$id` for `runbooks[].draft_spec`, so register all three schemas in the same validator.

## Versions

Every document carries its format version as an integer: `spec_version`, `outcome_version`,
`runbook_version`. The version is bumped when a field is added, removed, or changes meaning,
and it is independent of the npm package version — a server 1.4.0 can still speak
`spec_version` 1.

- **Spec.** The server accepts its own version and every previous one. A higher version is
  rejected with `SPEC_VERSION_UNSUPPORTED` ("update the server or lower spec_version"), and
  that check runs _before_ the schema, so a future spec gets one clear answer instead of a
  list of unknown fields.
- **Outcome.** The server is the only producer; agents read what they get. A bump is
  announced in the tool description.
- **Runbook.** The app writes the current version; the server reads the current and previous
  ones.

## What the schemas do not check

The schema is the structural half of validation. These rules are applied after it, produce
the same `SPEC_INVALID` error, and have fixtures of their own in `../fixtures/specs/invalid/`
marked `"schema_valid": true`:

- **S2** control fields (`handoff_id`, `resume`, `request_id`, `reply`, `replacement_steps`,
  `ignore_runbook`) belong outside the spec, at the top level of the tool input;
- **S3** every name in `steps[].values` must be a key of the top-level `values`;
- **S4** no `{{placeholder}}` anywhere in a spec;
- **S5** the URL scheme list, which the schema also enforces as a pattern;
- **S6** no string that is empty after trimming — the schema bounds the raw length, the rule
  rejects `"   "`;
- **S7** the certain-secret scan, which is never an error: it reports `secret_treated`.

Problems are reported with a display path in the notation of the design's error catalogue —
`goal`, `steps[0].text`, `values.endpoint_url`, `steps[0].values[0]` — which is the JSON
pointer of the offending location written with dots and brackets, and indexed from 0 like the
document itself (the 1-based numbers an agent sees are the overlay's step counter, in
`current_step.index`). A missing required field is reported at the path of the field that is
absent; an unknown field at the path of the unknown field. Each invalid fixture is paired
with a `<name>.expected.json` stating that path and the error code.

## Placeholders live only in runbooks

`{{name}}` appears in the runbook format and nowhere else. A runbook keeps value **names**,
never values, and each step text carries `{{name}}` where the value was. When the server
converts a runbook into a draft spec it rewrites `{{name}}` as `[name]`, adds the name to
that step's `values` and maps it to `""` in the top-level `values`. The draft is therefore
schema-valid but deliberately not yet acceptable: the empty values fail S6 until the agent
fills them with values from the current project. A spec that still contains `{{…}}` is
rejected (S4).

Because `steps[].values` must be omitted rather than empty in a spec, the converter omits it
for steps that carry no placeholder.

## Limits, and why they exist

The overlay is a narrow panel and error messages have to stay readable, so every string and
every collection is bounded. The limits are generous for real handoffs; the alternative —
no limits — turns a 200-step spec or a 50 KB step text into a broken panel.

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
| `steps[].values`     | 1–20 names, each declared in `values`                                           |
| `steps[].warning`    | 1–300                                                                           |
| `verify`             | 1–4000                                                                          |
| `lang`               | BCP-47 shape `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`                                 |

A value may be the empty string: that is what a draft spec derived from a runbook looks like
before the agent fills it, and S6 is what rejects it at that point.

The runbook schema repeats the spec's limits on every field it copies or derives, including
the 50-step ceiling on the executed sequence, because a runbook must convert back into a
spec that passes `handoff-spec.v1`. Where a runbook has no counterpart in a spec it is freer:
`steps[].values` may be empty, `url`, `warning`, `verify`, `lang` and `last_run_failed_at` are
nullable, and annotation texts are bounded at 4000 characters.

The outcome schema bounds almost nothing, because the server is its only producer: every
field is required and nullable where the field does not apply, so an agent never has to
branch on absence. `runs` starts at 1 (a runbook exists only because a handoff was verified
or confirmed), `deferral_count` is 0, 1 or 2 (a second deferral parks the handoff), and
`round` starts at 1.

## Fixtures

`../fixtures/` holds the contract: valid and invalid specs, one outcome per status, valid
and invalid runbooks. `test/contract/schemas.test.ts` asserts that every valid fixture
validates and every invalid one fails. They are also the parity suite for the Rust
implementation in the app, which must accept and reject exactly the same files.
