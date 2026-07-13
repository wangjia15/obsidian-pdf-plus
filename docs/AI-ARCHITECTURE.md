# PDF++ AI — Architecture Document

Companion to [AI-PRD.md](./AI-PRD.md). Describes how the AI module is built into the existing `obsidian-pdf-plus` codebase.

---

## 1. Design principles

1. **Additive, isolated module.** All AI code lives under `src/ai/`. The rest of PDF++ must compile and run identically with the module disabled (single feature flag in settings). No behavioral change for non-AI users.
2. **Reuse PDF++ infrastructure.** Text extraction, rect selection, annotation writing, bibliography parsing, color palette, link generation — all already exist; AI features orchestrate them rather than reimplementing.
3. **Provider-abstracted.** MiniMax is the only v1 provider, but all calls go through a small provider interface so others can be added without touching features.
4. **Vault-native state.** Caches, scripts, audio, canvas files are plain files in the vault. Deleting `.pdf-plus-ai/` fully resets AI state.
5. **Mobile-compatible networking.** All HTTP via Obsidian `requestUrl` (CORS-exempt, works on mobile); no Node-only APIs in feature code paths.

---

## 2. Existing integration points (as of v0.40.x)

| Existing code | Used by AI feature |
|---|---|
| `src/bib.ts` — `BibliographyManager` (extracts bibliography text per destination, parses via AnyStyle into `AnystyleJson`) | F6 citation enrichment, F7 reference nodes |
| `src/lib/speech.ts` — `Speech` submodule (delegates to `obsidian-tts`) | F4 fallback TTS path |
| `src/lib/highlights/` — `extract.ts`, `geometry.ts`, `write-file/` (writes real PDF annotations via `@cantoo/pdf-lib`) | F5 auto-annotation (both output modes) |
| `src/pdf-cropped-embed.ts` + rect-selection code | F2 region → PNG rendering |
| `src/lib/copy-link.ts` | F5/F7 generation of PDF++ selection links |
| `src/toolbar.ts`, `src/context-menu.ts` | UI entry points |
| `src/settings.ts` (`PDFPlusSettings`, settings tab) | F8 settings section |
| `src/lib/index.ts` (`PDFPlusLib` submodules) | AI lib registered as a submodule |
| `pdfjs-dist` text layer & page rendering | text extraction, quote location, page → image |
| `p-limit` (already a dependency) | request concurrency control |

---

## 3. Module layout

```
src/ai/
├── index.ts                  # AIManager: lifecycle, feature flag, wiring
├── settings.ts               # AI settings slice + settings-tab section
├── provider/
│   ├── types.ts              # ChatMessage, ChatRequest, TTSRequest, StreamHandle...
│   ├── minimax-chat.ts       # MiniMax-M3 chat client (OpenAI-compatible endpoint)
│   ├── minimax-tts.ts        # t2a_v2 sync (streaming) client
│   ├── minimax-tts-async.ts  # T2A Async + File API (podcast)
│   └── ratelimit.ts          # p-limit queues, retry w/ exponential backoff
├── context/
│   ├── extractor.ts          # PDF → structured text (pages, headings, offsets)
│   ├── image-context.ts      # region/page → PNG dataURL (canvas render)
│   └── cache.ts              # content-hash keyed cache in .pdf-plus-ai/
├── features/
│   ├── summarize.ts          # F1 structured summary + selection actions
│   ├── figure-analysis.ts    # F2
│   ├── podcast.ts            # F3 script gen + async TTS orchestration
│   ├── auto-annotate.ts      # F5 quote extraction + locating + writing
│   ├── citations.ts          # F6 SemanticScholar/Crossref/OpenAlex resolvers
│   └── knowledge-map.ts      # F7 canvas + graph-note generation
├── audio/
│   └── player.ts             # Web Audio streaming playback (F4), play/pause/stop
├── ui/
│   ├── sidebar-view.ts       # ItemView 'pdf-plus-ai' (right sidebar)
│   ├── output-block.ts       # rendered MD + Copy/Insert/Speak/Save buttons
│   ├── review-modal.ts       # F5 annotation review (extends base-modal.ts)
│   ├── references-panel.ts   # F6 sortable panel
│   └── progress.ts           # long-task progress + cancel + cost estimate
└── prompts/
    └── *.ts                  # versioned prompt templates (zh/en)
```

