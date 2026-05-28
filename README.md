# Claude Orchestrator

> A kanban board for your Claude Code agents. Spawn a batch, watch them run live in a sidebar, get consolidated answers back in your chat — without leaving VS Code.

## What it does

Most of the time you chat with a single Claude Code agent. Sometimes you want three: one to audit a repo, one to draft tests, one to research a library — at the same time. Or you want Opus, Sonnet and Haiku working the same prompt so you can compare answers.

**Claude Orchestrator turns VS Code into the cockpit.** Type a natural request in any Claude Code chat — *"lanza 3 agentes paralelos: uno opus que audite `src/`, uno sonnet que esboce tests, uno haiku que resuma el README"* — and the chat fans out the work, the sidebar dashboard tracks every agent live, and the consolidated answers come back to your conversation.

## Why use it

- **Compare models on the same task.** Run Opus, Sonnet and Haiku in parallel and pick the winner.
- **Parallelize research and audits.** Three repos, three agents, one batch — finished in the time of the slowest one.
- **Stay in control.** Cancel any agent mid-flight from the dashboard, watch its live log in a detail panel, get a toast when each finishes.
- **Keep your context clean.** The orchestrator returns *consolidated answers* — not raw transcripts — so your chat's context window stays small.
- **Pick the right model per task.** Opus for architecture decisions, Sonnet for coding, Haiku for grep-and-summarize.

## Install

