# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Cambios posteriores al tag `v0.3.0`, sin nueva versión publicada (uso personal).

### Changed

- **Renamed to Claude Activity Viewer.** The project's public name now matches what it does: a read-only viewer, not an orchestrator. The display name, command titles, settings namespace (`claudeOrchestrator.*` → `claudeActivityViewer.*`), output channel, status-bar entry and the GitHub repository (`claude-orchestrator` → `claude-activity-viewer`) all use the new name. The hook spool directory moved from `~/.claude/claude-orchestrator/` to `~/.claude/claude-activity-viewer/` — reinstall the global activity hooks (`Uninstall` then `Install`) so the dashboard keeps receiving events.

### Fixed

- **Cancelled / interrupted agents no longer linger as "running".** When a sub-agent is interrupted (e.g. Esc), Claude Code emits no `SubagentStop`, so the agent stayed in `NOW PLAYING` until the next IDE restart. Two complementary mechanisms now close it:
  - **Event-driven:** the ingester reconciles still-running agents on their session's `Stop` (end of turn) and `SessionEnd`, marking them `cancelled` (honest `—` duration). Agents still running in the background (reported in `Stop.background_tasks`) are skipped so they are not closed prematurely.
  - **Time-based backstop:** a periodic sweep cancels any `running` agent that has emitted no activity for `claudeActivityViewer.staleAgentSec` seconds (default 20) — covering sessions that never emit a prompt `Stop`. If the agent resumes emitting activity it is revived automatically. Set the value to 0 to disable the sweep.

### Added

- **`claudeActivityViewer.staleAgentSec` setting** (default 20) — inactivity window before a still-running agent is reconciled to `cancelled`.

## [0.3.0] — 2026-06-07

**Pivot to a read-only activity viewer.** v0.1 and v0.2 were an *orchestrator*: an embedded MCP server that spawned, waited on, verified and cancelled Claude Code agents. That role is now better served by Claude Code natively, so the project re-focuses on the part that has lasting value — **observability**. v0.3 watches the agents Claude Code already runs, via its activity hooks, and never spawns or drives them.

The orchestrator line is preserved and remains installable at tag `v0.2.0`.

### Added

- **Hooks-driven ingester.** A global hook forwarder (`SubagentStart` / `SubagentStop` / `Stop` / `SessionEnd`) spools NDJSON events that the extension tails and translates through a per-agent state machine into the dashboard store. Installed once via the `Install global activity hooks` command; removable via `Uninstall global activity hooks`.
- **Liveness reconciliation.** Running agents pulse while active and are flagged idle (without leaving the board) when they stop emitting activity. Orphaned agents left "running" by an IDE restart are reconciled. Finished agents show an honest duration (`—` instead of a fake `0s` when no real start was observed).
- **Detail panel reads the transcript.** Opening an agent's detail panel reads `model`, token usage and context% on demand from the session `.jsonl` transcript, with graceful degradation (bars hide) when the data is absent.
- **Grouping by `project · session · directory`** with a short session id and branch in each group header.
- **Completion toast** when an agent reaches a terminal state, with a shortcut to its detail panel.

### Removed

- The embedded **MCP server** and all orchestration tools (`spawn_agents`, `wait_for_agents`, `list_agents`, `get_agent_log`, `cancel_agent`), the `@anthropic-ai/claude-agent-sdk` runner, bearer auth, and the agent-cancel UI.
- **Verification mechanisms D + A** (structured-exit parsing and the Haiku critic) — they only made sense for an orchestrator that drove the agents. The `claudeActivityViewer.verification` and `claudeActivityViewer.cancelConfirm` settings are gone.
- The `~75 MB` bundle: with the SDK/CLI runner removed, the `.vsix` is now small (no bundled binary).

### Toolchain

- `vue-tsc` is pinned and wired into the build (`npm run typecheck` runs `tsc` for the extension and `vue-tsc` for the webview); the `package` step now typechecks before producing the build that feeds `vsce`.

## [0.2.0] — 2026-05-28