`AIManager` is instantiated in `main.ts` (`PDFPlus.onload`) only when `settings.aiEnabled`; it registers the view, commands, and menu items, and is a `Component` child of the plugin so unload tears everything down.

---

## 4. Provider layer (MiniMax 国内版)

Base URL: `https://api.minimaxi.com` (setting; international `https://api.minimax.io`).

| Capability | Endpoint | Model (default) | Notes |
|---|---|---|---|
| Chat / vision / tools | OpenAI-compatible `POST /v1/text/chatcompletion_v2` (or Anthropic-compatible `/anthropic`) | `MiniMax-M3` | 1M-token context; native multimodal — images passed as `image_url` (base64 data URL) content parts; streaming SSE; `thinking: adaptive` on for analysis tasks, disabled for extraction tasks needing strict JSON |
| Instant TTS (F4) | `POST /v1/t2a_v2` (HTTP, `stream: true`) | `speech-2.8-turbo` | ≤ 10,000 chars/request; hex/base64 audio chunks → Web Audio; mp3 32kbps for speed |
| Podcast TTS (F3) | T2A Async create + query, then File retrieve/download | `speech-2.8-hd` | up to 1M chars; poll `task_id`; download via `file_id` **before 9 h URL expiry**; supports per-request `voice_id` — dialogue mode synthesizes per-speaker segments and concatenates (or uses timed-pause markers in a single voice track) |

Cross-cutting client behavior:

- **Auth**: `Authorization: Bearer <key>`; GroupId where required. Key stored in plugin data (`data.json`) — same trust model as other Obsidian AI plugins; masked input; documented warning that vault sync will sync the key.
- **Resilience**: `p-limit(2)` per capability; retry ×3 with jittered exponential backoff on 429/5xx; every request carries an `AbortSignal` from the invoking UI.
- **Structured output**: features needing JSON (auto-annotate, canvas layout, figure batch) request JSON via prompt + validate with lightweight schema guards; one automatic "fix your JSON" retry before surfacing an error.
- **Cost meter**: token usage from responses accumulated into settings-backed monthly counter (F8 budget).

---

## 5. Feature data flows

### 5.1 Summary / selection actions (F1)

```
PDF text layer ──extractor──▶ structured text (page-anchored)
        │                            │
   selection text ────────────▶ prompt template ──▶ M3 (stream) ──▶ sidebar OutputBlock
                                                            └──▶ cache (hash(pdf)+action)
```

Extraction walks `pdfjs` text items per page, preserving `{page, offset}` anchors so AI citations of the text ("p.7: …") can be turned into PDF++ page links. Whole-paper prompts send full text (M3 1M ctx makes chunking unnecessary below ~2,000 pages); the extractor still records a token estimate and warns past a configurable ceiling.

### 5.2 Figure parsing (F2)

```
rect selection ──▶ render region to canvas @2x ──▶ PNG dataURL
                                                    │
page.getOperatorList image scan (batch mode) ───────┤
                                                    ▼
                              M3 vision prompt (figure-type aware)
                                                    ▼
                       {kind, reading, markdown_table?, latex?} ──▶ sidebar / companion note
```

Region rendering reuses the same canvas pipeline as PDF++ "copy as image". Batch mode enumerates embedded image XObjects per page (fallback: full-page render for vector-drawn figures), queued through `ratelimit.ts`.

### 5.3 Podcast (F3)

```
extractor ─▶ M3: outline ─▶ M3: script (narrator | 2-host, length-targeted)
                                   │  (script saved to companion note)
                                   ▼
                    per-speaker text segments
                                   ▼
        T2A Async create (speech-2.8-hd, voice_id per host) ─▶ poll task ─▶ File download
                                   ▼
     vault: <PDF folder>/<name>.podcast.mp3  +  <name>.podcast.md (script + ![[audio]])
```

