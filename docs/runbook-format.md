# The runbook format

A runbook is a recipe saved from a handoff that worked. The next time the same kind of work
comes up, the agent starts from what was actually done instead of guessing again.

- Schema: [`handoff-runbook.v1.schema.json`](../schemas/handoff-runbook.v1.schema.json)
- Examples: [`fixtures/runbooks/valid/`](../fixtures/runbooks/valid/)
- Search them offline: `handoff-mcp runbooks search --where … --goal …`

## Where they live

```
~/.handoff/runbooks/                       %USERPROFILE%\.handoff\runbooks\ on Windows
  stripe-dashboard-developers-webhooks__register-the-stripe-webhook__rb_2b9x4d7fkq.json
```

One JSON file per runbook, named `<where-slug>__<goal-slug>__<id>.json` so the folder is
readable in a file browser: the slugs are the normalised `where` and `goal` truncated to 60
characters, and the id keeps the name unique. They are the user's files, in the user's home,
in a documented format — deleting one is a supported way to make the system forget something.

The overlay application writes them, atomically. This server only reads them. A missing
folder is an empty result, never an error; a file that does not parse is named on stderr and
skipped, because one bad file must never break a search.

## The fields

| Field                        | Type              | Content                                                                                          |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `runbook_version`            | integer           | `1`                                                                                              |
| `id`                         | string            | `rb_` + 10 characters                                                                            |
| `where`, `goal`, `why_human` | string            | Copied from the spec of the last verified round                                                  |
| `url`, `lang`                | string or null    | Copied                                                                                           |
| `values`                     | object            | name → `{ "description" }`: the step text where the value appeared, with `{{name}}` in its place |
| `secrets`                    | object            | Variable name → destination file. Names only, as in the spec                                     |
| `steps`                      | array             | The sequence **actually executed**, with `{ text, url, values, warning, annotations }`           |
| `verify`                     | string or null    | With placeholders where values appeared                                                          |
| `trust`                      | string            | `"verified"` or `"confirmed_by_user"`                                                            |
| `last_verified_at`           | date-time         | Used to rank matches, so freshness is visible                                                    |
| `last_run_failed_at`         | date-time or null | Set when a run of this runbook failed verification and no correction followed                    |
| `runs`                       | integer ≥ 1       | How many verified or confirmed executions are folded into this file                              |
| `created_at`, `updated_at`   | date-time         |                                                                                                  |
| `origin`                     | object            | `{ "app", "app_version" }`                                                                       |

`trust` is the honest distinction the whole system is built on: `verified` means an agent
checked the result with its own tools; `confirmed_by_user` means the person said it was done
and nobody checked. They are never conflated.

### What "actually executed" means

`steps` is not the spec's step list. It is what happened: for each round in order, that
round's steps minus the ones skipped, minus the ones a later round replaced before they were
confirmed, with replacement steps where they were executed. The detour is preserved in the
annotations rather than in the steps, so the recipe stays a recipe.

| `annotations[].kind` | Where it comes from                                    |
| -------------------- | ------------------------------------------------------ |
| `note`               | Something the person wrote down on that step           |
| `question`           | Something they asked                                   |
| `reply`              | The agent's answer                                     |
| `error`              | A failed verification, on the last step of that round  |
| `correction`         | On the first step of the round that followed a failure |

The steps are the recipe; the annotations are the diary of how it went.

## Placeholders

`{{name}}` appears in the runbook format and **nowhere else**. A runbook keeps value _names_,
never values: each step text carries `{{name}}` where the value was, and `values[name]`
carries the description of what goes there.

Values that were treated as secrets are never written. Their name gets the description
`"[treated as secret at ingress]"` and every literal occurrence becomes `{{name}}`. As a last
defence the certain patterns are run once more over the finished file, and a match aborts the
write.

A spec that still contains `{{…}}` is rejected by rule S4 — see
[the handoff spec](handoff-spec.md#the-rules-the-schema-cannot-express). That is deliberate:
it means an unfilled recipe can never be handed to a person.

## Matching

`handoff_runbooks` and the safety net use the same rule, deterministic and explainable:

```
normalize_where(s):  NFKC → lowercase → every run of whitespace or of the separators
                     → > » / \ | – — - : , ; . becomes one space → trim
tokens(goal, lang):  NFKC → lowercase → split on non-alphanumerics → drop tokens
                     shorter than 3 code points → drop stop-words
match:               normalized `where` equal, and at least one shared goal token
ranking:             shared tokens desc, then last_verified_at desc, then id asc
                     at most 5 results
```

The stop-word lists live in
[`patterns/certain-secrets.v1.json`](../patterns/certain-secrets.v1.json) under `stop_words`,
so every implementation uses the same list. `--lang` (or the spec's `lang`) picks one list;
without it, the shipped lists are used together.

There is no fuzzy similarity and no model in this. `matched_words` comes back with every
result so the reason for a match is always visible, and `where` has to be the _same place_ —
a shared word in the goal is what widens the net, not a guess at what you meant.

The whitespace and separator sets are written out as explicit character classes rather than
as `\s`, and token length is counted in code points, because two regex engines disagree about
both and a runbook that matched on one implementation and not on the other would be worse
than no matching at all.

## Conversion to a draft spec

A match comes back as a `draft_spec` you can almost use:

- `{{name}}` becomes `[name]` in step texts, warnings and `verify`;
- every name found is added to that step's `values`;
- `draft_spec.values` maps each name to `""`;
- `values_to_fill` maps each name to its description;
- annotations come back beside the draft, not inside it.

The draft is **deliberately not yet valid**: the empty values fail rule S6 until you replace
them with values from the current project. Nothing can therefore open a handoff with blanks
in it. Fill `values_to_fill`, then call `handoff_to_user` with the completed spec and
`ignore_runbook: true`.

A runbook field that is null — `url`, `verify`, `lang`, a step's `url` or `warning` — is
omitted from the draft rather than copied as null, and a step with no placeholder gets no
`values` key at all, because a spec has no nullable fields and no empty `values` array.
