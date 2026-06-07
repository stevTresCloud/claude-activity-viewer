# Third-Party Notices

`claude-orchestrator` incorporates ideas and patterns from the following open-source projects, and bundles the npm packages listed below. All licenses are compatible with this project's MIT license.

---

## Inspiration (no code copied)

### ai-beacon

- Repository: https://github.com/manusa/ai-beacon
- Author: Marc Nuri
- License: Apache-2.0
- Use: visual UX inspiration for the dashboard (agent cards layout, status indicators). No code copied (different stack: Go vs TypeScript).

### Claude-Code-Agent-Monitor

- Repository: https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- License: MIT
- Use: conceptual inspiration for the agent-board schema and event types. No code copied.

---

# Bundled npm dependencies

The packaged `.vsix` bundles the following npm packages. All licenses are compatible with this project's MIT license.

## Runtime dependencies

### vue

- Repository: https://github.com/vuejs/core
- License: MIT
- Use: webview UI framework (dashboard + detail panel).

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
- Use: schema validation for the Claude Code activity-hook events parsed by the ingester.

## Build-time dependencies (not bundled at runtime, but required to build the `.vsix`)

### typescript

- Repository: https://github.com/microsoft/TypeScript
- License: Apache-2.0
- Use: source language.

### vue-tsc

- Repository: https://github.com/vuejs/language-tools
- License: MIT
- Use: type-checking for Vue single-file components in the webview.

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
- Use: test runner (310 unit tests across extension host + webview).

### happy-dom

- Repository: https://github.com/capricorn86/happy-dom
- License: MIT
- Use: DOM implementation for webview tests under vitest.

### @pinia/testing

- Repository: https://github.com/vuejs/pinia
- License: MIT
- Use: store mocking helpers for vitest.
