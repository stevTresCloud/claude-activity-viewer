# claude-orchestrator

VS Code extension to orchestrate multiple Claude Code agents in parallel via an embedded MCP server + an observable kanban dashboard.

## Status

**Phase 1.0 — scaffold base.** No functionality beyond a placeholder command. See architecture doc for the roadmap.

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

In VS Code: press `F5` to open the Extension Development Host. Then `Ctrl+Shift+P → "Claude Orchestrator: Hello"` runs the placeholder command.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- Multi-agent execution engine inspired by and cherry-picked from [damocles](https://github.com/AizenvoltPrime/damocles) by Alexios Stefanopoulos (MIT).
- MCP tools contract inspired by [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (Apache-2.0).
- Dashboard UX inspired by [manusa/ai-beacon](https://github.com/manusa/ai-beacon) (Apache-2.0).
- Built on top of [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (official Anthropic SDK).
