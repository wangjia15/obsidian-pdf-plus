// Podcast pipeline manifest: the on-disk backbone that lets the three stages (script →
// synthesize → assemble) run independently, resume after interruptions, and skip work
// already done.
//
// Layout (final outputs stay flat next to the PDF for back-compat with ![[x.podcast.mp3]]):
//   <name>.podcast.mp3       ← stage 3 final audio (flat)
//   <name>.podcast.md        ← stage 3 note with embedded player (flat)
//   <name>.podcast/          ← all intermediates
//     script.json            ← stage 1 raw segments (for re-runs / audit)
//     script.md              ← stage 1 human-readable script
//     manifest.json          ← THIS FILE: per-part synthesis units + status
//     parts/000.mp3 …        ← stage 2 per-chunk audio, persisted for resume

import { normalizePath, TFile } from 'obsidian';
import PDFPlus from 'main';
import { PodcastSegment } from '../../prompts/podcast';

export interface PodcastPartEntry {
	index: number;            // 0-based, also encodes the part filename
	speaker: PodcastSegment['speaker'];
	voice: string;            // resolved voice id used for THIS part (entry-level so A/B/N differ)
	text: string;             // the chunk actually sent to TTS
	partFile: string;         // path relative to the podcast dir, e.g. "parts/000.mp3"
	status: 'pending' | 'done' | 'failed';
	error?: string;           // set when status === 'failed'
}

export interface PodcastManifest {
	version: 1;
	scriptHash: string;       // sha1 of the raw segments JSON; invalidates parts if script changes
	model: string;            // ttsModelPodcast at build time
	rate: number;             // speechRate
	volume: number;           // speechVolume
	lang: 'zh' | 'en';
	mode: 'narrator' | 'dialogue';
	sourcePath: string;       // PDF path this manifest was built from
	segments: PodcastPartEntry[];
}

// --- paths ------------------------------------------------------------------

export function podcastDir(plugin: PDFPlus, file: TFile): string {
	const dir = plugin.settings.ai.podcast.folder || file.parent?.path || '';
	return `${dir ? dir + '/' : ''}${file.basename}.podcast`;
}

export function manifestPath(plugin: PDFPlus, file: TFile): string {
	return `${podcastDir(plugin, file)}/manifest.json`;
}

export function scriptJsonPath(plugin: PDFPlus, file: TFile): string {
	return `${podcastDir(plugin, file)}/script.json`;
}

export function scriptMdPath(plugin: PDFPlus, file: TFile): string {
	return `${podcastDir(plugin, file)}/script.md`;
}

export function partsDirRel(): string { return 'parts'; }

export function partAbsPath(plugin: PDFPlus, file: TFile, partFile: string): string {
	return `${podcastDir(plugin, file)}/${partFile}`;
}

export function finalAudioPath(plugin: PDFPlus, file: TFile): string {
	const dir = plugin.settings.ai.podcast.folder || file.parent?.path || '';
	return `${dir ? dir + '/' : ''}${file.basename}.podcast.mp3`;
}

export function finalNotePath(plugin: PDFPlus, file: TFile): string {
	const dir = plugin.settings.ai.podcast.folder || file.parent?.path || '';
	return `${dir ? dir + '/' : ''}${file.basename}.podcast.md`;
}

// --- io ---------------------------------------------------------------------

export async function readManifest(plugin: PDFPlus, file: TFile): Promise<PodcastManifest | null> {
	const f = plugin.app.vault.getAbstractFileByPath(normalizePath(manifestPath(plugin, file)));
	if (!(f instanceof TFile)) return null;
	try {
		return JSON.parse(await plugin.app.vault.read(f)) as PodcastManifest;
	} catch {
		return null;
	}
}

export async function writeManifest(plugin: PDFPlus, file: TFile, manifest: PodcastManifest): Promise<void> {
	await plugin.lib.write(manifestPath(plugin, file), JSON.stringify(manifest, null, 2), false);
}

// --- build ------------------------------------------------------------------

/** Resolve the voice id for a speaker under the current settings + lang. */
export function voiceForSpeaker(plugin: PDFPlus, speaker: PodcastSegment['speaker'], lang: 'zh' | 'en'): string {
	const v = plugin.settings.ai.voices;
	if (speaker === 'A') return v.podcastHostA;
	if (speaker === 'B') return v.podcastHostB;
	return v[lang === 'zh' ? 'zh' : 'en']; // narrator
}

/** Merge consecutive same-speaker segments into turns. */
export function mergeTurns(segments: PodcastSegment[]): { speaker: PodcastSegment['speaker']; text: string }[] {
	const turns: { speaker: PodcastSegment['speaker']; text: string }[] = [];
	for (const s of segments) {
		const last = turns[turns.length - 1];
		if (last && last.speaker === s.speaker) last.text += ' ' + s.text;
		else turns.push({ speaker: s.speaker, text: s.text });
	}
	return turns;
}

/** Split text on sentence boundaries near `max` chars (carried over from the v1 pipeline). */
export function chunkText(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + max, text.length);
		const dot = text.lastIndexOf('. ', end);
		if (dot > i + max * 0.5) end = dot + 1;
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

async function sha1Hex(s: string): Promise<string> {
	const buf = new TextEncoder().encode(s);
	const digest = await crypto.subtle.digest('SHA-1', buf);
	return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a fresh manifest (all parts pending) from raw script segments: merges turns,
 * chunks to the configured size, and resolves per-part voices. Does NOT write to disk.
 */
export async function buildManifest(
	plugin: PDFPlus,
	file: TFile,
	segments: PodcastSegment[],
	opts: { mode: 'narrator' | 'dialogue'; lang: 'zh' | 'en' },
): Promise<PodcastManifest> {
	const ai = plugin.settings.ai;
	const chunkSize = ai.podcast.chunkSize ?? 3000;
	const entries: PodcastPartEntry[] = [];
	let idx = 0;
	for (const turn of mergeTurns(segments)) {
		for (const chunk of chunkText(turn.text, chunkSize)) {
			entries.push({
				index: idx,
				speaker: turn.speaker,
				voice: voiceForSpeaker(plugin, turn.speaker, opts.lang),
				text: chunk,
				partFile: `${partsDirRel()}/${String(idx).padStart(3, '0')}.mp3`,
				status: 'pending',
			});
			idx++;
		}
	}
	return {
		version: 1,
		scriptHash: await sha1Hex(JSON.stringify(segments)),
		model: ai.minimax.ttsModelPodcast,
		rate: ai.speechRate,
		volume: ai.speechVolume,
		lang: opts.lang,
		mode: opts.mode,
		sourcePath: file.path,
		segments: entries,
	};
}