Second v0.2 milestone — **Mecanismo D + A safety net**. Closes ticket #1 of the v0.2 backlog, driven by `research/VERIFICATION_MECHANISMS.md` (incident pattern observed during portforward v16→v19: 1 silent assertion flip + 1 SQL column from a stale schema that survived the agent's self-reported success criteria). The two mechanisms work as one unit: D forces the agent to declare decisions/uncertainties in a structured exit JSON; A spawns a Haiku critic post-fan-in that reviews the actual diff and flags what the agent omitted.

### Added

#### Mecanismo D — Structured exit (parse + auto-promote)

- New `claudeActivityViewer.verification` setting: `'none' | 'structured' | 'critic' | 'both' | 'human-review'`. Default `'structured'` (D-only at zero runtime cost). `'human-review'` accepted for forward-compat but behaves identical to `'both'` in v0.2.0 — the modal pause panel is roadmapped for v0.2.1+.
- The bridge appends an exit-schema instruction block to every prompt when verification mode requires it (`structured` / `both` / `human-review`). The instruction asks the agent to emit a fenced JSON block at the end with `status / files_changed / evidence_run / decisions_made_without_consultation / uncertainties` plus 4 anti-rationalization rules (e.g. "self-rationalizing the decision as 'obviously correct' does not exempt you").
- New helper module `src/runtime/exit-schema.ts` with `EXIT_SCHEMA_V1` (Zod), `parseExitSchema(text)` (tolerant: handles last-fence-wins, plain fence, bare object fallback, 2 MB truncate), and `buildExitSchemaInstruction()` for the prompt block.
- Bridge promotes status `done` → `needs_review` when the agent declared `decisions_made_without_consultation` OR `uncertainties` non-empty. Emits `agent_status_changed` with `metadata.verificationPromoted: true` so the UI updates immediately.

#### Mecanismo A — Critic Haiku post-fan-in

