# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-27

First public release. The extension exposes an embedded MCP server with 5 tools, a live kanban dashboard, real cancel, long-poll fan-in, session resume, and a detail panel — all driven from any external Claude Code chat.

### Added

#### MCP server

- HTTP server embedded in the extension host, listening on `http://127.0.0.1:39127/mcp`.
- Bearer token auth (256-bit random, persisted in VS Code Secret Storage, timing-safe comparison).
- **Auto-register** in `~/.claude.json` on activation (merges with existing MCP servers, atomic write, idempotent). Opt-out via `claudeOrchestrator.autoRegisterMcp = false`. Palette command `Claude Orchestrator: Register MCP in Claude Code` re-runs the merge manually. Manual `claude mcp add-json` fallback still printed to the output channel on every activation.
- DNS rebinding protection (`enableDnsRebindingProtection: true`, restricted `allowedHosts`).
- Fresh `McpServer` + `StreamableHTTPServerTransport` per request to dodge a SDK bug (`_streamMapping` leak in stateless+JSON mode).

#### MCP tools (5)

- **`spawn_agents`** — spawn 1–8 parallel Claude Code agents per call. Per-task `prompt`, `cwd` (absolute), optional `name` / `model` / `priority`. Returns `{batchId, agentIds}`. Uses the official `@anthropic-ai/claude-agent-sdk` with toolset preset `claude_code` and user-level skills + memory inheritance.
- **`wait_for_agents`** — long-poll fan-in: blocks until all `agent_ids` reach a terminal state (`done` / `failed` / `cancelled`) or `timeout_sec` elapses (default 300s, max 1200s). Returns `{results, pending, timed_out}`. Event-driven internally (no busy polling).
- **`list_agents`** — registry snapshot of live + recent terminated agents.
- **`get_agent_log`** — ringbuffer (max 1000 entries FIFO) per agent. Supports `since` for incremental pagination.
- **`cancel_agent`** — wrapper over the bridge's AbortController. Idempotent (`{cancelled: false}` if the agent already terminated).

#### Dashboard (Vue 3 + Pinia + Tailwind v4 webview in the VS Code sidebar)

- Three live kanban sections: **NOW PLAYING** (running), **UP NEXT** (pending), **RECENT** (terminal, last 24h grouped by lifecycle).
- Project groups inside each section, derived from `cwd` vs `claudeOrchestrator.projectsRoot` + workspace folders.
- Project lifecycle states: `active` (green dot), `idle` (<24h, ring), `inactive` (≥24h, ring + opacity).
- Atoms: `StatusDot` (with optional pulse + halo), `ContextBar` (live tokens, color by threshold), `ModelBadge`, `PriorityPill`, `FailedBadge`.
- Project selector toolbar (dropdown — `All projects` default, filter to a single project).
- Standalone card variants for single-project views.
- Past sessions integration: scanner reads `~/.claude/projects/<encoded>/*.jsonl` and renders past sessions per project with a Resume button.

#### Detail panel (custom editor tab)

- Custom WebviewPanel in an editor tab, opened by clicking a card body in the dashboard.
- Live `LogStream` rendering thinking (dim italic), tool_use (IN block), tool_result (OUT block with `is-error` indicator), text (paragraph), usage (pill).
- Auto-scroll with `requestAnimationFrame` throttle.
- Multi-webview broadcast in the bridge: sidebar + detail panel cohabit; targeted `hydrateLogs(agentId, targetWebview)` avoids re-serializing 1000 entries to the sidebar.
- Single-instance policy: opening a different agent disposes + recreates the panel (multi-instance is on the v0.2 backlog).

#### Cancel

- X button in each running card (sidebar + detail panel both cancel).
- AbortController plumbed from card click → scanner-controller → bridge → `AgentRunner` → SDK.
- Optional confirmation modal (`claudeOrchestrator.cancelConfirm`).
- `cancel_agent` MCP tool also exposed for chat-driven cancel.

#### Session resume

- Scanner walks `~/.claude/projects/<encoded>/*.jsonl` with mtime cache + JSONL parser (no synchronous git forks per session — branch read from header).
- Heuristic project derivation handles edge cases: workspace = parent folder (e.g. `~/git18` with sessions in `~/git18/docs/<project>/`), conversational prompts without file paths, etc.
- Resume in chat (default — uses `vscode://anthropic.claude-code/open?session=<id>` URI handler with workspace-cwd guard) or in a new terminal (`claude --resume <id>`).
- Empty state for projects with no agents and no past sessions.

#### Status bar

- Bottom-right item: `$(rocket) N agent[s]` while running > 0.
- Auto-hides when count = 0.
- Click → focuses the dashboard sidebar.

#### Completion notifier

- Toast on terminal status (`done` / `failed` / `cancelled`).
- `failed` uses `showWarningMessage` (warning icon); others use `showInformationMessage`.
- `Open detail` action button → opens the detail panel for that agent.
- Toggle via `claudeOrchestrator.notifyOnComplete` (default `true`).

#### Model selection