1. Download `claude-orchestrator-0.1.0.vsix` from [Releases](https://github.com/stevTresCloud/claude-orchestrator/releases).
2. Install it: `code --install-extension claude-orchestrator-0.1.0.vsix` (or right-click the `.vsix` in VS Code → *Install Extension VSIX*).
3. Reload VS Code.

That's it. The extension **auto-registers** with [Claude Code](https://claude.com/claude-code) on first activation — no token copy-pasting, no manual config.

> *Prerequisites: [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude login`). VS Code 1.120+, Node 22+.*

## First spawn (60 seconds)

1. Open any terminal and start a Claude Code chat: `claude`.
2. Ask in natural language:

   > *Lanza 3 agentes paralelos en este repo: uno haiku que liste los archivos en `src/`, uno sonnet que me resuma el README, uno opus que sugiera 3 mejoras de arquitectura. Espera a que terminen y consolida.*

3. Open the **Claude Orchestrator** sidebar in VS Code — `UP NEXT → NOW PLAYING → RECENT` fills as agents progress.
4. Click any card to open the detail panel with the live log.
5. The chat returns a consolidated answer from all 3 agents.

## Screenshots and demo

> *Screenshots, demo GIF and a short walkthrough video are coming in v0.1.1.*

## What's inside

- **5 MCP tools** exposed to any Claude Code chat: `spawn_agents`, `wait_for_agents`, `list_agents`, `get_agent_log`, `cancel_agent`.
- **Kanban dashboard** in the VS Code sidebar — *NOW PLAYING / UP NEXT / RECENT*, grouped by project and branch.
- **Detail panel** in an editor tab — per-agent streaming log with thinking, tool calls, tool results, usage and cost.
- **Status bar** with a live count of running agents (click to focus the dashboard).
- **Per-task model selection** — `opus`, `sonnet`, or `haiku`.
- **Cancel** from card buttons or via the `cancel_agent` MCP tool.
- **Session resume** — scans your `~/.claude/projects/` history and offers to resume past sessions in the chat or a new terminal.
- **Safety caps** — max agent runtime (default 33 min) and a stuck-detection signal that flags silent agents to your chat.
- **Cost tracking in USD per agent** — visible in cards, detail panel and the consolidated `wait_for_agents` result.

## Configuration

Settings live under `File → Preferences → Settings → Extensions → Claude Orchestrator`. The defaults are sensible — touch these only if you're tuning.

| Setting | Default | What it does |
|---|---|---|
| `claudeOrchestrator.projectsRoot` | `[]` | Folders whose direct children are treated as projects in the dashboard. |
| `claudeOrchestrator.defaultModel` | `"sonnet"` | Model used when a task is spawned without an explicit `model`. |
| `claudeOrchestrator.maxAgentRuntimeSec` | `2000` | Hard cap on agent lifetime. |
| `claudeOrchestrator.stuckDetectionSec` | `60` | Flag an agent as suspected-stuck if it stops emitting events for this many seconds. |
| `claudeOrchestrator.autoRegisterMcp` | `true` | Auto-write the MCP server entry into `~/.claude.json` on activation. |
| `claudeOrchestrator.notifyOnComplete` | `true` | Toast when an agent reaches a terminal state. |
| `claudeOrchestrator.scannerRefreshSec` | `0` | Auto-refresh interval for the session scanner (`0` = manual rescan only). |
| `claudeOrchestrator.resumeIn` | `"chat"` | Where to open a resumed session: `"chat"` or `"terminal"`. |
| `claudeOrchestrator.resumeConfirm` | `false` | Confirmation dialog before resuming a past session. |
| `claudeOrchestrator.cancelConfirm` | `false` | Confirmation dialog before cancelling a running agent. |

## Tips to get the orchestrator picked

Claude Code's tool selection sometimes prefers native `Bash` or `Task` over a custom MCP tool. Two simple things help a lot:

1. **Name the tool in your prompt** — *"use `spawn_agents` from the claude-orchestrator MCP"*.
2. **Add a directive to `~/.claude/CLAUDE.md`** so every chat picks the orchestrator by default:

   ```markdown
   ## MCP server: claude-orchestrator

   When the user asks for parallel sub-agents, multi-model orchestration or
   batch delegation: prefer spawn_agents + wait_for_agents from the
   claude-orchestrator MCP server over Bash run_in_background or Task.
   The orchestrator gives a kanban dashboard, real cancel, model targeting
   and a long-poll fan-in.
   ```

You can also save a slash command at `~/.claude/commands/orchestrate.md` and invoke `/orchestrate <task>` from any chat.

## Advanced

<details>
<summary><b>Manual MCP setup (if auto-register is disabled)</b></summary>

The extension prints the exact `claude mcp add-json` command — including your token — to the **Claude Orchestrator** output channel on every activation:

```bash
claude mcp add-json --scope user claude-orchestrator \
  '{"type":"http","url":"http://127.0.0.1:39127/mcp","headers":{"Authorization":"Bearer <token>"}}'
```

To opt out of auto-register, set `claudeOrchestrator.autoRegisterMcp` to `false`.

To re-run the registration manually: `Ctrl+Shift+P → Claude Orchestrator: Register MCP in Claude Code`.

</details>

<details>
<summary><b>Build from source</b></summary>

```bash
git clone git@github.com:stevTresCloud/claude-orchestrator.git
cd claude-orchestrator
npm install
npm run compile      # bundle extension + webview
npm run watch        # rebuild on save
npm test             # vitest
npm run package      # produce .vsix
```

In VS Code, press `F5` to launch an Extension Development Host with the extension loaded.

</details>

## Caveats

A few things worth knowing before installing — full list in the [CHANGELOG](./CHANGELOG.md#known-caveats):

- The `.vsix` is ~75 MB because it bundles the official Anthropic CLI binary used at runtime. Distributed via GitHub Releases only (above the VS Marketplace 50 MB limit). v0.2 tracks slimming the bundle.
- First scan can take 60–90s if you have 150+ past Claude Code sessions; subsequent activations hit a cache and complete in ~25s.
- Single detail panel instance for v0.1; multi-instance with cap + LRU is on the v0.2 backlog.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built on top of [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (official Anthropic SDK), with the multi-agent execution engine cherry-picked from [damocles](https://github.com/AizenvoltPrime/damocles) (MIT). MCP tools contract inspired by [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (Apache-2.0); dashboard UX inspired by [manusa/ai-beacon](https://github.com/manusa/ai-beacon) (Apache-2.0); kanban schema informed by [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (MIT).

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full list of bundled software.
