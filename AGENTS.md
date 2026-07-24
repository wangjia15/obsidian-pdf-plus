# Repository Guidelines

> **PDF++** (`obsidian-pdf-plus`, Obsidian plugin id `pdf-plus`) — "The most Obsidian-native PDF annotation tool ever."
> It turns Obsidian's *built-in* PDF viewer into an annotation tool: backlinks to PDF text selections render as highlights, PDF links are copied in customizable formats, and PDFs can be edited in place. It deliberately **extends rather than replaces** the native viewer (via runtime monkey-patching). This repo is a fork that adds an **AI module** (MiniMax M3 chat + TTS) for academic-paper workflows.

> ⚠️ `CLAUDE.md` states the AI module is "not yet implemented" — that is **outdated**. `src/ai/` is fully built and wired into the host plugin (all 4 design epics are `done` per `docs/stories/sprint-status.yaml`). Trust the code.

## Project Overview

- **Type**: Obsidian community plugin (TypeScript, bundled to a single `main.js`).
- **Scope**: PDF annotation, backlinks-as-highlights, link copy formats, PDF editing, vim-style bindings in the PDF viewer, and an AI module (summarize / figure analysis / auto-annotate / references / podcast / knowledge maps).
- **Compatibility**: `minAppVersion: 1.5.8`, `isDesktopOnly: false` (runs on desktop **and** mobile). Depends on Obsidian *private* APIs, so it can break on any Obsidian update.

## Architecture & Data Flow

**Entry & bundle.** `src/main.ts` (`export default class PDFPlus extends Plugin`) is the esbuild entry point → `main.js`. On `onload` it loads settings (with inline migration), instantiates `plugin.lib` (`PDFPlusLib`) and `plugin.ai` (`AIManager`), then applies patches.

**Monkey-patching is the core pattern.** PDF++ patches Obsidian's *private* internals at runtime with [`monkey-around`](https://github.com/pjeby/monkey-around)'s `around()`. Every patch lives in `src/patchers/`, one file per Obsidian class:
- `pdf-internals.ts` (~60 KB — the heart) patches `PDFViewerComponent` / `PDFViewerChild` / PDF.js `ObsidianViewer` to inject backlink highlights, color palette, vim bindings, etc.
- `pdf-view.ts`, `workspace.ts`, `backlink.ts`, `page-preview.ts`, `clipboard-manager.ts`, `menu.ts`, `pdf-embed.ts`, `pdf-outline-viewer.ts`.
- Patches are registered via `plugin.register(around(...))` (auto-removed on unload), each returns `boolean` success and sets `plugin.patchStatus.<area> = true`. `plugin.tryPatchUntilSuccess(patcher)` defers patching until the target view/embed exists, retrying on every `layout-change` — use this, since targets may not exist at `onload`. Constructor refs are captured into `plugin.classes` (`PDFView`, `PDFViewerComponent`, `PDFViewerChild`, `PDFEmbed`) for `instanceof` checks that survive `DeferredView` lazy-loading.

**The `lib` layer.** `plugin.lib` (`PDFPlusLib`, `src/lib/index.ts`) is the reusable core API. Reach the live viewer through this nullable chain, never via globals:
```
getPDFView() → getPDFViewerComponent() → getPDFViewerChild() → getObsidianViewer() → getPDFViewer() → getPage()/getPDFDocument()
```
PDF **embeds** (markdown/canvas/Excalidraw) are found by recursively walking component children (`getPDFEmbedsInComponent`); `plugin.pdfViewerChildren` (`Map<HTMLElement, PDFViewerChild>`) backs these lookups. Submodules: `copyLink`, `HighlightLib` (`lib/highlights/`), `WorkspaceLib`, `PDFPlusCommands`, `PDFComposer`, `PDFOutlines`, `NameTree`/`NumberTree`, `PDFNamedDestinations`, `PDFPageLabels`, `PDFBacklinkIndex`, `Speech`, `DummyFileManager`, `dataview`.

**Two distinct PDF libraries — do not confuse them:**
- **`pdfjs-dist`** (external, not bundled): Obsidian's bundled PDF.js, accessed as `window.pdfjsLib` / `window.pdfjsViewer`. Used for **rendering + text layer** (selection coordinates, page→image). Hook PDF.js events via `lib.registerPDFEvent` / `onPageReady` / `onTextLayerReady` / `onAnnotationLayerReady`. Use `utils.getTextLayerInfo()` to read `textDivs`/`textContentItems` across PDF.js versions.
- **`@cantoo/pdf-lib`** (bundled, fork of `Hopding/pdf-lib`): used for **reading/writing PDF structure** — annotations, outlines, page labels, destinations. `lib/highlights/write-file/` writes real highlight annotations into the file (experimental).

