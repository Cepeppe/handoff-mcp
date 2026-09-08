# Versions and compatibility

Several things in this repository carry a version, and they are independent of each other. A
server 1.4.0 may still speak `spec_version` 1: the package version says how old the code is,
a format version says what the document means.

| Version                    | Carried in                                                       | Bumped when                                  | Compatibility rule                                                                     |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `spec_version`             | Every [spec](handoff-spec.md)                                    | A field is added, removed or changes meaning | The server accepts its own version and every previous one; a higher one is refused     |
| `outcome_version`          | Every [outcome](outcome.md)                                      | Same                                         | The server is the only producer; agents read what they get                             |
| `runbook_version`          | Every [runbook file](runbook-format.md)                          | Same                                         | The server reads its own version and the previous ones; the overlay writes the current |
| `patterns_version`         | [`certain-secrets.v1.json`](../patterns/certain-secrets.v1.json) | The pattern set changes                      | Informational; recorded with each send                                                 |
| Channel `protocol_version` | The `hello` of [the internal channel](channel.md)                | Any message changes                          | Must be **equal** on both sides; there is no negotiation                               |
| Package version            | npm, the release tag, `hello.server_version`                     | Every release                                | Semantic versioning                                                                    |

## The formats

An integer, bumped when a field is added, removed or changes meaning. Adding an optional
field to the **outcome** does not bump it — the server is the only producer and every field is
already always present — but adding one to the **spec** does, because a spec is something
anybody may write and every implementation has to agree on what is allowed.

A spec whose `spec_version` is higher than the server understands is refused with
[`SPEC_VERSION_UNSUPPORTED`](errors.md) before the schema even runs, so the answer is one
clear sentence — update the server, or lower the version — rather than a list of unknown
fields that hides the actual reason.

A bump of `outcome_version` is announced in the tool description, which is where an agent that
reads nothing else will meet it.

The `$id` of each schema is stable, under
`https://raw.githubusercontent.com/Cepeppe/handoff-mcp/main/schemas/`. It is an identifier,
not a promise that anything fetches it at runtime: every implementation loads the files that
ship with it. The outcome schema refers to the spec schema by that `$id` for
`runbooks[].draft_spec`, so it does not compile on its own — register all three schemas in
one validator.

## The channel

Exact equality, no negotiation, no support for older versions. Both binaries ship from one
release, so a mismatch means a server installed separately meeting an overlay of another
version, or a stale application; the correct answer to that is to update, not to degrade
silently into a protocol nobody tested. What happens instead is
[text mode](text-mode.md) with an instruction to update. See
[the internal channel](channel.md).

The channel is also the one thing here with **no stability promise at all**. It is internal
and may change in any release.

## The package

Semantic versioning, against the public surface: the three schemas, the tool contract, the
CLI and its exit codes. The channel is not part of that surface.

Releases are tagged `v<version>`, and each one publishes a standalone executable per platform,
a `SHA256SUMS` file and a minisign signature of it. Verify with the public key committed at
[`keys/handoff-mcp-release.pub`](../keys/handoff-mcp-release.pub):

```console
$ minisign -Vm SHA256SUMS -p keys/handoff-mcp-release.pub
$ sha256sum -c SHA256SUMS --ignore-missing
```

[`CHANGELOG.md`](../CHANGELOG.md) follows Keep a Changelog and records format bumps
separately from code changes.

## What "stable" means today

Nothing is stable yet. The version numbers above are already how compatibility will be
decided, and the schemas and the tool contract are already versioned and tested against
fixtures — but this is pre-1.0 work in progress, and a v1 format is only a promise once there
is a 1.0 to promise it in.
