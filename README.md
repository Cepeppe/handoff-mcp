# handoff-mcp

`handoff-mcp` is an MCP server that lets a coding agent hand a unit of work over to the
human in front of the machine: the agent describes the work as a handoff spec, the call
blocks while the person does it, and the agent gets back a structured outcome. It is
usable alone, in text mode: with no overlay application listening, the spec is rendered
as text in the tool result and the handoff happens in the chat, so the server works in
any MCP client. The public formats (spec, outcome, runbook) and the tool contract are
MIT-licensed and versioned; the npm package is `baton-handoff-mcp`. Status: work in
progress, nothing is stable yet.

## Validating a spec offline

`handoff-mcp validate <spec.json>` runs the same pipeline the tool runs — the published
schema, then the semantic rules — and answers with the same JSON error an agent would get,
so a spec can be checked without an agent and without the overlay:

```console
$ handoff-mcp validate spec.json
spec.json: valid handoff spec (spec_version 1, 4 steps, 2 values, 1 secret, verify present)
```

It exits 0 on a valid spec, 1 with `{ "error": { "code", "message", "problems" } }` on an
invalid one (every problem at once, each with a path and what to change), and 2 when the
file cannot be read. Errors never quote the contents of the spec: they name paths, fields,
limits and expected shapes only. From a checkout, `pnpm build` once and then
`pnpm handoff-mcp validate <spec.json>`.

## Searching the saved runbooks offline

A runbook is a recipe saved from a handoff that worked, as a JSON file in
`~/.handoff/runbooks/` (`%USERPROFILE%\.handoff\runbooks\` on Windows).
`handoff-mcp runbooks search` applies the same rule the `handoff_runbooks` tool applies and
prints the same result, so a person can see what an agent would be offered:

```console
$ handoff-mcp runbooks search --where "Stripe Dashboard > Developers > Webhooks" \
    --goal "Set up Stripe webhook for payment notifications" --lang en
{
  "runbooks": [
    {
      "id": "rb_2b9x4d7fkq",
      "matched_words": ["stripe", "webhook", "payment"],
      "draft_spec": { "…": "the runbook as a spec, with [name] where the values go" },
      "values_to_fill": { "endpoint_url": "…", "events": "…" }
    }
  ]
}
```

A runbook matches when its `where` is the same place after normalisation — case, arrows and
the other separators are ignored — **and** the two goals share at least one word beyond
stop-words. There is no fuzzy similarity and no model: `matched_words` says exactly which
words matched. Results are ranked by shared words, then by how recently the runbook was last
verified, and at most five come back.

`--lang` is a BCP-47 tag and selects the stop-word list; without it the shipped lists are
used together. The draft spec is deliberately not yet valid — its values are empty strings —
so nothing can open a handoff with blanks in it: fill `values_to_fill` first.

It exits 0 with a possibly empty list, and 1 with a `RUNBOOKS_UNREADABLE` error when the
folder exists but cannot be read; a folder that is not there is simply an empty list. Files
that could not be parsed are named on stderr and skipped, never fatal. `HANDOFF_HOME`
overrides `~/.handoff` for tests.

## Development

Node 22 is the minimum supported version (`engines.node`); `.nvmrc` and `.node-version`
pin 24, which is what CI and development use. Install with `pnpm install`, then:

| Script               | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm build`         | Bundles `src/` into `dist/handoff-mcp.cjs`, the file `bin` points at |
| `pnpm handoff-mcp`   | Runs that bundle: `pnpm handoff-mcp validate <spec.json>`            |
| `pnpm test`          | Runs the Vitest suites, except the canaries                          |
| `pnpm test:contract` | Runs the contract suite alone                                        |
| `pnpm lint`          | ESLint, type-aware                                                   |
| `pnpm format`        | Prettier, in place (`pnpm format:check` to only check)               |
| `pnpm typecheck`     | `tsc --noEmit`                                                       |
