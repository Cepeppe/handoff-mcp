# Security policy

`handoff-mcp` handles secrets on purpose: it detects the certain ones in a handoff spec and
masks them before an agent, a log or a text-mode rendering can show them. A way around that is
a vulnerability even when nothing crashes, and so is anything that lets another local process
talk to the channel without its token.

## Reporting a vulnerability

Please report it privately, with **Report a vulnerability** on the Security tab of this
repository, and not in a public issue. Say what you did, what you expected and what happened.
A spec, a command or a test that reproduces it helps most; if it involves a secret, use a
synthetic one, never a real credential.

## Supported versions

Nothing is stable yet: fixes go into the next release, and earlier releases are not patched.
