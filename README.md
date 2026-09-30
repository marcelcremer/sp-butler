# SP Butler

A [Super Productivity](https://super-productivity.com) plugin for managing tasks in natural language. It talks to any **OpenAI-compatible endpoint** (`/chat/completions` with tool calling, optionally `/embeddings` and `/rerank`).

## Stage 1 – features

| Use case | Example | Tools |
| --- | --- | --- |
| Create tasks in natural language | "Tire change tomorrow, 30 minutes, project Car" | `propose_create_tasks` |
| Split a brain dump | Paste a paragraph → several tasks with subtasks | `propose_create_tasks` |
| Ask about the list | "What is due this week?", "What is still open in project X?" | `search_tasks`, `get_task` |
| Bulk changes | "Move everything from today to Friday", "Mark the three shopping tasks as done" | `search_tasks` → `propose_update_tasks` |

Supported fields: title, project, tags, notes, time estimate, due day, parent (subtasks), plus done status and moving between projects.

**Nothing changes without confirmation.** Write tools only create a *proposal*. The UI shows it as a checklist (with a diff for changes), and only "Apply" executes the selected items.

The butler replies in the language the user writes in. The UI is available in English and German.

## Installation

```bash
npm ci
npm run build        # → dist/sp-butler-<version>.zip
```

In Super Productivity: **Settings → Plugins → Choose plugin file** and upload the ZIP. Then open the "SP Butler" panel in the right sidebar and configure it under *Settings*:

| Setting | Default | Note |
| --- | --- | --- |
| Base URL | `https://ai-2.1nt.eu/v1` | any OpenAI-compatible endpoint |
| API key | – | stored locally in the secret store, **never synced** or exported |
| Chat model | – | required, must support tool calling |
| Embedding model | – | optional, enables semantic search |
| Rerank model | – | optional, improves the order of search results |
| Temperature / tool rounds / timeout | 0.2 / 8 / 90 s | |
| Custom instructions | – | e.g. "Always put groceries into the Household project" |

"Test connection" calls `/models` and fills the model suggestions.

There is also a shortcut **"Open SP Butler"**; assign a key under Settings → Keyboard shortcuts → Plugin shortcuts.

### CORS

Requests are sent with `fetch` directly from the app (web/desktop), so the endpoint must allow CORS (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type`). LiteLLM, vLLM and Ollama support this, some by default. If the connection fails with "Network error", missing CORS headers are the most likely cause.

Why not `PluginAPI.request`? The host only allows hosts listed in the manifest's `allowedHosts`, which rules out a freely configurable base URL, and CORS applies there in the browser as well.

## Architecture

```
┌──────────── index.html (iframe, side panel) ─────────────┐
│ chat · proposal cards · settings                          │
└──────────────┬────────────────────────────────────────────┘
               │ postMessage (PLUGIN_MESSAGE → PluginAPI.onMessage)
┌──────────────▼──────────── plugin.js (host) ──────────────┐
│ main.ts        message router, shortcut, sync hook         │
│ butler.ts      tool-calling loop, sessions, history        │
│ prompt.ts      system prompt with calendar, projects, tags │
│ tools.ts       search_tasks · get_task · propose_* (proposals only) │
│ proposal.ts    collect proposals → apply after confirmation │
│ search.ts      filters + keyword → embeddings → rerank     │
│ llm-client.ts  /chat/completions · /embeddings · /rerank · /models │
│ settings.ts    settings (synced) + API key (secret)        │
└────────────────────────────────────────────────────────────┘
```

Design decisions:

- **LLM calls run in `plugin.js`, not in the iframe.** Only the host side can access `getSecret`, so the API key never reaches the UI.
- **Short task references** (`t1`, `t2`, …) instead of the long ids. This saves tokens and makes model typos detectable (unknown ref → error back to the model, which corrects itself).
- **Calendar in the prompt.** The next 14 days are listed with weekdays ("2026-10-02 Friday"), because LLMs often get weekday arithmetic wrong.
- **Semantic search in stages.** Without extra models there is keyword search with prefix matching ("shop" ≈ "shopping"). An embedding model adds cosine similarity (vectors cached per task), a rerank model re-sorts the top 40. If an endpoint fails, the previous stage keeps working.
- **Rescheduling keeps the time of day.** Tasks with a fixed time (`dueWithTime`) keep it when moved to another day.
- **UI in the style of [shadcn/ui](https://ui.shadcn.com), without React.** The color tokens (dark mode) come from shadcn's `globals.css`; the components (button, card, badge, checkbox, input, tabs, message/bubble, empty state) are rebuilt as plain CSS in `src/ui/styles.css`; icons are Lucide SVGs. Super Productivity's UI kit is disabled via `"uiKit": false` so it cannot override the styles.
- **Robust against model mistakes.** Tool arguments are validated. Errors go back to the model as tool results, for bulk changes per item.

### Translations

`src/i18n/en.json` and `src/i18n/de.json` are the single source of all user-facing text. The build ships them as `i18n/` in the ZIP (declared in the manifest), where Super Productivity loads them:

- `plugin.js` uses `PluginAPI.translate()` (snackbar messages, shortcut name, error messages). Modules throw a `LocalizedError` with a key and parameters; `main.ts` translates it.
- The iframe only has an async `translate()` over the message bridge, so the UI bundles the same files, asks the host for the language via `getCurrentLanguage()` and falls back to English. Static markup uses `data-i18n*` attributes.
- Translation keys are type-checked against `en.json`. Tests check that all languages have the same keys and placeholders and that every key used in `index.html` exists.

Text for the model (tool descriptions, tool errors, system prompt) stays English on purpose.

To add a language: add `src/i18n/<code>.json` with the same keys, list the code in `manifest.json` under `i18n.languages`, and register it in `src/ui/i18n.ts`.

## Development

Dependencies are deliberately few: `typescript`, `esbuild`, `eslint` and `typescript-eslint` (plus `@types/node`). Tests use the built-in `node:test`; Node ≥ 22.18 runs TypeScript directly, so no test framework or loader is needed. The ZIP is written by a small writer based on `node:zlib`.

```bash
npm run typecheck   # tsc (strict)
npm run lint        # eslint, typescript-eslint strictTypeChecked
npm test            # node --test
npm run build       # dist/sp-butler/ + ZIP
npm run check       # all of the above (also runs in CI)
```

CI runs the checks on pull requests. On `main` it also uploads the plugin as a build artifact; the download is the installable plugin ZIP.

The Plugin API types live in `src/types/plugin-api.ts`. The npm package `@super-productivity/plugin-api` (1.0.1) predates secret storage, so the needed subset is taken from the upstream repository.

For trying things out without real data, use <https://test-app.super-productivity.com/>.

## Ideas for the next stages

- **Delete and restructure**: `deleteTask` and moving subtasks via `batchUpdateForProject`, with an extra clear confirmation.
- **Context menu "Edit with Butler"** (`registerTaskContextMenuEntry`): split, estimate or rephrase a task.
- **Day planning**: "Plan my day with 6 hours of capacity" based on estimates, due days and `timeSpent`.
- **Recurring tasks** (`taskRepeatCfgs` from `getAppState`) taken into account in answers.
- **Search the archive** (`getArchivedTasks`): "When did I last change the tires?"
- **Streaming** replies and a cancel button.
- **Keep the chat history** (`persistDataSynced` per device).
- **Auto-apply option** for single, unambiguous new tasks.
