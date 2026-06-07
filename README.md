# Claude Orchestrator

> A read-only activity viewer for your Claude Code agents. Whenever Claude Code spawns sub-agents, they show up live in a VS Code sidebar — model, context usage, status and recent sessions — without leaving the editor.

## What it does

When you work in Claude Code, a single chat often fans out into several sub-agents — one exploring the repo, one running tests, one searching for a pattern. They run, finish, and disappear into the transcript.

**Claude Orchestrator gives them a window.** It listens to Claude Code's own activity **hooks** and renders every sub-agent in a sidebar dashboard: what's running now, what's queued, what just finished, grouped by project and session. Click any agent to open a detail panel with its live log plus the model, token count and context usage read straight from the session transcript.

It's **read-only** — it observes, it never spawns, cancels or drives agents. Nothing about your Claude Code workflow changes; you just gain visibility into it.

## Why use it

- **See your sub-agents.** A live `NOW PLAYING / UP NEXT / RECENT` board for every agent Claude Code launches, grouped by project, session and working directory.
- **Know what each agent is doing.** Per-agent detail panel with the streaming log (thinking, tool calls, tool results) and the model + tokens + context% pulled from the transcript.
- **Spot stalls.** Running agents pulse while active; an agent that goes quiet for a while is flagged as idle without being dropped from the board.
- **Pick up past work.** A scanner reads your `~/.claude/projects/` history and lets you resume a past session in the Claude Code chat or a new terminal.
- **Stay in the editor.** A status-bar count of running agents, and a toast when each one finishes.

## Install

1. Download `claude-orchestrator-0.3.0.vsix` from [Releases](https://github.com/stevTresCloud/claude-orchestrator/releases).
2. Install it: `code --install-extension claude-orchestrator-0.3.0.vsix` (or right-click the `.vsix` in VS Code → *Install Extension VSIX*).
3. Reload VS Code.
4. Run **`Claude Orchestrator: Install global activity hooks`** from the Command Palette (`Ctrl+Shift+P`). This is a one-time step — it writes the activity hooks into your global `~/.claude/settings.json` so every Claude Code session streams its agents into the dashboard.

> *Prerequisites: [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude login`). VS Code 1.120+, Node 22+.*

## First view (60 seconds)

1. Open the **Claude Agents** view from the Activity Bar — the dashboard sidebar appears.
2. Start a Claude Code session that spawns sub-agents. For example, in any Claude Code chat:

   > *Lanza 3 subagentes en paralelo (read-only): uno que mapee la estructura del repo, uno que busque los TODO/FIXME, uno que resuma los archivos de config.*

3. Watch `NOW PLAYING` fill with the running agents — pulsing, grouped under their project and session.
4. Click any card to open its detail panel (an editor tab) with the live log and the model / tokens / context% from the transcript.
5. When they finish, they move to `RECENT` with their real duration.

## What's inside

- **Sidebar dashboard** — `NOW PLAYING / UP NEXT / RECENT`, grouped by `project · session · directory`, with a short session id and branch in each group header.
- **Liveness indicator** — running agents pulse; one that stops emitting activity is marked idle (without leaving the board); finished agents show their honest duration.
- **Detail panel** in an editor tab — per-agent streaming log (thinking, tool calls, tool results) plus `ModelBadge`, token count and a context-usage bar, all read on demand from the session transcript.
- **Completion toast** — an optional notification when an agent reaches a terminal state, with a shortcut to open its detail panel.
- **Session scanner** — parses your `~/.claude/projects/*.jsonl` history into the `RECENT` lane and offers to **resume** past sessions in the chat or a new terminal.
- **Status bar** — a live count of running agents (click to focus the dashboard).

## Configuration

Settings live under `File → Preferences → Settings → Extensions → Claude Orchestrator`. The defaults are sensible — touch these only if you're tuning.

| Setting | Default | What it does |
|---|---|---|
| `claudeOrchestrator.projectsRoot` | `[]` | Absolute paths whose direct subfolders are treated as projects, used to derive project/task labels from each agent's working directory. Tildes are expanded. |
| `claudeOrchestrator.scannerRefreshSec` | `0` | Auto-refresh interval (seconds) for the project + session scanner. `0` = manual rescan only (recommended with many projects). |
| `claudeOrchestrator.resumeIn` | `"chat"` | Where to open a resumed session: `"chat"` (Claude Code sidebar) or `"terminal"`. |
| `claudeOrchestrator.resumeConfirm` | `false` | Confirmation dialog before resuming a past session. |
| `claudeOrchestrator.notifyOnComplete` | `true` | Toast when an agent reaches a terminal state. |
| `claudeOrchestrator.ingesterDebug` | `false` | Log every translated agent event from the hook stream to the output channel (verbose diagnostics only). |

## How it works

```
Claude Code session ──hooks──▶ NDJSON spool ──tail──▶ ingester (translator)
                                                          │
                                       ┌──────────────────┘
                                       ▼
                              read-only store (bridge) ──postMessage──▶ Vue sidebar
                                                                            ▲
~/.claude/projects/*.jsonl ──session scanner──────────────────────────────┘ (RECENT / resume)
```

The activity hooks (`SubagentStart` / `SubagentStop` / `Stop` / `SessionEnd`) append events to a spool file; the extension tails it, translates each event through a per-agent state machine, and feeds a read-only store that the Vue dashboard renders. The session scanner is an independent pipeline that reads your past `.jsonl` transcripts for the `RECENT` lane and resume. Per-agent metrics (model, tokens, context%) are read from the transcript on demand when you open a detail panel.

<details>
<summary><b>Build from source</b></summary>

```bash
git clone git@github.com:stevTresCloud/claude-orchestrator.git
cd claude-orchestrator
npm install
npm run compile      # bundle extension + webview
npm run typecheck    # tsc (extension) + vue-tsc (webview)
npm test             # vitest
npm run package      # typecheck + production build (input to vsce)
```

In VS Code, press `F5` to launch an Extension Development Host with the extension loaded.

</details>

## Caveats

- **Single detail panel at a time.** Clicking a different agent replaces the current detail panel; multi-panel side-by-side is on the roadmap.
- **No cost figure.** The viewer reads the transcript, which carries token usage but not a dollar cost, so per-agent cost is not shown.
- **First scan latency.** With many past Claude Code sessions the first scan can take a while; subsequent activations hit a cache.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Dashboard UX inspired by [manusa/ai-beacon](https://github.com/manusa/ai-beacon) (Apache-2.0); the agent-board schema is informed by [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) (MIT).

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for bundled software.
