# handoff-mcp

`handoff-mcp` is an MCP server that lets a coding agent hand a unit of work over to the
human in front of the machine: the agent describes the work as a handoff spec, the call
blocks while the person does it, and the agent gets back a structured outcome. It is
usable alone, in text mode: with no overlay application listening, the spec is rendered
as text in the tool result and the handoff happens in the chat, so the server works in
any MCP client. The public formats (spec, outcome, runbook) and the tool contract are
MIT-licensed and versioned; the npm package is `baton-handoff-mcp`. Status: work in
progress, nothing is stable yet.
