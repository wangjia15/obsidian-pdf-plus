# Epics & Stories — PDF++ AI Module

> **Source of truth:** [AI-PRD.md](./AI-PRD.md) §2 (features F1–F8) and §7 (rollout M1–M4).
> **Architecture:** [AI-ARCHITECTURE.md](./AI-ARCHITECTURE.md) §10 (milestone → module mapping).
>
> This document was synthesized from the PRD by the sprint-planning workflow because no
> `epics.md` existed. Mapping rule: **PRD milestone → Epic; PRD feature → Story**.
> Each story carries its PRD feature ID (F#), priority, and acceptance criteria verbatim-ish,
> so it stays traceable. Stories are intentionally feature-sized; split them into finer-grained
> stories via `bmad-create-story` if a sprint needs smaller units.
>
> All AI code lives under `src/ai/` (not yet implemented) and is gated behind a single
> `settings.aiEnabled` flag. The whole plugin must compile and run identically with AI off.

---

## Epic 1: M1 — AI Core & Settings Foundation

**PRD milestone M1.** Delivers the foundation every other epic depends on: the MiniMax
provider client, the settings & provider-management surface, the right-sidebar AI view, and
the core paper-understanding + selection-action flows (explain / summarize / translate / ask AI).
**Priority:** P0. **Status gate:** Epic 1 is the prerequisite for Epics 2–4.

### Story 1.1: Settings & Provider Management

- **Feature ref:** F8 (P0)
- **Scope:** Settings tab section "AI (MiniMax)": API key (masked), Group ID, base URL (default
  `https://api.minimaxi.com`, switchable to international `api.minimax.io`), chat model (default
  `MiniMax-M3`), TTS models (`speech-2.8-hd` for podcast, `speech-2.8-turbo` for instant speech),
  voices, output language, output folder, cache TTL, monthly token budget with usage meter.
  "Test connection" button; normalized error surface for auth/quota/network failures.
- **Kill-switch:** disabling AI removes all AI UI without affecting the rest of PDF++.
- **Acceptance criteria:** provider errors are normalized and surfaced (never silent); master
  switch fully removes AI surfaces; API key never logged.

### Story 1.2: Paper Understanding & Chat Sidebar

- **Feature ref:** F1 (P0)
- **Scope:** Right-sidebar "PDF++ AI" view attached to the active PDF (renders Markdown output).
  Text-selection context menu: Explain / Summarize / Translate / Ask AI. One-click whole-paper
  structured summary (research question, method, key results, limitations, contributions) — M3's
  1M context allows sending full extracted text without chunking. Every output block has
  Copy · Insert into note · Speak (F4) · Save to vault.
- **Dependencies:** Story 1.1 (settings/provider). Reuses `context/extractor` (PDF text layer →
  page-anchored text), `context/cache`.
- **Acceptance criteria:** summary of a 30-page paper completes < 60 s (streaming starts < 5 s);
  responses render as Markdown with working `[[wikilinks]]` when inserted; prompts/responses
  visible and cancellable; token usage in view footer.

---

## Epic 2: M2 — Voice Output & Figure Parsing

**PRD milestone M2.** Adds the instant-voice "Speak" button (sync TTS streaming) and M3's native
multimodal vision for figures/charts/tables/formulas. **Priority:** P0.

### Story 2.1: Voice Output of AI Content

- **Feature ref:** F4 (P0)
- **Scope:** "Speak" button on every AI output block in the sidebar and on AI annotation popovers.
  MiniMax T2A sync HTTP streaming (`speech-2.8-turbo`) → Web Audio playback; Play/Pause/Stop.
  Fallback to existing `obsidian-tts` integration (`lib/speech.ts`) when MiniMax TTS is disabled
  or offline. Voice/speed/volume configurable; per-language default voices (中文/English).
- **Dependencies:** Story 1.2 (output blocks). Player is a singleton; new utterance stops previous;
  view/plugin unload stops playback.
- **Acceptance criteria:** audio starts < 2 s after Speak for a paragraph (streaming); Stop halts
  immediately; switching notes stops playback.

### Story 2.2: Image & Figure Parsing

- **Feature ref:** F2 (P0)
- **Scope:** Rectangular selection → "Analyze image" (reuses PDF++ "copy as image / cropped embed"
  rect selection); rendered PNG sent to M3 with an academic-figure prompt. Per-figure output:
  figure type, what it shows, axis/legend interpretation, key takeaways; Markdown table
  reconstruction for tables; LaTeX transcription for formulas. "Parse all figures" command
  detects embedded images per page and analyzes in batch. Results cached per
  (file hash, region, prompt version).
- **Dependencies:** Story 1.1 (provider), Story 1.2 (sidebar/output block). Uses
  `context/image-context`, `provider/ratelimit` (`p-limit(2)`), batch through
  `page.getOperatorList` image scan.
- **Acceptance criteria:** chart region yields correct textual reading of trends/values; table
  region yields valid Markdown table; batch processes a 15-figure paper without rate-limit failures
  (queued, ≤ 2 concurrent).

---

## Epic 3: M3 — Auto-Annotation & Citation Enrichment

**PRD milestone M3.** AI-assisted annotation (both vault-only and write-to-PDF modes) and live
citation enrichment of the bibliography. **Priority:** P0.

### Story 3.1: Auto-Annotation of Papers

- **Feature ref:** F5 (P0)
- **Scope:** "Auto-annotate this paper" command. M3 returns structured list of important passages
  (exact quotes) classified by type (research question, method, key result, limitation,
  contribution, definition) each with a one-line comment. Quote locator does fuzzy
  (whitespace/hyphenation-tolerant) matching over the text layer, returning page + char range.
  Output modes: (1) vault-only — companion Markdown note with one PDF++ selection link per
  annotation (non-destructive, byte-identical PDF); (2) write-into-PDF — real Highlight annots via
  `lib/highlights/write-file` (@cantoo/pdf-lib). Color-coded by category (mapped to PDF++ palette).
  Review modal lists proposed annotations with checkboxes; unmatched quotes reported, never guessed.
- **Dependencies:** Story 1.1 (provider/settings), Story 1.2 (extractor). Quote locator converts
  char ranges to the `{page, beginIndex, beginOffset, endIndex, endOffset}` subpath format so both
  output modes share one located result.
- **Acceptance criteria:** ≥ 90% of returned quotes located in a born-digital PDF's text layer;
  nothing written without confirmation; vault-only mode leaves PDF byte-identical.

### Story 3.2: References & Citation Counts

- **Feature ref:** F6 (P0)
- **Scope:** Build on existing `BibliographyManager` (extracts/parses bibliography via AnyStyle).
  Resolve each parsed reference against Semantic Scholar (primary) → Crossref → OpenAlex for
  citation count, year, venue, DOI, open-access PDF link. Display: citation-count badge in the
  citation hover popover; sortable References panel in the AI sidebar (sort by count/year); "open
  DOI" and "copy BibTeX" actions. M3 only repairs entries AnyStyle failed to parse — API matching
  is string search on title/author/year, not LLM. Cached in `.pdf-plus-ai/citations.json`
  (configurable TTL, default 30 days). Polite-pool compliance (Crossref User-Agent/mailto);
  ≤ 1 rps per API; exponential backoff on 429.
- **Dependencies:** existing `BibliographyManager` events ('extracted'/parsed); subscribes rather
  than re-extracts.
- **Acceptance criteria:** ≥ 80% of well-formed English references resolve to a Semantic Scholar
  record with correct title match (normalized-title similarity check, no false positives as certain);
  hover popover shows citation count within 300 ms when cached.

---

## Epic 4: M4 — Podcast & Knowledge Maps (Beta)

**PRD milestone M4.** Turns a paper into an audio podcast and into visual knowledge maps
(Canvas / graph). Ships the AI module beta via BRAT (`manifest-beta.json`). **Priority:** P0 (F3),
P1 (F7).

### Story 4.1: Podcast Generation from PDF

- **Feature ref:** F3 (P0)
- **Scope:** Command / toolbar button "Generate podcast from this PDF". Pipeline: extract text →
  M3 writes podcast script (single-narrator or two-host dialogue; 中文/English) → MiniMax T2A async
  (`speech-2.8-hd`, up to 1M chars) synthesizes long-form audio → MP3 saved next to PDF (or
  configurable folder) + companion note with script and embedded audio player. Configurable length
  target (5/15/30 min), per-host voice, speed, language. Progress UI with cancel; task status
  polled; result downloaded before 9-hour URL expiry. `task_id`/`file_id` persisted in
  `.pdf-plus-ai/tasks.json` so interrupted sessions resume. Dialogue mode: one async job per
  contiguous speaker block, client-side MP3 concatenation (CBR for safe concat).
- **Dependencies:** Story 1.1 (provider), Story 1.2 (extractor); provider `minimax-tts-async`,
  `ui/progress`.
- **Acceptance criteria:** 20-page paper yields coherent podcast that plays inside Obsidian via the
  companion note; dialogue mode uses two distinguishable voices; interrupted/failed tasks are
  resumable or cleanly reported.

### Story 4.2: Canvas & Graph Knowledge Maps

- **Feature ref:** F7 (P1)
- **Scope:** "Generate Canvas mind-map": one command creates an Obsidian `.canvas` — center node =
  paper (with AI summary), surrounding nodes = sections (abstract/method/results…), figure nodes
  (from F2) linking back to the page, and reference nodes showing citation counts (from F6) with
  edges to the center. Node clicks jump to PDF pages via PDF++ links. Alternative "Generate graph
  notes": one Markdown note per key concept/section/reference, interlinked with wikilinks and tagged
  (e.g. `#pdf-plus-ai/reference`) so Obsidian's native Graph view shows the network. Both outputs are
  plain vault files, editable afterwards; regeneration prompts before overwrite.
- **Dependencies:** Story 1.2 (summary), Story 2.2 (figures), Story 3.2 (citations). Emits JSON
  Canvas 1.0 (text/file nodes, edges, radial layout).
- **Acceptance criteria:** Canvas opens without errors; all PDF links navigate to correct page;
  graph notes are grouped/colorable via tags in Graph view settings.

---

## Retrospectives

Each epic has a corresponding retrospective entry (status `optional` until conducted):

- Epic 1 retrospective — `epic-1-retrospective`
- Epic 2 retrospective — `epic-2-retrospective`
- Epic 3 retrospective — `epic-3-retrospective`
- Epic 4 retrospective — `epic-4-retrospective`
