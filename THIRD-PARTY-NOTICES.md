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

---

# Bundled npm dependencies

The packaged `.vsix` bundles the following npm packages. All licenses are compatible with this project's MIT license.

## Runtime dependencies

### @modelcontextprotocol/sdk

- Repository: https://github.com/modelcontextprotocol/typescript-sdk
- License: MIT
- Use: HTTP transport + tool registration for the embedded MCP server.

### vue

- Repository: https://github.com/vuejs/core
- License: MIT
- Use: webview UI framework (kanban dashboard + detail panel).

### pinia

- Repository: https://github.com/vuejs/pinia
- License: MIT
- Use: state store for the webview (agents store + scanner store).

### @vscode/codicons

- Repository: https://github.com/microsoft/vscode-codicons
- License: MIT (icon font), CC-BY 4.0 (icon designs)
- Use: VS Code icon font (check, warning, chevron, etc.) bundled with the webview.

### zod

- Repository: https://github.com/colinhacks/zod
- License: MIT
- Use: input schema validation for MCP tool arguments.

## Build-time dependencies (not bundled at runtime, but required to build the `.vsix`)

### typescript

- Repository: https://github.com/microsoft/TypeScript
- License: Apache-2.0
- Use: source language.

### esbuild

- Repository: https://github.com/evanw/esbuild
- License: MIT
- Use: bundler for the extension host (CJS output).

### vite

- Repository: https://github.com/vitejs/vite
- License: MIT
- Use: bundler for the webview (ESM output, asset pipeline).

### @vitejs/plugin-vue

- Repository: https://github.com/vitejs/vite-plugin-vue
- License: MIT
- Use: Vue 3 SFC support for the webview build.

### tailwindcss + @tailwindcss/vite

- Repository: https://github.com/tailwindlabs/tailwindcss
- License: MIT
- Use: utility-first CSS for the webview, with `@theme` referencing VS Code CSS variables for live theme inheritance.

### vitest

- Repository: https://github.com/vitest-dev/vitest
- License: MIT
- Use: test runner (287 unit tests across extension host + webview).

### happy-dom

- Repository: https://github.com/capricorn86/happy-dom
- License: MIT
- Use: DOM implementation for webview tests under vitest.

### @pinia/testing

- Repository: https://github.com/vuejs/pinia
- License: MIT
- Use: store mocking helpers for vitest.
