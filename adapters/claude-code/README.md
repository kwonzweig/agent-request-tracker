# Claude Code

Planned; this directory does not contain an installable adapter yet.

Choose the integration using the current [Claude Code plugin documentation](https://code.claude.com/docs/en/plugins). [Mods](https://code.claude.com/docs/en/plugins/mods/overview) offer native panels and controls; the Codex HTML renderer is not verified in Claude Code.

Reuse the existing journal schema, atomic store, reply validation and [card actions](../../docs/guide.md). Keep host-specific code here. Preserve the existing plugin and storage identifiers so current records remain readable.

Before claiming support, verify in a real Claude Code session:

- Requests survive a new turn and a session restart.
- Send reply delivers a choice and its Comment together and records them once.
- Informational × saves silently, without sending a prompt or starting the agent.
- Only agent verification resolves a Blocker; Later and unsent choices are not approval.
- User interruption does not restart work, and Codex checks still pass.

Consult the current [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp) and [plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference) references for host identity, paths and lifecycle behavior. Package validation and mocked event tests do not establish native UI support.
