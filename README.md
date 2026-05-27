# claude-orchestrator

Orchestrate multiple Claude Code agents in parallel from any Claude Code chat — with a live kanban dashboard, real cancel, and long-poll fan-in.

> VS Code extension that embeds an MCP server. Spawn N agents from your chat, watch them stream in a sidebar dashboard, cancel mid-flight, and wait for consolidated results — all without leaving the conversation.

## Features

- **Spawn N parallel agents** from any Claude Code chat via the MCP tool `spawn_agents` (1–8 per call).
- **Per-agent model selection** — Opus, Sonnet, or Haiku per task. Compare answers across models in a single batch.
- **Long-poll fan-in** with `wait_for_agents` — the chat blocks until results are ready and consolidates `last_message` back into the conversation. No polling loops, no context burn.
- **Live kanban dashboard** in the VS Code sidebar — `NOW PLAYING` / `UP NEXT` / `RECENT`, grouped by project + branch + batch.
- **Detail panel** in an editor tab — full streaming log per agent (thinking, tool_use, tool_result, text, usage).
- **Real cancel** from the dashboard or via `cancel_agent` — AbortController is plumbed all the way through the SDK.
- **Session resume** — scanner reads your local `~/.claude/projects/` history and offers resume of past sessions in the chat sidebar or a new terminal.
- **Status bar item** with live count of running agents — click to focus the dashboard.
- **Completion toast** when an agent terminates, with `Open detail` action.
- **Defensive cap** on max agent runtime (default ~33 min) and stuck detection (warns the chat if an agent goes silent).

## Screenshots

<!-- TODO: capture against installed .vsix in VS Code regular and add the assets/ files. -->

| Dashboard sidebar | Detail panel | Status bar |
|---|---|---|
| `assets/screenshots/dashboard.png` *(TBD)* | `assets/screenshots/detail-panel.png` *(TBD)* | `assets/screenshots/status-bar.png` *(TBD)* |

## Demo

<!-- TODO: record a 30-60s demo GIF (peek / asciinema) of spawn -> wait -> cancel -> consolidate. -->

`assets/demo.gif` *(TBD)*

## Install

### From a packaged `.vsix` (recommended)

```bash
code --install-extension claude-orchestrator-0.1.0.vsix
```

Pin the extension and reload VS Code. The MCP server starts automatically on activation and listens on `http://127.0.0.1:39127/mcp`.

### From source (development)

```bash
git clone https://github.com/stevTresCloud/claude-orchestrator.git
cd claude-orchestrator
npm install
npm run compile
```

Then open the folder in VS Code and press `F5` to launch an Extension Development Host with the extension loaded.

## Configure Claude Code to talk to the embedded MCP server

The MCP server requires a bearer token to prevent any local process from invoking `spawn_agents` and burning your Anthropic credits or executing arbitrary tools. The token is generated on first activation and persisted in VS Code Secret Storage (encrypted via the OS keystore).

### Auto-register (default — zero config)

On activation the extension writes its MCP server entry directly into `~/.claude.json` (the Claude Code CLI config), merging with any other MCP servers you already have. A toast confirms the first time it runs:

> *Claude Orchestrator: MCP server registered in Claude Code automatically.*

That's it — open a fresh Claude Code chat in any terminal and the 5 tools (`spawn_agents`, `wait_for_agents`, `list_agents`, `get_agent_log`, `cancel_agent`) are discoverable.

Verify discovery:

```bash
claude mcp list
# claude-orchestrator: ✓ Connected (5 tools)
```

If you ever delete the entry or rotate the token, re-register with the palette command:

```
Ctrl+Shift+P → Claude Orchestrator: Register MCP in Claude Code
```

To opt out of auto-register entirely, set `claudeOrchestrator.autoRegisterMcp` to `false` and follow the manual path below.

### Manual fallback (if Claude Code CLI is not installed or you opted out)

The extension also prints the exact `claude mcp add-json` command — including your token — to the **Claude Orchestrator** output channel on every activation. Copy-paste once per machine:

```bash
claude mcp add-json --scope user claude-orchestrator '{"type":"http","url":"http://127.0.0.1:39127/mcp","headers":{"Authorization":"Bearer <token>"}}'
```

> ⚠️ The token is plain text in the output channel. Don't share screenshots of the channel publicly. If exposed, rotate by clearing VS Code Secret Storage for this extension (the next activation auto-registers the new token).
>
> Note: `claude mcp add --header` is variadic in Commander.js and incorrectly consumes the positional `<name>` and URL as header values, so we use `add-json` instead.

## Usage — invoking the orchestrator from a chat

