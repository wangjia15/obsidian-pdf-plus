# PDF++ AI — Product Requirements Document

| | |
|---|---|
| **Product** | PDF++ AI module (built into `obsidian-pdf-plus`) |
| **Version** | Draft v1.0 |
| **Date** | 2026-07-06 |
| **Author** | leo |
| **Status** | Draft for review |
| **Companion doc** | [AI-ARCHITECTURE.md](./AI-ARCHITECTURE.md) |

---

## 1. Overview

### 1.1 Background

PDF++ is the most Obsidian-native PDF annotation tool. It already provides highlight/annotation infrastructure, a bibliography extractor (`BibliographyManager`), backlink visualization, and deep PDF.js integration. It does **not** yet offer any AI capability.

This project adds an **AI module for academic papers**, powered by **MiniMax (国内版, `api.minimaxi.com`)** using the **MiniMax-M3** model — a natively multimodal LLM with a 1M-token context window, suitable for whole-paper understanding, figure/table parsing, and agentic tool calling — plus MiniMax **speech-2.8** TTS models for voice and podcast output.

### 1.2 Goals

- Let researchers understand, annotate, and connect academic PDFs dramatically faster, without leaving Obsidian.
- Keep everything vault-native: outputs are Markdown notes, PDF annotations, Canvas files — all plain files the user owns.
- One API key (MiniMax), zero external services required except optional free citation APIs.

### 1.3 Non-goals (v1)

- Not a general chat-with-anything client; scope is PDF/academic-paper workflows.
- No cloud storage of user documents; all state lives in the vault.
- No support for other LLM providers in v1 (the provider layer is abstracted so they can be added later).
- No paper writing/editing assistant.

### 1.4 Target users

- Graduate students / researchers doing literature reviews in Obsidian.
- Existing PDF++ users who annotate papers and want AI acceleration.
- Users who prefer 国内 API access (MiniMax domestic endpoints, no VPN required).

---

## 2. Feature requirements

Priorities: **P0** = must have for v1, **P1** = v1 if time permits, **P2** = later.

### F1. AI core: paper understanding & chat sidebar (P0)

Foundation for all other features.

- A right-sidebar **"PDF++ AI" view** attached to the active PDF: shows AI output (summary, Q&A, explanations) as rendered Markdown.
- Context menu on selected PDF text: **Explain / Summarize / Translate / Ask AI**, results appear in the sidebar.
- One-click **whole-paper structured summary**: research question, method, key results, limitations, contributions. M3's 1M context allows sending the full extracted text of virtually any paper without chunking.
- Every AI output block has action buttons: **Copy · Insert into note · Speak (F4) · Save to vault**.

**Acceptance criteria**

- Summary of a 30-page paper completes in < 60 s (streaming starts < 5 s).
- Responses render as Markdown with working `[[wikilinks]]` when inserted into notes.
- All prompts/responses are visible and cancellable; token usage surfaced in the view footer.

### F2. Image & figure parsing (P0)

Parse figures, charts, tables, and formula screenshots inside PDFs using M3's native vision capability.

- **Rectangular selection → Analyze image**: user drags a region (reuses PDF++ "copy as image / cropped embed" rect selection); the rendered PNG is sent to M3 with an academic-figure prompt.
- Per-figure outputs: figure type, what it shows, axis/legend interpretation, key takeaways, and (for tables) a Markdown table reconstruction; (for formulas) LaTeX transcription.
- **Parse all figures** command: detects embedded images on each page, analyzes them in batch, and writes results into the paper's companion note.
- Results cached per (file hash, region, prompt version) so re-opening is free.

**Acceptance criteria**

- A chart region produces a correct textual reading of trends and values legible in the image.
- A table region produces valid Markdown table syntax.
- Batch mode processes a 15-figure paper without rate-limit failures (queued, ≤ 2 concurrent).

### F3. Podcast generation from PDF (P0)

Turn a paper into an audio podcast for listening on the go.