**PDF subpath = the data model.** Links to PDF content are wikilinks/markdown-links whose `#`-subpath encodes the target:
- Page: `#page=N&offset=left,top,zoom`
- Selection highlight: `#page=N&selection=beginIndex,beginOffset,endIndex,endOffset&color=NAME`
- Annotation: `#page=N&annotation=ID`
- Rectangular crop embed: `#page=N&rect=l,b,r,t`

Parsers: `utils.parsePDFSubpath`, `utils.subpathToParams`, `utils.paramsToSubpath`. `&color=NAME` is the one plugin-dependent notation; names are case-insensitive, registered in `settings.colors`; CSS variables follow `--pdf-plus-<sanitized-name>-rgb`.

**Plugin events.** `PDFPlus` extends Obsidian's `Events` — emit with `plugin.trigger('highlight' | 'update-dom' | 'adapt-to-theme-change' | 'color-palette-state-change', data)`, subscribe via `plugin.on(...)` (typed overloads in `main.ts`).

**AI module (`src/ai/`).** `AIManager extends Component` is **always instantiated** as a plugin child (`main.ts: this.ai = this.addChild(new AIManager(this))`) but stays dormant unless `settings.ai.aiEnabled`. `activate()`/`deactivate()` register/unregister the AI view, commands, and menu items so the master toggle works **live without a reload**; with AI off the plugin behaves exactly as without AI.
- **Gates before every API call**: `assertBudget()` (throws `AIError(budget)` when the monthly token budget is exceeded), `hasConsent()` (first-run privacy consent), `recordUsage(tokens)` (rolling monthly counter keyed `YYYY-MM`, persisted async). Cache lives under `<vault>/.pdf-plus-ai/`.
- **Provider abstraction** (`provider/types.ts`): MiniMax is the only v1 provider, but all calls go through `ChatMessage` (multimodal text + image parts), `Capability` (`'chat' | 'tts-instant' | 'tts-async' | 'vision' | 'citation'`), and a normalized `AIError` (`normalizeError`, kinds `'auth' | 'quota' | 'network' | 'badResponse' | 'aborted' | 'budget' | 'unknown'`; `redactSecrets` strips bearer tokens/keys from error bodies). Concrete clients: `minimax-chat`, `minimax-tts`, `minimax-tts-async`; `provider/ratelimit.ts` enforces per-capability concurrency (`p-limit`).
- **Features** (`features/`): `summarize`, `figure-analysis`, `auto-annotate` (6 categories: research-question / method / key-result / limitation / contribution / definition), `references` + `citations`, `knowledge-map`, and the **podcast pipeline** (`podcast/`: `script` → `synthesize` → `assemble` → `manifest`). Context extraction + caching in `context/` (`extractor`, `image-context`, `cache`). Prompts in `prompts/`. Audio playback in `audio/` (`speak`, `player`).
- **Commands** (`features/commands.ts`): `AI_COMMANDS` is the **single source of truth** for every AI command and drives both the command palette and the sidebar dropdown (`executeAICommand`), so the two surfaces never drift. Groups: `read | image | annotate | podcast | knowledge | util`.
- **UI** (`ui/`): `sidebar-view` (AI sidebar), `review-modal`, `references-panel`, `context-menu`, `output-block`, `progress`. HTTP uses Obsidian's `requestUrl` (CORS-exempt, mobile-safe) — never Node-only `fetch`/`https`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Plugin entry; `PDFPlus` class, patch orchestration, events, version-compat flags, AI instantiation |
| `src/patchers/` | One monkey-patch file per patched Obsidian class (barrel `index.ts`) |
| `src/lib/` | Reusable core API (`PDFPlusLib`) + submodules; `lib/highlights/` (`extract`, `geometry`, `viewer`, `write-file/`) |
| `src/ai/` | AI module: `provider/`, `context/`, `features/` (+ `podcast/`), `ui/`, `prompts/`, `audio/` |
| `src/vim/` | Vim bindings for the PDF viewer (`VimBindings` in `vim.ts`): `scope`, `visual`, `search`, `scroll`, `outline`, `hint`, `command-line`, `ex-commands`, `text-structure-parser` |
| `src/utils/` | Shared helpers: `color`, `events`, `maps`, `html-canvas`, `suggest`, `typescript`, plus the big `index.ts` |
| `src/modals/` | Obsidian modal dialogs (annotation, page-label, dummy-file, composer, etc.) |
| `src/post-process/` | Markdown post-processors for PDF links (`pdf-link-like`, `external-link`) |
| `src/user-script/` | User-script execution context (`context.ts`) |
| `src/settings.ts` | `PDFPlusSettings`, `DEFAULT_SETTINGS`, `PDFPlusSettingTab` (~157 KB — largest file) |
| `src/typings.d.ts` | Types for private Obsidian / PDF.js / Capacitor / Electron APIs + `Window` augmentation |
| `docs/` | AI design docs (`AI-PRD`, `AI-ARCHITECTURE`, `AI-USER-GUIDE`), `epics.md`, `stories/sprint-status.yaml` |
| `.github/workflows/` | `release.yml`, `validate-pull-request.yml`, `validate-bug-report.yml` |
| root | `main.js` (built bundle), `styles.css` (Style Settings `@settings` block at top), `manifest.json`, `manifest-beta.json`, `versions.json` |

