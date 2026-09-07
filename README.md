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