- Per-task model in `spawn_agents` (`sonnet`, `opus`, `haiku`).
- Tool description nudges the chat model to ask the user when not specified, especially before expensive long-running tasks.
- Setting `claudeOrchestrator.defaultModel` for the fallback when `model` is omitted.
- Real model id captured from `SDKSystemMessage.init.model` (e.g. `claude-sonnet-4-5-20251022`) and pretty-printed in `ModelBadge` (`Sonnet 4.5`).
- QuickPick on the palette command `Claude Orchestrator: Test Agent`.

#### Context bar

- Live tokens captured incrementally from `SDKAssistantMessage.message.usage` on every turn (not just on final result).
- `contextTokens = input + cacheRead + cacheCreation` — matches the percentage shown in the bar (previously inconsistent because most context travels via prompt cache).
- Separate `tokensUsed` field preserved as the billable per-turn cost (without cache reads).

#### Defensive caps

- `claudeOrchestrator.maxAgentRuntimeSec` (default 2000s) — hard cap on agent lifetime, bridge cancels with `reason=max_runtime_exceeded`. Race-safe against manual cancel.
- `claudeOrchestrator.stuckDetectionSec` (default 60s) — if a running agent emits no events for N seconds, `wait_for_agents` flags `suspected_stuck=true` in `pending`. Does not cancel — the chat decides.

#### Configuration (10 settings)

`projectsRoot`, `scannerRefreshSec`, `resumeConfirm`, `cancelConfirm`, `notifyOnComplete`, `autoRegisterMcp`, `defaultModel`, `resumeIn`, `maxAgentRuntimeSec`, `stuckDetectionSec`. See [README.md](README.md#settings) for the table.

#### Test suite

- 287 unit tests across the extension host + webview (vitest + happy-dom + `@pinia/testing`).
- Coverage includes MCP schemas, bridge state transitions, scanner edge cases, project derivation heuristic, log ringbuffer, race conditions in cancel + max-runtime, atom variants, store getters.

### Known caveats

- **Bearer token in the output channel.** The token is printed plaintext on activation to make `claude mcp add-json` setup one-shot. It's stored encrypted in Secret Storage between sessions, but anyone reading the output channel (or a screenshot of it) sees the token. Don't share output-channel screenshots publicly. A `Copy MCP setup` command with redacted display is on the v0.2 backlog.
- **Context window can climb past 50–80%** while `cost=$0`. This is Anthropic's prompt caching at work — cache reads are ~10× cheaper but still occupy tokens. Feature of the SDK, not a bug of this plugin.
- **No MCP push for fan-in.** We use `wait_for_agents` long-poll, not MCP push notifications. Reason: Claude Code 2.1.x ships with the `tasks/*` handlers internally but doesn't advertise the capability in the MCP handshake, and `--channels` push is blocked by Anthropic's org policy. Long-poll aligns with [SEP-2663](https://github.com/modelcontextprotocol/specification/pull/2663) (merged 15 May 2026, also polling-based). Migration to native push is ~30 LOC when upstream enables the capability.
- **MCP tool selection requires explicit prompting.** As of May 2026, Claude Code's model selection tends to prefer native `Bash`/`Task` over custom MCP tools unless the user names the tool in the prompt. See [README.md → Usage](README.md#usage--invoking-the-orchestrator-from-a-chat) for a working prompt template and the recommended user-level `CLAUDE.md` directive.
- **Single detail panel instance.** Opening a different agent's detail disposes the current panel and opens a new one. Multi-instance with cap + LRU is on the v0.2 backlog.
- **No observability for chat-caller agents.** The dashboard shows only agents this plugin orchestrated (via `spawn_agents`). Task subagents and `Bash run_in_background` invocations from the calling chat are not visible. A FileSystemWatcher over `~/.claude/projects/` is on the v0.2 backlog to complement.
- **Large `.vsix` (~75 MB).** The bundled `@anthropic-ai/claude-agent-sdk` ships a native `claude` CLI binary (~227 MB pre-compression) that the extension invokes at runtime. This puts the packaged `.vsix` above the 50 MB Visual Studio Marketplace limit, so this release is **distributed via GitHub Releases only**. A v0.2 task tracks bundling/lazy-install strategies to slim the package for Marketplace eligibility.
- **First-run scan can take 60–90s.** On first install (or after clearing globalState) the scanner cold-reparses every `.jsonl` in `~/.claude/projects/`. With 150+ sessions across many projects, expect 60–90s before the dashboard fills with `All projects (N)`. Subsequent activations hit the mtime cache and complete in ~25s. The sidebar currently does not show a "Scanning…" indicator during the cold pass — that polish is on the v0.2 backlog. Watch the output channel for `[scanner] scan complete (startup) projects=N sessions=M`.
- **No "Scanning…" indicator in the sidebar during cold scan.** The dashboard simply shows `All projects (0)` and "No agents yet" until the first scan finishes. Watch the output channel if you want progress. A proper sidebar overlay is on the v0.2 backlog.

[0.1.0]: https://github.com/stevTresCloud/claude-orchestrator/releases/tag/v0.1.0