## Development Commands

Package manager is **pnpm** (`pnpm-lock.yaml` committed). There is **no test suite**.

```bash
pnpm install        # install deps
pnpm dev            # esbuild watch (inline sourcemaps) → main.js
pnpm build          # tsc -noEmit -skipLibCheck  +  esbuild production (minified main.js)
pnpm lint           # eslint src/ --ext .ts,.tsx
pnpm lint:fix       # eslint --fix
```

**Release** (`./release <version>` — Python; runs from `main`): asserts `manifest.version == package.version`, requires an uncommitted diff in `src`/`styles.css`, interactively bumps `manifest.json` (+ `manifest-beta.json` + `package.json` for stable; `manifest-beta.json` only for `beta` versions), runs `pnpm i`, commits `release: <version>`, then creates and pushes an **annotated git tag with no `v` prefix** (`.npmrc`: `tag-version-prefix=""`). The tag triggers `.github/workflows/release.yml` (Node 22.x, pnpm latest, `pnpm build`, `gh release create --draft` attaching `main.js manifest.json styles.css`). `pnpm version` runs `version-bump.mjs` to sync `manifest.json`/`versions.json`.

**Run in Obsidian during dev**: copy the built `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/pdf-plus/` (standard Obsidian-plugin dev workflow; no bundler step for it here).

## Code Conventions & Common Patterns

- **Language/style**: TypeScript, **tabs** (`.editorconfig`), **semicolons required** (`eslint` `semi: always`). Explicit `any` is allowed; `@typescript-eslint/no-unused-vars` ignores args; many strict rules are relaxed (`no-empty-function`, `no-this-alias`, `ban-ts-comment`, `no-prototype-builtins` all off).
- **Module resolution**: `tsconfig.json` sets `baseUrl: "./src"`. Imports are **bare** — no `src/` prefix, usually no extension: `from 'main'`, `from 'lib'`, `from 'utils'`, `from 'patchers'` (barrel), `from 'typings'`, `from 'ai'`, `from 'color-palette'`. Any top-level `src/` file is importable by its basename.
- **Adding a patch**: live in `src/patchers/`, return `boolean` success, set `plugin.patchStatus.<area>`, capture target constructors into `plugin.classes`, register via `plugin.register(around(...))`, apply through `plugin.tryPatchUntilSuccess(...)`.
- **Reaching the viewer**: always go through `plugin.lib`'s getter chain, not globals. `window.pdfPlus` is registered only for debugging (`pdfPlus.debugMode = true` unlocks a "Load debug info" command that ingests a bug-reporter's settings JSON).
- **Error handling**: the lib layer exposes `tryCatchSync` / `tryCatchAsync` + a `TaskResult<T,E>` discriminated union (`lib/index.ts`). The AI layer normalizes everything to `AIError` (`normalizeError`, `redactSecrets`) with a `kind` the UI switches on.
- **HTTP on mobile**: use Obsidian's `requestUrl` only — never Node-only `fetch`/`https` — in any code path that must run on mobile.
- **Settings**: `loadSettings()` does **inline legacy migration** (renamed keys/commands, shape changes) — add new migrations there, guarded by `hasOwnProperty`. `saveSettings()` writes to `data.json` **except** `anystylePath` (browser local storage). The AI slice is repaired via `migrateAISettings(settings.ai)` (absence of the block = AI off). `styles.css` opens with a Style Settings `@settings` block; `main.registerStyleSettings()` triggers `parse-style-settings`.
- **Obsidian version compat**: `PDFPlus.checkVersion()` derives flags off `apiVersion` — `obsidianHasFocusBug` (<1.9.0), `obsidianHasTextSelectionBug` (≥1.9.0), `textDivFirstIdx` (1.8.0 → `1`, else `0`). Prefer `utils.getTextLayerInfo()` and `utils.isVersionNewerThan()` over hardcoded assumptions.
- **Private-API types**: when touching a new Obsidian/PDF.js/Capacitor/Electron internal, add its type to `src/typings.d.ts` (it also augments `Window`: `pdfPlus?`, `pdfjsLib`, `pdfjsViewer`).
- **Adding an AI command**: append to `AI_COMMANDS` in `src/ai/features/commands.ts` — it then appears in both the command palette and the sidebar menu. Group it under `read | image | annotate | podcast | knowledge | util`.
- **File safety**: the "write highlights directly to the PDF file" feature is experimental and disclaimed in the README — always go through `lib/highlights/write-file/`; vault-mode annotations must never touch the PDF file.