- Command / toolbar button: **Generate podcast from this PDF**.
- Pipeline: extract text → M3 writes a podcast script (two modes: **single narrator** and **two-host dialogue**, in the user's chosen language 中文/English) → MiniMax **T2A async** (`speech-2.8-hd`) synthesizes long-form audio (async API supports up to 1M characters) → MP3 saved next to the PDF (or into a configurable folder) + a companion note with the script and an embedded audio player.
- Configurable: length target (5/15/30 min), voice(s) per host (300+ system voices, distinct voice per host in dialogue mode), speed, language.
- Progress UI with cancel; task status polled from the async API; result downloaded before the 9-hour URL expiry.

**Acceptance criteria**

- A 20-page paper yields a coherent podcast; audio file plays inside Obsidian via the companion note.
- Dialogue mode uses two distinguishable voices.
- Interrupted/failed tasks are resumable or cleanly reported (task_id persisted until completion).

### F4. Voice output of AI content (P0)

Click a button to have any AI-generated content read aloud.

- **Speak** button on every AI output block in the sidebar (and on AI annotation popovers).
- Uses MiniMax **T2A sync HTTP streaming** (`speech-2.8-turbo`) for low latency; playback via Web Audio in Obsidian; Play/Pause/Stop controls.
- Falls back to the existing `obsidian-tts` plugin integration (`lib/speech.ts`) when MiniMax TTS is disabled or offline.
- Voice, speed, and volume configurable in settings; per-language default voices (中文/English).

**Acceptance criteria**

- Audio starts < 2 s after clicking Speak for a paragraph of text (streaming).
- Stop immediately halts audio; switching notes stops playback.

### F5. Auto-annotation of papers (P0)

AI reads the paper and produces annotations automatically.

- Command: **Auto-annotate this paper**. M3 returns a structured list of important passages (exact quotes) classified by type: *research question, method, key result, limitation, contribution, definition*, each with a one-line comment.
- Passages are located in the PDF via the text layer; user chooses the output mode:
  1. **Vault-only (default, non-destructive)** — PDF++ backlink highlights: a companion Markdown note with one PDF++ selection link per annotation; highlights appear through PDF++'s existing backlink-highlight mechanism.
  2. **Write into PDF** — real Highlight annotations with comments, using PDF++'s existing annotation write-file infrastructure (`lib/highlights/write-file`, @cantoo/pdf-lib).
- Color-coded by category (mapped to the user's PDF++ color palette); a **review modal** lists proposed annotations with checkboxes before anything is written.
- Quote-matching is fuzzy (whitespace/hyphenation-tolerant); unmatched quotes are reported, never guessed.

**Acceptance criteria**

- ≥ 90 % of returned quotes are successfully located in the text layer of a born-digital PDF.
- Nothing is written without user confirmation in the review modal.
- Vault-only mode leaves the PDF file byte-identical.

### F6. References + citation counts (P0)

Enrich the paper's bibliography with live citation data.

- Builds on the existing `BibliographyManager` (extracts and parses bibliography entries via AnyStyle).
- For each parsed reference, resolve against **Semantic Scholar** (primary), falling back to **Crossref → OpenAlex**: citation count, year, venue, DOI, open-access PDF link.
- Display: citation count badge in the existing citation hover popover; a sortable **References panel** in the AI sidebar (sort by citation count/year); "open DOI" and "copy BibTeX" actions.
- M3 assists only when parsing fails (malformed references) — API matching is done by string search on title/author/year, not by the LLM, to avoid hallucinated metadata.
- Results cached in the vault (`.pdf-plus-ai/citations.json`, configurable TTL, default 30 days). All three APIs are free; Semantic Scholar API key optional for higher rate limits.

**Acceptance criteria**

- ≥ 80 % of well-formed English references resolve to a Semantic Scholar record with correct title match (normalized-title similarity check, no false positives presented as certain).
- Hover popover shows citation count within 300 ms when cached.

### F7. Canvas & graph knowledge maps (P1)

Visualize the paper and its reference network.

- **Generate Canvas mind-map**: one command creates an Obsidian `.canvas` file — center node = paper (with AI summary), surrounding nodes = sections (abstract/method/results…, each with AI-condensed content), figure nodes (from F2 results) linking back to the page, and reference nodes showing citation counts (from F6) with edges to the center. Node clicks jump to PDF pages via PDF++ links.
- **Generate graph notes** (alternative output): one Markdown note per key concept/section/reference, interlinked with wikilinks and tagged (e.g. `#pdf-plus-ai/reference`), so Obsidian's native Graph view shows the paper network; clicking any node opens the detail note, which deep-links into the PDF.
- Both outputs are plain vault files — freely editable afterwards; regeneration prompts before overwrite.

**Acceptance criteria**

- Canvas opens without errors; all PDF links navigate to the correct page.
- Graph notes are grouped/colorable via their tags in Graph view settings.

### F8. Settings & provider management (P0)

- Settings tab section "AI (MiniMax)": API key (stored with a masked field; see security notes in architecture doc), Group ID, base URL (default `https://api.minimaxi.com`, switchable to international `api.minimax.io`), chat model (default `MiniMax-M3`, selectable M2.x fallbacks), TTS model (default `speech-2.8-hd` for podcast, `speech-2.8-turbo` for instant speech), voices, output language, output folder, cache TTL, monthly token budget with usage meter.
- **Test connection** button; clear error surface for auth/quota/network failures.
- Global kill-switch: disabling AI removes all AI UI without affecting the rest of PDF++.

---

## 3. User stories (condensed)

1. *As a PhD student*, I open a 40-page paper, click "Summarize", and get a structured summary I can insert into my literature note — then hit Speak and listen while skimming figures.
2. *As a researcher commuting*, I generate a 15-minute two-host podcast from tomorrow's reading-group paper and listen offline.
3. *As a reviewer*, I run auto-annotate, approve 12 of 15 proposed highlights in the review modal, and get color-coded annotations by category.
4. *As a survey writer*, I open the References panel, sort by citation count, and immediately see which 5 cited works are field-defining, then generate a Canvas map of the paper to paste into my survey planning board.
5. *As a non-native reader*, I select a dense paragraph and a confusing chart, and get a plain-中文 explanation of both.

---

## 4. UX entry points

| Surface | Additions |
|---|---|
| PDF toolbar | AI menu button: Summarize · Auto-annotate · Podcast · Parse figures · Canvas map |
| Text-selection context menu | Explain / Summarize / Translate / Ask AI |
| Rect-selection context menu | Analyze image |
| Citation hover popover | Citation count badge + venue/year |
| Right sidebar | "PDF++ AI" view (chat/results, References panel, task progress) |
| Command palette | All of the above as commands |
| AI output blocks | Copy · Insert · **Speak** · Save |

---

## 5. Constraints & dependencies

- **Platform**: PDF++ is not desktop-only (`isDesktopOnly: false`); the AI module must use `requestUrl`/fetch-compatible networking that works on mobile. Podcast download of large MP3s may be desktop-first (P1 for mobile).
- **API**: MiniMax 国内版 (`https://api.minimaxi.com`). Chat via OpenAI-compatible or Anthropic-compatible endpoints; TTS via `t2a_v2` (sync) and T2A Async + File API (podcast). Requires the user's own API key (按量付费 covers all modalities).
- **Citation APIs**: Semantic Scholar Graph API, Crossref REST, OpenAlex — all free, rate-limited; must implement polite backoff and caching.
- **Scanned PDFs**: no text layer → text-based features degrade. v1 mitigation: page-image → M3 vision fallback for summary/Q&A (slower, flagged to user); auto-annotation unsupported on scanned PDFs in v1.
- **Cost**: user pays MiniMax usage. The plugin must show estimated tokens before batch operations (podcast, parse-all-figures, auto-annotate) and enforce the optional monthly budget.
- **Privacy**: paper text/images are sent to MiniMax when AI features are invoked. First-run consent dialog; per-feature opt-out; nothing is sent without explicit user action.

---

## 6. Success metrics (v1, 3 months post-release)

- ≥ 30 % of PDF++ AI installs configure an API key and run ≥ 1 AI action.
- Median "open paper → usable summary" time < 90 s.
- Auto-annotation quote-match rate ≥ 90 % on the internal test corpus (20 papers).
- < 2 % of AI actions end in an unhandled error (telemetry-free: measured via issue reports + local error log opt-in export).

---

## 7. Rollout plan

| Phase | Scope |
|---|---|
| **M1** | F8 settings + F1 core (provider client, sidebar, selection actions, summary) |
| **M2** | F4 speak button + F2 image parsing |
| **M3** | F5 auto-annotation + F6 citation enrichment |
| **M4** | F3 podcast + F7 canvas/graph maps; beta via BRAT (`manifest-beta.json`) |

---

## 8. Open questions

1. Should AI features live behind a single "AI" toolbar menu or be distributed into existing PDF++ menus? (Default: single menu, less clutter.)
2. Podcast dialogue mode: strict 2-host or allow N speakers? (Default: 2.)
3. Should citation counts also be shown inline in the PDF margin (like Scite)? Deferred to P2.
4. Upstream contribution vs. fork: this PRD assumes a fork (`pdf-plus` + AI); coordinate with upstream author if merging is desired.
