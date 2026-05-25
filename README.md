# claude-orchestrator

VS Code extension to orchestrate multiple Claude Code agents in parallel via an embedded MCP server + an observable kanban dashboard.

## Status

Pre-release. The extension exposes an embedded MCP server with a single tool (`spawn_agents`) consumable from any external Claude Code chat. Dashboard UI is still pending.

## Architecture

Authoritative spec lives in the project documentation:
`~/stev-projects/claude-orchestrator/fase_1_plugin/ARCHITECTURE_PHASE_I.md`

Quick overview: Claude Code chat triggers an MCP tool exposed by this extension; the extension spawns N agents via `@anthropic-ai/claude-agent-sdk` and renders them in a kanban dashboard inside VS Code. The user observes streams, cancels, and (optionally) sends messages from the dashboard.

## Development

```bash
npm install
npm run compile      # one-shot bundle via esbuild
npm run watch        # rebuild on save
```

In VS Code: press `F5` to open the Extension Development Host. Then `Ctrl+Shift+P → "Claude Orchestrator: Hello"` runs the placeholder command. The embedded MCP server starts automatically on activation and listens on `http://127.0.0.1:39127/mcp`.

## Connecting Claude Code to the embedded MCP server

The MCP server requires a bearer token to prevent any local process from invoking `spawn_agents` and spending your Anthropic credits or executing arbitrary tools. The token is generated on first activation and persisted in VS Code Secret Storage (encrypted via the OS keystore).

While the Extension Development Host (or a packaged install) is running, the exact `claude mcp add-json` command — including your token — is printed to the **Claude Orchestrator** output channel on activation. Copy-paste it once per machine; it looks like:

```bash
claude mcp add-json --scope user claude-orchestrator '{"type":"http","url":"http://127.0.0.1:39127/mcp","headers":{"Authorization":"Bearer <token>"}}'
```

> Note: `claude mcp add --header` is variadic and incorrectly consumes the positional `<name>` and URL as header values, so this project uses `add-json` instead.

Then, from any Claude Code chat (a different terminal or window — not the EDH itself), verify discovery:

```bash
claude mcp list
```

Available tools:

- `spawn_agents` — spawn a Claude Code agent with a given prompt and return its result.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- Multi-agent execution engine inspired by and cherry-picked from [damocles](https://github.com/AizenvoltPrime/damocles) by Alexios Stefanopoulos (MIT).
- MCP tools contract inspired by [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (Apache-2.0).
- Dashboard UX inspired by [manusa/ai-beacon](https://github.com/manusa/ai-beacon) (Apache-2.0).
- Built on top of [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (official Anthropic SDK).