Task descriptor (`task_id`, `file_id`, state) is persisted in `.pdf-plus-ai/tasks.json` so an interrupted Obsidian session can resume polling. Dialogue audio: one async job per contiguous speaker block, then client-side MP3 concatenation (simple frame-append; CBR mp3 output requested for safe concatenation).

### 5.4 Voice output (F4)

```
OutputBlock "Speak" ─▶ minimax-tts (stream) ─▶ audio/player.ts (Web Audio queue)
                                  │ fallback (disabled/offline)
                                  └────────▶ lib/speech.ts (obsidian-tts)
```

Player is a singleton: starting a new utterance stops the previous; view/plugin unload stops playback (Component onunload).

### 5.5 Auto-annotation (F5)

```
extractor text ─▶ M3 (JSON mode): [{quote, category, comment}] 
                        ▼
             quote locator (normalized fuzzy match over text layer,
             hyphen/whitespace tolerant, returns page + char range)
                        ▼
             ReviewModal (checkbox list, category colors, unmatched report)
                        ▼
     ┌── vault mode: companion note w/ PDF++ selection links (copy-link lib)
     └── pdf mode:  lib/highlights/write-file → real Highlight annots + Contents
```

Categories map to palette colors via a settings-defined mapping into the existing PDF++ color palette. The locator converts char ranges to text-layer indices, matching the `{page, beginIndex, beginOffset, endIndex, endOffset}` subpath format PDF++ links use — so both output modes share one located result.

### 5.6 Citation enrichment (F6)

```
BibliographyManager.destIdToParsedBib (existing)
        ▼  (title/author/year strings)
resolver chain: Semantic Scholar /graph/v1/paper/search/match
                → Crossref /works?query.bibliographic=
                → OpenAlex /works?filter=title.search:
        ▼  normalized-title similarity ≥ 0.9 accepted
{citationCount, year, venue, doi, oaUrl, s2Id}
        ▼
.pdf-plus-ai/citations.json (TTL cache)  ─▶ hover popover badge + References panel
```

Implementation subscribes to the existing `BibliographyManager` `events` (`'extracted'`/parsed) rather than re-extracting. M3 is invoked only as a repair step for entries AnyStyle failed to parse. Compliance: identify via User-Agent/mailto param (Crossref polite pool), ≤ 1 rps per API, exponential backoff on 429.

### 5.7 Canvas & graph maps (F7)

```
summary (F1) + figures (F2) + citations (F6)
        ▼
knowledge-map.ts builds a graph model {nodes, edges}
        ├─▶ .canvas emitter: JSON Canvas 1.0 (text nodes, file node → PDF,
        │    edges; radial layout; PDF++ page links inside node text)
        └─▶ graph-note emitter: one MD note per node under
             <notes folder>/<paper>/, wikilinked, tagged #pdf-plus-ai/<type>
```

Canvas nodes carry `pdf-plus` deep links (`[[paper.pdf#page=5&selection=…]]`), so clicks navigate via PDF++'s existing link handling. Graph mode relies on Obsidian-native Graph view; tags enable color groups.

---

## 6. Settings schema (additions to `PDFPlusSettings`)

```ts
interface AISettings {
  aiEnabled: boolean;                 // master switch (default false)
  minimax: {
    baseUrl: string;                  // 'https://api.minimaxi.com'
    apiKey: string;
    groupId: string;
    chatModel: string;                // 'MiniMax-M3'
    ttsModelInstant: string;          // 'speech-2.8-turbo'
    ttsModelPodcast: string;          // 'speech-2.8-hd'
  };
  outputLanguage: 'zh' | 'en' | 'auto';
  voices: { zh: string; en: string; podcastHostA: string; podcastHostB: string };
  speechRate: number; speechVolume: number;
  podcast: { mode: 'narrator' | 'dialogue'; targetMinutes: 5|15|30; folder: string };
  annotation: { defaultMode: 'vault' | 'pdf'; categoryColors: Record<Category, string> };
  citations: { enabled: boolean; s2ApiKey?: string; cacheTtlDays: number };
  knowledgeMap: { output: 'canvas' | 'notes'; folder: string };
  monthlyTokenBudget: number | null;  // null = unlimited
  consentGiven: boolean;              // first-run privacy consent
}
```

