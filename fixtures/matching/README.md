# Matching fixtures

One file per case of the matching rule of `TECHNICAL-DESIGN` §4.5.3 (RUN-07a), the rule
`handoff_runbooks` and the RUN-07 safety net both apply. The fixtures are the contract:
every implementation — the server here, the app in Rust — must produce the same result for
the same case, in the same order, with the same `matched_words`.

## Shape of a case

```json
{
  "case": "arrow-variants",
  "why": "One sentence saying what this case pins.",
  "query": { "where": "…", "goal": "…", "lang": "en" },
  "runbooks": [
    { "id": "rb_a000000001", "where": "…", "goal": "…", "last_verified_at": "2026-09-01T10:00:00Z" }
  ],
  "expected": [{ "id": "rb_a000000001", "matched_words": ["…"] }]
}
```

`query.lang` is absent in the cases that test the absent-language behaviour.

`runbooks[]` carries **only the four fields the rule reads**: `id`, `where`, `goal` and
`last_verified_at`. A consumer expands each one into a schema-valid runbook by filling the
remaining fields with anything the schema accepts — the matcher never looks at them — and
must not let those fillers vary between cases. The expansion this repository uses is in
`test/contract/matching.test.ts`; it fills `url`, `lang`, `verify` and `last_run_failed_at`
with `null`, `values` and `secrets` with `{}`, one step with no placeholders and no
annotations, `trust: "verified"`, `runs: 1`, and the same instant for `created_at` and
`updated_at`. The test validates every expanded runbook against
`schemas/handoff-runbook.v1.schema.json` before matching, so a case can never be built on a
document the format would refuse.

`expected` is the **ordered** list of results after ranking and after the cap of
`RUNBOOK_MATCH_MAX_RESULTS`. `matched_words` is ordered too: the shared words in the order
they first appear in the **query's** goal, deduplicated. Ranking is shared-word count
descending, then `last_verified_at` descending, then `id` ascending — the third key is not
in §4.5.3 and is what makes a tie deterministic across implementations.
