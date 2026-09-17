# Contributing to handoff-mcp

Thank you for taking the time. `handoff-mcp` has a single maintainer and is built from a written
design, published with the app in
[`handoff-app/docs/design`](https://github.com/Cepeppe/handoff-app/tree/main/docs/design), so a
few rules keep contributions and the planned work out of each other's way.

## Before you start

- **Small fixes go straight to a pull request**: a typo, a broken link, a wrong sentence in the
  documentation, or a bug fix together with a test that fails without it.
- **Anything larger starts with an issue**: a new feature, a new dependency, a new agent, or any
  change to the formats (spec, outcome, runbook), the tool contract, the certain-secret patterns
  or the channel. Those are public contracts with their own versions
  ([`docs/versioning.md`](docs/versioning.md)), and the overlay application depends on them.
  Describe the problem before the solution and wait for an answer before writing the code.
- **A vulnerability is never a public issue.** Report it privately, as
  [`SECURITY.md`](SECURITY.md) explains.
- **The overlay application** lives in [`handoff-app`](https://github.com/Cepeppe/handoff-app):
  changes to it start there.

## Reporting a bug

Say what you did, what you expected and what happened, with the version of `handoff-mcp`, of
Node.js or of the executable, of the operating system, and of the agent you used. A spec that
reproduces it helps most. Never attach a real credential: use a synthetic value.

## Pull requests

- **One change per pull request**, with its tests.
- **Run the checks** of the [Development](README.md#development) section before opening it:
  `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check` and
  `pnpm check:links`. CI runs all of them but `pnpm format:check` on every pull request.
- **A change to a format, the tool contract or the patterns** updates its schema, its fixtures and
  its documentation in the same pull request, and says whether it bumps a version.
- **Add a line to `CHANGELOG.md`**, under `[Unreleased]`, for a change a user would notice.
- **Commit messages** follow the history: `type(scope): summary`, with `feat`, `fix`, `docs`,
  `test`, `build` or `chore`, a lowercase summary, and a body that says why.
- **Tests and fixtures use synthetic secrets only.** A key that has ever been valid anywhere does
  not belong in the repository, not even once revoked.

Comments and documents cite the design as `§5.8`, `SPEC-05` or `T-054`; the
[README of the design documents](https://github.com/Cepeppe/handoff-app/blob/main/docs/design/README.md)
explains those citations. A contribution does not have to add any.

## Licence

`handoff-mcp` is released under the [MIT licence](LICENSE). By opening a pull request you agree
that your contribution is released under the same licence, and you confirm that you have the
right to contribute it.