Migration: defaults injected in the existing settings-migration path; absence of the block = feature off.

---

## 7. Storage layout

```
<vault>/.pdf-plus-ai/
├── cache/<sha1(file)+action>.json   # AI response cache
├── citations.json                   # F6 TTL cache
└── tasks.json                       # async TTS task descriptors

next to each PDF (or configured folders):
├── <paper>.ai.md                    # companion note: summary, figures, annotations (vault mode)
├── <paper>.podcast.md / .mp3        # F3
├── <paper>.canvas                   # F7
└── <notes folder>/<paper>/*.md      # F7 graph mode
```

---

## 8. Error handling, security, privacy

- **Single error surface**: provider errors normalized to `{kind: auth|quota|network|badResponse, retryable}`; shown as Notice + inline in the sidebar block; never a silent failure.
- **Privacy gate**: first AI action opens a consent modal ("selected text/images from this PDF will be sent to MiniMax"); stored in `consentGiven`. Each batch feature shows scope + token estimate before running.
- **No secrets in outputs**: prompts never include vault paths beyond the file basename; API key never logged. Debug logging opt-in and redacted.
- **PDF safety**: pdf-write mode always creates the annotation via the existing tested write-file path, honoring PDF++'s existing backup/undo behavior; vault mode never touches the PDF.
- **Concurrency/unload**: every long task is a `Component` child; plugin unload aborts in-flight requests (AbortController) and stops audio.

---

## 9. Testing strategy

- **Unit**: quote locator (fuzzy matching fixtures incl. hyphenated line breaks), citation title matcher, canvas emitter (validate against JSON Canvas schema), mp3 concatenation.
- **Integration (mocked HTTP)**: provider clients against recorded MiniMax responses (success/429/5xx/stream); async TTS polling state machine incl. resume-after-restart.
- **Corpus test (manual, per release)**: 20-paper set (10 zh / 10 en, incl. 2 scanned) — measure summary quality spot checks, quote-match rate (target ≥ 90 %), citation resolution rate (target ≥ 80 %).
- **Regression**: existing PDF++ test/lint pipeline (`pnpm build`, eslint) must pass with `aiEnabled=false` verifying zero-impact isolation.

---

## 10. Milestone → module mapping

| Milestone (PRD §7) | Modules delivered |
|---|---|
| M1 | `provider/minimax-chat`, `context/extractor`, `context/cache`, `ui/sidebar-view`, `ui/output-block`, `features/summarize`, `settings` |
| M2 | `provider/minimax-tts`, `audio/player`, `context/image-context`, `features/figure-analysis` |
| M3 | `features/auto-annotate`, `ui/review-modal`, `features/citations`, `ui/references-panel` |
| M4 | `provider/minimax-tts-async`, `features/podcast`, `features/knowledge-map`, `ui/progress` polish |

---

## 11. Key references

- MiniMax 国内版 API docs: https://platform.minimaxi.com/ (接口概览: models MiniMax-M3 / speech-2.8-hd / speech-2.8-turbo; T2A sync ≤10k chars; T2A Async ≤1M chars, 9 h download window; OpenAI/Anthropic-compatible chat endpoints)
- MiniMax-M3 model page (1M context, native multimodality): https://www.minimax.io/models/text/m3
- Semantic Scholar Graph API · Crossref REST API · OpenAlex API
- JSON Canvas spec: https://jsoncanvas.org
- Obsidian plugin API (`requestUrl`, `ItemView`, `Component`)