As of May 2026, Claude Code's tool selection tends to prefer native tools (`Bash run_in_background`, `Task`) over custom MCP tools unless the user prompts explicitly. Until upstream improves discovery, **name the tool in your prompt**.

### Prompt template that works

```
Use spawn_agents from the claude-orchestrator MCP server to launch 3 parallel
agents, then wait_for_agents to consolidate results. Do NOT use Bash or
WebSearch — let the sub-agents do the work.

Agent 1 (opus, cwd: /home/me/repo-a):
  "Read the repos in this directory and give me a one-line summary per repo."

Agent 2 (sonnet, cwd: /home/me/repo-b):
  "Research X. Quick scan, no rabbit holes."

Agent 3 (haiku, cwd: /home/me/repo-c):
  "Look up Y."

Quick answers. Wait for all 3 and consolidate.
```

Keys to a working prompt:

- **Name the tool**: `spawn_agents` and `wait_for_agents` literally.
- **Tell the model NOT to use native tools**: negative prompting (`Do NOT use Bash`) works very well with Claude.
- **Use model aliases**: `opus`, `sonnet`, `haiku` (not `claude-3-5-sonnet-20241022`).
- **Always pass `cwd`**: absolute path. Determines the project/task/branch in the dashboard.
- **Close the loop**: spawn → wait → consolidate.

### Recommended: user-level `CLAUDE.md` directive

Add to `~/.claude/CLAUDE.md` (your global Claude Code config — applies to all chats):

```markdown
## MCP server: claude-orchestrator

When the user asks for parallel sub-agents, multi-model orchestration, batch
delegation, or "lanza N agentes": prefer `spawn_agents` + `wait_for_agents`
from the `claude-orchestrator` MCP server over Bash run_in_background or the
Task tool. The orchestrator gives a kanban dashboard, real cancel, model
targeting, and a long-poll fan-in.
```

Once that directive is in place you can drop the explicit "use spawn_agents" prefix in most prompts.

### Optional: `/orchestrate` slash command

Save a slash command template at `~/.claude/commands/orchestrate.md` and invoke `/orchestrate <task description>` — Claude Code substitutes `$ARGUMENTS` with your request and the command spells out the orchestration flow.

## Settings

Configure under `File → Preferences → Settings → Extensions → Claude Orchestrator`.

| Setting | Default | Description |
|---|---|---|
| `claudeOrchestrator.projectsRoot` | `[]` | Absolute paths whose direct subfolders are treated as projects. Used to derive project/task labels in the dashboard. `~` is expanded. |
| `claudeOrchestrator.scannerRefreshSec` | `0` | Auto-refresh interval (seconds) for the project + session scanner. `0` = manual rescan only (recommended for 50+ projects). |
| `claudeOrchestrator.resumeConfirm` | `false` | Show a confirmation dialog before resuming a past Claude session. |
| `claudeOrchestrator.cancelConfirm` | `false` | Show a confirmation dialog before cancelling a running agent from the dashboard. |
| `claudeOrchestrator.notifyOnComplete` | `true` | Show a toast when an agent reaches a terminal state. Click `Open detail` to jump to the detail panel. |
| `claudeOrchestrator.autoRegisterMcp` | `true` | Auto-write the MCP server entry into `~/.claude.json` on activation. Set to `false` to opt out and use the manual `claude mcp add-json` command. |
| `claudeOrchestrator.defaultModel` | `"sonnet"` | Model used when an agent is spawned without an explicit `model` field. One of `sonnet`, `opus`, `haiku`. |
| `claudeOrchestrator.resumeIn` | `"chat"` | Where to open a resumed past session: `"chat"` uses the Claude Code extension's URI handler; `"terminal"` opens a new VS Code terminal running `claude --resume`. |
| `claudeOrchestrator.maxAgentRuntimeSec` | `2000` | Hard cap on agent lifetime (seconds). After this, the bridge cancels with `reason=max_runtime_exceeded`. Raise for long migrations. |
| `claudeOrchestrator.stuckDetectionSec` | `60` | If a running agent emits no events for N seconds, `wait_for_agents` flags `suspected_stuck=true` in `pending`. Does not cancel — the chat decides. |

## MCP tools

The MCP server exposes 5 tools to any Claude Code chat that has the server registered:

| Tool | Input | Returns |
|---|---|---|
| `spawn_agents` | `{tasks: [{name?, prompt, cwd, model?, priority?}], options?}` | `{batchId, agentIds: string[]}` |
| `wait_for_agents` | `{agent_ids: string[], timeout_sec?}` | `{results: [{agentId, status, last_message, duration_ms, tokens_used, model, reason}], pending: [{agentId, last_message_partial?, last_activity_at, suspected_stuck}], timed_out: boolean}` |
| `list_agents` | `{}` | `{agents: AgentSnapshot[]}` (live + recent terminated) |
| `get_agent_log` | `{agent_id, since?}` | `{entries: [{ts, kind, ...}]}` (ringbuffer, max 1000 entries) |
| `cancel_agent` | `{agent_id}` | `{cancelled: boolean}` |

