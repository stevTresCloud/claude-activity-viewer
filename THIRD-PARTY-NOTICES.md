# Third-Party Notices

`claude-orchestrator` incorporates ideas, patterns, and code (clearly marked when copied) from the following open-source projects. All licenses are compatible with this project's MIT license.

---

## damocles

- Repository: https://github.com/AizenvoltPrime/damocles
- Author: Alexios Stefanopoulos
- License: MIT
- Use: cherry-picked execution engine (`AgentRunner`, parts of `TeamRunner`). Code copies will retain the upstream MIT notice in the file header.

---

## cli-agent-orchestrator (CAO)

- Repository: https://github.com/awslabs/cli-agent-orchestrator
- Author: AWS Labs
- License: Apache-2.0
- Use: conceptual inspiration for the MCP tool contract (`spawn_agents`, `cancel_agent`, etc.). No code copied.

---

## ai-beacon

- Repository: https://github.com/manusa/ai-beacon
- Author: Marc Nuri
- License: Apache-2.0
- Use: visual UX inspiration for the kanban dashboard (agent cards layout, status indicators). No code copied (different stack: Go vs TypeScript).

---

## Claude-Code-Agent-Monitor

- Repository: https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- License: MIT
- Use: conceptual inspiration for kanban schema and event types. No code copied.

---

## @anthropic-ai/claude-agent-sdk

- Repository: https://github.com/anthropics/claude-agent-sdk-typescript
- License: see upstream
- Use: runtime dependency. Official Anthropic SDK.