- After `wait_for_agents` resolves (and the wait did NOT time out), the bridge spawns one Haiku critic per terminal agent whose verificationMode is `critic` / `both` / `human-review`. Critics run in parallel via `Promise.all` and each receives the original agent's snapshot + exit report + a captured working-tree diff.
- Critic toolset is allow-listed: `['Read', 'Bash', 'Grep', 'Glob']` (no `Write` / `Edit` / `NotebookEdit`). Allow-list enforced via new optional `AgentRunConfig.tools: string[]` field consumed by `agent-runner.ts` when present (overrides the default `preset: 'claude_code'`).
- Critic prompt (`buildCriticPrompt` in `exit-schema.ts`) instructs the critic on what to flag (assertion flips, SQL referencing unvalidated columns, tests replaced rather than added, silent removals of guards) AND **what NOT to flag** (purely additive helpers, empty `evidence_run` for trivial additions, style suggestions, speculative future risks). The "what NOT to flag" block was added after a smoke E2E showed the critic was over-eager on benign tasks — calibration brings critic costs from ~$0.06 to ~$0.03 per agent on additive changes.
- Diff capture: `captureCriticDiff(cwd, headBefore)` is async (manual `new Promise` wrap over `child_process.execFile`, not `util.promisify` — promisify depends on a Node-internal symbol that mocks lack). Runs `git diff <headBefore>` (working tree vs commit, **not** `<headBefore>..HEAD` — the latter would always be empty because Claude agents don't commit, only mutate working tree). Truncated to 500 KB with explicit suffix when over.
- Critic timeout: 90s `AbortController`. On timeout, a synthetic `{severity: 'low', summary: 'critic_timeout'}` flag is added to `critic_findings` for diagnostic visibility but does NOT promote — synthetic low-severity flags from infra failures (`critic_timeout`, `critic_no_output`, `critic_invalid_json`, `critic_schema_violation`, `critic_runner_error`) are filtered out of the promotion logic. Only `high` / `med` severity flags (real findings from Haiku) cause promotion.
- `headBefore` captured at spawn via `readGitHead(cwd)` (new exported helper, same shape as `readGitBranch` but for `git rev-parse HEAD`).

#### New wire types

- `AgentStatus` extended with `'needs_review'` as a 5th terminal state. Centralized via new exported constant `TERMINAL_STATUSES` + predicate `isTerminalStatus(s)` — SSoT for the bridge `emitStatusChange` invariant, the store `recent` filter, and `runWait` pending detection. Adding a future terminal state (e.g. `'rejected'`) only requires extending the constant.
- `WaitForAgentsAgentResult.verification?: VerificationReport` — new optional block in the MCP wire-out, contains: `mode`, `exit_report?` (if D parsed successfully), `exit_parse_reason?` (stable code: `no_input | no_json_block | invalid_json | schema_violation`), `critic_findings?: CriticFinding[]`, `critic_cost_usd?`, `critic_duration_ms?`, `auto_promoted_reason?` (string: `'decisions'` / `'uncertainties'` / `'critic_flags'` / `'decisions+critic_flags'` etc.).
- `AgentSnapshot` extended with 3 verification-UI fields: `verificationMode?`, `verificationReviewed?`, `verificationPromoted?` — drive the new badge in `AgentCardRecent`.

#### Verification badge UI

- New atom `src/webview/components/atoms/VerificationBadge.vue` rendered inline in `AgentCardRecent`. 3 variants:
  - `verifying…` (italic, gray-muted) — shown while the critic is running post-wait.
  - `✓ Haiku OK` (green) — verification ran, no promotion.
  - `⚠ Flagged` (orange) — D auto-promoted (decisions/uncertainties) OR A emitted real flags.
- `AgentCardRecent` also gained:
  - `'needs_review'` entry in `STATUS_PRESENTATION` (orange stripe + `codicon-eye` icon).
  - `needs_review` joins the `done` branch in the meta formatter (shows tokens + cost since the agent did billable work).
- `useAgentsStore.recent` filter uses `isTerminalStatus(a.status)` so `needs_review` agents land in the RECENT section.

#### Structured verification log

- Every verification event emits a JSON-parseable log line to the `Claude Activity Viewer` Output channel:
  ```
  [HH:MM:SS] [verification] {"event":"parse"|"critic_spawn"|"critic_done"|"critic_error"|"promote", ...}
  ```
  Enables post-mortem inspection of the D/A flow without instrumenting external analytics.

### Fixed

- **Working-tree diff bug**: `captureCriticDiff` initially invoked `git diff <headBefore>..HEAD` which compares two commits. Since Claude agents mutate working tree without committing, HEAD never moved and the diff was always empty — the critic Haiku effectively saw nothing. Switched to `git diff <headBefore>` which compares working tree to commit. Exposed by smoke E2E "happy path" run that showed `critic_findings: []` with anomalously high critic cost; verified by adversarial smoke that now produces 4 concrete findings for an `assertTrue → assertFalse` flip.
- **Synthetic-low flags caused false positives**: the original promotion logic was "any finding promotes". Combined with synthetic flags from parser fallbacks (`'critic output violated schema'` etc.), benign agents were incorrectly promoted to `needs_review`. Promotion now filters to `severity in ('high' | 'med')` only. Synthetic infra flags remain visible in `critic_findings` for diagnostic purposes.
- **`emitStatusChange` invariant gap**: the "once terminal, never back to running" guard checked only `done / failed / cancelled` literally — adding `needs_review` exposed the latent drift risk (a late SDK event could overwrite `needs_review` back to `running`). Migrated to `isTerminalStatus()` so the guard auto-extends for future terminal states.

### Changed

- `runWait` (private, in `bridge.ts`) is now async and orchestrates 4 steps: wait-for-terminal listener → eager D-parse per agent → critic spawn (parallel) → mark verificationReviewed → buildWaitResult. The previous synchronous structure remains for the cheap path (all agents already terminal at call time), now unified inside `runWait`.
- `captureCriticDiff` returns `Promise<{diff, truncated}>` (was synchronous). The async form ensures the N parallel critic spawns in `runCriticsForBatch` don't block the event loop on `execFileSync`, which silently serialized the parallel `Promise.all` despite the wrapper. Real savings on heavy batches: ~0.8–3.2s per fan-in with N ≥ 5 critics.
- `parseExitForStored` now calls `schedulePersist()` after mutating `stored.exitReport` / `stored.exitParseReason` — aligns with the existing invariant that every state mutation in `bridge.ts` is durable across reloads.

### Tests

- +24 in `src/runtime/__tests__/exit-schema.test.ts`: `parseExitSchema` happy + 4 failure modes + truncate + extra fields tolerance + last-match-wins; `parseCriticOutput` happy + 4 synthetic fallbacks; `buildCriticPrompt` + `buildExitSchemaInstruction` content assertions; `CRITIC_TOOL_ALLOWLIST` excludes Write/Edit.
- +24 in `src/dashboard/__tests__/bridge.test.ts` covering: `isTerminalStatus` predicate (4 tests), `readGitHead` + `captureCriticDiff` async (8 tests including no-`..HEAD` regression guard), verification flows (mode `none`/`structured`/`critic`/`both`, lock-at-spawn, invalid setting → default, auto-promote via decisions/uncertainties, critic high/med promotes, synthetic low does NOT promote, critic timeout fallback, snapshot fields, agent_status_changed metadata propagation).
- Total: **414 tests passing** (was 358 at v0.2.0-pre.1).

### Known issues / deferred to v0.2.1+

- Critic `Bash` tool: the allow-list permits Bash for read-only inspection (`git log`, `grep`, `cat`) but Bash can technically write files via shell redirection. The critic prompt explicitly prohibits write commands. In v0.3+ we plan a SDK-level `read_only` preset.
- Critic findings vs agent card: the critic Haiku runs as an opaque sub-agent, NOT visible in the dashboard as its own card. The `VerificationBadge` is the only sidebar surface. v0.3+ may surface the critic as its own card with a "discussion thread" relationship to the original agent.
- `notifyCompletion` toast fires before promotion (e.g. "finished" toast appears for an agent that gets promoted to `needs_review` moments later). UX inconsistency, no functional risk.
- `auto_promoted_reason` is a `+`-joined string (`'decisions+critic_flags'`). If a future downstream consumer needs structured access, migrating to `string[]` is a breaking wire change deferred to v0.3.

## [0.2.0-pre.1] — 2026-05-28

First v0.2 milestone — **transport robustness + critical papercuts**. Closes ticket #0 of the v0.2 backlog, driven by `research/V0_1_0_FIELD_REPORT.md` (3 transport drops + 4 papercuts observed in the first productive use on 2026-05-27 night).

### Added

#### Idempotency for `wait_for_agents`

- Server-side `SharedWaiter` cache keyed by `sha-stable(sortedAgentIds)`. When a second `wait_for_agents` arrives for the same set within the 30-min TTL, it **fans in** to the same in-flight Promise instead of starting a parallel waiter. Survives transport drops mid-call: the model re-invokes with the same `agent_ids` and resumes the long-poll from where it was.
- LRU cap of 32 active waiters; FIFO eviction with cascade cleanup of timer + degraded-state entries.
- Tool description warns the model: re-invoke on `"transport dropped mid-call"` errors instead of abandoning; second-call `timeout_sec` is ignored (the first call's value wins).

#### Transport resilience (HTTP)

- `Connection: keep-alive` + `Keep-Alive: timeout=1200, max=1000` headers per request to make long-polls tolerant of intermediate-proxy idle disconnects.
- `socket.setKeepAlive(true, 15s)` + `socket.setTimeout(0)` on each authenticated request — TCP probes every 15s keep the socket alive against silent kernel/middleware reaps; idle timeout disabled to support the full 1200s long-poll window.
- Defensive `?.` guards on the socket calls to survive aborted-before-handler clients.

#### Transport health heuristic (opt-in)

- New `transportState: 'healthy' | 'degraded'` derived from per-waiter timers. When any `wait_for_agents` is alive >60s without resolving, the bridge marks the transport as `degraded` and broadcasts `transport_state_changed` to all webviews.
- New setting `claudeActivityViewer.showTransportState` (default `false`, opt-in until validated in productive use): when enabled, a yellow banner appears at the top of the dashboard sidebar with copy *"Transport may be slow — agents still running. Re-invoke wait_for_agents from chat to resume the long-poll."* Banner inherits `--color-warning` so it adapts to light/high-contrast/custom VS Code themes.
- Replay on `attachWebview`: a newly-opened sidebar receives the current state immediately (not just transitions).

#### `get_agent_log` filters for efficient reads

- New optional args: `tail_lines` (1–2000) and `kinds_filter` (`['text'|'thinking'|'tool_use'|'tool_result'|'usage']`). Pipeline applies `kinds_filter` → `since` → `tail_lines`.
- Tool description advertises the efficient mode: `kinds_filter: ['text'] + tail_lines: 50` reduces a 462 KB output to ~10 KB for the typical "show me the agent's final report" use case. Default (no args) preserves legacy compatibility (full ringbuffer).

#### Cost UX

- `costUsd` chip in the detail panel now renders `"computing…"` italic dim while the agent is `running` and the value is still 0/undefined (the SDK only exposes `total_cost_usd` in the final `result` event, so mid-run rendering `$0.00` was misleading). Terminal states preserve `"$0.00"` literal for legitimately-zero runs.

#### ContextBar UX

- Tooltip explains the metric: *"Percentage of the model context window used (input + cache read + cache creation). Prompt caching from Anthropic lets this go past 50% with near-zero cost — that is a feature of the platform, not a bug."*
- New preventive color band: success <60% → warning yellow <85% → orange 85–95% → error red ≥95%. Helps users recognize the "close to limit" state before auto-truncate triggers.

### Fixed

- **`contextTokens` reported as 10.9M** (V0_1_0_FIELD_REPORT.md §4): the `AgentEvent` union was split from a single `'usage'` variant into `'usage_turn'` (per-turn, gauge semantics) and `'usage_final'` (cumulative at SDK `result`, billable semantics). The bridge consumes them differently:
  - `usage_turn` → updates `contextTokens` / `contextUsedPct` (gauge of the active turn's context) and `tokensUsed` (per-turn delta).
  - `usage_final` → updates `tokensUsed` to the cumulative cross-turn total (billable) and `costUsd` to the SDK's authoritative value; does **not** overwrite `contextTokens` because the SDK reports cumulative cache reads there which can exceed 200k (the historical 10.9M bug).
  - Fallback: if `usage_final` arrives without any preceding `usage_turn` (error-only / cached-only short runs that never emit an assistant message), the cumulative tokens are used to populate `contextTokens` as a best-effort estimate.
- **`tokensUsed` regression in RECENT cards** (caught by code-review stage 1): the terminal-block fallback `lastTokensUsed || result.inputTokens + result.outputTokens` was being bypassed because `usage_turn` set `lastTokensUsed` to a per-turn delta (non-zero, truthy). Long agents would report e.g. `5k` (last turn) instead of `150k` (cumulative). Fix: `usage_final` now updates `lastTokensUsed` with the cumulative value.
- **LRU eviction broke `waiterCache ↔ waiterDegradedState` invariant** (caught by code-review stage 2): the evicted waiter's `.finally` could later delete a new waiter's degraded-state entry under the same key. Fix: identity guard `waiterCache.get(key) === waiter` gates the entire cleanup, and the LRU branch proactively clears the degraded-state entry of the evicted waiter.
- **Detail panel was not receiving feature flags** (caught by code-review stage 2): `dashboard.ts` injected `flags.showTransportState` via `WebviewBootConfig` but `detail-panel.ts` did not — a trap for any future component that reads the flag from outside the sidebar. Now both injectors are symmetric.
- **Toolbar warning banner used hardcoded `rgb(255 193 7 …)` literals** instead of `--color-warning`. Replaced with `color-mix(in srgb, var(--color-warning) <alpha>%, transparent)` so the banner adapts to all VS Code themes.

### Changed

- `formatCostUsd(n, status?)` accepts an optional `AgentStatus` (typed from `dashboard-protocol.ts`, not inlined) to render the `"computing…"` placeholder when running with `n=0|undefined`.
- `bridge.getAgentLog(agentId, opts?)` accepts an options object `{since?, tailLines?, kindsFilter?}` instead of a single `since` positional argument. The MCP server passes through the new optional fields. Internal callers updated.
- `bridge.waitForAgents()` is now a sync method that returns `Promise<WaitForAgentsResult>` (not `async`) — this preserves Promise referential identity for the idempotency fan-in. With `async`, the JS engine wraps the return value in a fresh Promise and breaks `p1 === p2` checks.
- `runWait` (private helper extracted from `waitForAgents`) resolves directly to `WaitForAgentsResult` (was `boolean → .then`).
- `transportDegradedTimers` Map + `degradedWaiters` Set collapsed into a single `waiterDegradedState: Map<string, NodeJS.Timeout | null>` (where `null` means "timer fired, waiter is degraded"). Half the cleanup branches, single source of truth.

### Tests

- 30 new vitest tests (358 total, up from 328):
  - Idempotency: fan-in identity, key stability across input order, post-resolve cache miss, second-caller `timeoutMs` ignored, TTL expiry forces fresh waiter.
  - `transportState`: replay on attach, transition healthy→degraded after threshold, no-transition when waiter resolves fast.
  - `usage_final` separation: cumulative tokens populate `tokensUsed` but **not** `contextTokens` after a `usage_turn` ran first; cumulative populates both as fallback when no `usage_turn` preceded.
  - `getAgentLog` filters: `tail_lines`, `kinds_filter`, both combined (filter→tail), legacy default (no opts).
  - Zod schema bounds: `tail_lines` 1–2000, `kinds_filter` enum + non-empty array.
  - `http-transport`: keep-alive headers applied, `setKeepAlive(true, 15s)`, `setTimeout(0)`, hooks skipped on 404/401 short-circuits.
  - `formatCostUsd`: `running` + 0/undefined → `"computing…"`; running with real value → formatted; terminal states → literal `$0.00`.

### Internal

- New file `src/mcp/__tests__/http-transport.test.ts`.
- `OrchestratorHttpServer.handleRequest()` exposed as `public` to enable direct testing (ESM blocks `vi.spyOn(http, 'createServer')`).

---

## [0.1.0] — 2026-05-27

First public release. The extension exposes an embedded MCP server with 5 tools, a live kanban dashboard, real cancel, long-poll fan-in, session resume, and a detail panel — all driven from any external Claude Code chat.

### Added

#### MCP server

- HTTP server embedded in the extension host, listening on `http://127.0.0.1:39127/mcp`.
- Bearer token auth (256-bit random, persisted in VS Code Secret Storage, timing-safe comparison).
- **Auto-register** in `~/.claude.json` on activation (merges with existing MCP servers, atomic write, idempotent). Opt-out via `claudeActivityViewer.autoRegisterMcp = false`. Palette command `Claude Activity Viewer: Register MCP in Claude Code` re-runs the merge manually. Manual `claude mcp add-json` fallback still printed to the output channel on every activation.
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
- Project groups inside each section, derived from `cwd` vs `claudeActivityViewer.projectsRoot` + workspace folders.
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
- Optional confirmation modal (`claudeActivityViewer.cancelConfirm`).
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
- Toggle via `claudeActivityViewer.notifyOnComplete` (default `true`).

#### Model selection

- Per-task model in `spawn_agents` (`sonnet`, `opus`, `haiku`).
- Tool description nudges the chat model to ask the user when not specified, especially before expensive long-running tasks.
- Setting `claudeActivityViewer.defaultModel` for the fallback when `model` is omitted.
- Real model id captured from `SDKSystemMessage.init.model` (e.g. `claude-sonnet-4-5-20251022`) and pretty-printed in `ModelBadge` (`Sonnet 4.5`).
- QuickPick on the palette command `Claude Activity Viewer: Test Agent`.

#### Context bar

- Live tokens captured incrementally from `SDKAssistantMessage.message.usage` on every turn (not just on final result).
- `contextTokens = input + cacheRead + cacheCreation` — matches the percentage shown in the bar (previously inconsistent because most context travels via prompt cache).
- Separate `tokensUsed` field preserved as the billable per-turn cost (without cache reads).

#### Defensive caps

- `claudeActivityViewer.maxAgentRuntimeSec` (default 2000s) — hard cap on agent lifetime, bridge cancels with `reason=max_runtime_exceeded`. Race-safe against manual cancel.
- `claudeActivityViewer.stuckDetectionSec` (default 60s) — if a running agent emits no events for N seconds, `wait_for_agents` flags `suspected_stuck=true` in `pending`. Does not cancel — the chat decides.

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

[0.1.0]: https://github.com/stevTresCloud/claude-activity-viewer/releases/tag/v0.1.0