## Important Files

- `src/main.ts` — `PDFPlus` plugin class: lifecycle, patch orchestration, event typings, `checkVersion`, `this.ai = new AIManager(this)`.
- `src/patchers/pdf-internals.ts` — ~60 KB heart of the plugin; patches the PDF viewer internals.
- `src/lib/index.ts` — `PDFPlusLib` core API (~1200 lines) + `tryCatch*` helpers.
- `src/settings.ts` — settings interface, defaults, and the giant settings tab.
- `src/typings.d.ts` — private-API type declarations and `Window` augmentation.
- `src/ai/index.ts` — `AIManager` lifecycle, master-toggle `activate()`/`deactivate()`, budget/consent gates.
- `src/ai/settings.ts` — `AISettings`, `DEFAULT_AI_SETTINGS`, `migrateAISettings`, `renderAISettingsSection`.
- `src/ai/provider/types.ts` — the provider contract (`ChatMessage`, `Capability`, `AIError`, `redactSecrets`).
- `src/ai/features/commands.ts` — `AI_COMMANDS` single source of truth.
- `src/utils/index.ts` — shared helpers (`parsePDFSubpath`, `getTextLayerInfo`, `isVersionNewerThan`, `walkDescendantComponents`, `subpathToParams`).
- `esbuild.config.mjs`, `eslint.config.mjs`, `tsconfig.json` — build/lint/type config.
- `release`, `version-bump.mjs`, `manifest.json` — release tooling and plugin manifest.

## Runtime/Tooling Preferences

- **Runtime**: Node (CI pins `22.x`). **Bundler**: esbuild (target `es2018`, CJS output) — **not Bun**.
- **Package manager**: **pnpm** (lockfile committed). `pnpm-workspace.yaml` gates `allowBuilds` for `electron`/`esbuild`; `.npmrc` sets `tag-version-prefix=""`.
- **TypeScript**: target `ES6`, `isolatedModules`, `strictNullChecks`, `noImplicitAny`, `importHelpers`, `moduleResolution: node`.
- **Bundled externals** (not shipped): `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, `pdfjs-dist`, and all Node builtins.

## Testing & QA

- **There is no automated test suite.** Verification is `pnpm build` (TypeScript typecheck via `tsc -noEmit -skipLibCheck` + esbuild bundle) and `pnpm lint`. The real smoke test is loading the built `main.js` in Obsidian and exercising the changed path.
- **CI** (`.github/workflows/`): `release.yml` builds on any pushed tag; `validate-pull-request.yml` requires the PR body to contain `- [x] I have read the [CONTRIBUTING.md]` (comments on failure); `validate-bug-report.yml` validates bug-report templates.
- **Debug workflow**: set `pdfPlus.debugMode = true` in the dev console, then run "PDF++: Load debug info" to reproduce a bug with the reporter's exact settings.