### Example: parallel multi-model batch

```ts
// From a Claude Code chat — the model issues these tool calls itself.

const { batchId, agentIds } = await spawn_agents({
  tasks: [
    { name: 'audit-repo-a', prompt: 'Audit src/. Report N issues max.', cwd: '/home/me/a', model: 'opus' },
    { name: 'audit-repo-b', prompt: 'Audit src/. Report N issues max.', cwd: '/home/me/b', model: 'sonnet' },
    { name: 'audit-repo-c', prompt: 'Audit src/. Report N issues max.', cwd: '/home/me/c', model: 'haiku' },
  ],
});

const { results, pending, timed_out } = await wait_for_agents({
  agent_ids: agentIds,
  timeout_sec: 600,
});

if (timed_out && pending.length) {
  // Re-call with pending.map(p => p.agentId), or cancel_agent if stuck.
}
```

## Notes

### Prompt caching and context window

You'll see the dashboard's **context bar** climb fast (sometimes to 50–80%) even though `cost=$0.0000`. This is Anthropic's prompt caching at work: cache reads are ~10× cheaper but still occupy tokens. The preset `claude_code` toolset + skills + memory + Reads of large files (Odoo modules, etc.) easily add 50–80k base context per turn. **Feature, not bug.** The cost reported by the SDK is the billable per-turn cost without cache reads.

### VS Code Native Notifications

By default the completion toast is in-VS-Code. If you want it to surface OS-level (so it pings you even when VS Code isn't focused), enable **`window.nativeNotifications`** in user settings (`Ctrl+,` → search "native notifications"). On Linux/macOS this routes through the system notification daemon.

### Bearer token caveat

The bearer token is printed to the output channel on activation. It's stored encrypted in Secret Storage between sessions, but **the output channel is plaintext** — don't share screenshots without redacting. A future release will add a `Copy MCP setup` command with the token redacted.

### Distribution: GitHub Releases only (for now)

The packaged `.vsix` is ~75 MB because it bundles the `@anthropic-ai/claude-agent-sdk` native CLI binary (which the extension invokes at runtime). This exceeds the 50 MB Visual Studio Marketplace limit, so v0.1.0 is distributed via [GitHub Releases](https://github.com/stevTresCloud/claude-orchestrator/releases) only. A v0.2 task tracks bundling / lazy-install strategies to slim the package for Marketplace eligibility.

### Honest limitation: no MCP push notifications

We use a `wait_for_agents` long-poll for fan-in, not MCP push. Reason:

- `notifications/progress` mid-tool-call: Claude Code 2.1.152 doesn't send `progressToken` and discards inbound `notifications/progress` (issue [#58687](https://github.com/anthropics/claude-code/issues/58687)).
- `ExperimentalServerTasks` (MCP task augmentation): the client sends `capabilities: {}` empty in handshake even though `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` handlers are wired internally. Server SDK rejects with `-32601 requires task augmentation`.
- `--channels` push notifications: blocked by Anthropic's org policy (`Inbound messages will be silently dropped`).

Long-poll is the convergent pattern across the OSS Claude orchestration ecosystem (CAO awslabs, claude-flow, claude-squad) and aligns with [SEP-2663](https://github.com/modelcontextprotocol/specification/pull/2663) (Tasks Extension, merged 15 May 2026, also polling-based). When Anthropic enables the `tasks` capability in Claude Code, migration to native push is ~30 LOC and the long-poll stays as fallback.

## Development

```bash
npm install
npm run compile      # one-shot bundle (esbuild for extension, vite for webview)
npm run watch        # rebuild both on save (extension + webview)
npm run package      # production bundle (esbuild --production && vite build)
npm test             # vitest
npm run lint         # eslint
```

In VS Code: press `F5` to open the Extension Development Host. The MCP server starts automatically on activation.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- Multi-agent execution engine inspired by and cherry-picked from [damocles](https://github.com/AizenvoltPrime/damocles) by Alexios Stefanopoulos (MIT).
- MCP tools contract inspired by [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (Apache-2.0).
- Dashboard UX inspired by [manusa/ai-beacon](https://github.com/manusa/ai-beacon) (Apache-2.0).
- Kanban schema and event types informed by [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (MIT).
- Built on top of [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (official Anthropic SDK).

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full list of third-party software bundled with this extension.
