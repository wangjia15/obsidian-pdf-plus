// Stage 2: synthesize each manifest part to its own mp3, in parallel, with resume.
// Reads the manifest written by stage 1; parts already done (and still fresh under the
// current voice/model/rate settings) are skipped, so re-running after an interruption
// or after a settings tweak only re-does what changed. Failed parts don't block others.
//
// UX safeguards added after "no data returned" bug report:
//   - 1Hz heartbeat updates the progress modal AND a persistent sidebar OutputBlock, so
//     users see the polling state (MiniMax async TTS spends most of its time on the
//     server, which the previous version didn't surface).
//   - per-part timeout (3 min) — if MiniMax's async TTS pipeline hangs, the part is
//     marked failed and other parts continue. Re-run "Synthesize audio" to retry.

import { Notice, normalizePath, TFile } from 'obsidian';
import PDFPlus from 'main';
import { getSharedAsyncTTSClient } from '../../provider/minimax-tts-async';
import { AIProgressModal } from '../../ui/progress';
import { getOrCreateAISidebar } from '../../ui/sidebar-view';
import { AIError } from '../../provider/types';
import {
	readManifest, writeManifest, partAbsPath, voiceForSpeaker, podcastDir,
	type PodcastManifest, type PodcastPartEntry,
} from './manifest';

const PER_PART_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — longer than any healthy async-TTS round trip we've seen

function activePDFFile(plugin: PDFPlus): TFile | null { return plugin.lib.getPDFView()?.file ?? null; }

async function ensurePartsDir(plugin: PDFPlus, file: TFile): Promise<void> {
	const dir = normalizePath(`${podcastDir(plugin, file)}/parts`);
	if (plugin.app.vault.getAbstractFileByPath(dir) === null) {
		try { await plugin.app.vault.createFolder(dir); } catch { /* already exists */ }
	}
}

function getPartFile(plugin: PDFPlus, file: TFile, partFile: string): TFile | null {
	const f = plugin.app.vault.getAbstractFileByPath(normalizePath(partAbsPath(plugin, file, partFile)));
	return f instanceof TFile ? f : null;
}

async function deletePart(plugin: PDFPlus, file: TFile, partFile: string): Promise<void> {
	const f = getPartFile(plugin, file, partFile);
	if (f) await plugin.app.vault.delete(f).catch(() => { /* ignore */ });
}

/** Walk the manifest and mark entries that need (re)synthesis: stale settings, missing
 *  part files, or previously-failed entries. Updates entry.voice to the current setting. */
function markStalePending(plugin: PDFPlus, file: TFile, manifest: PodcastManifest): void {
	const ai = plugin.settings.ai;
	const globalStale = manifest.model !== ai.minimax.ttsModelPodcast
		|| manifest.rate !== ai.speechRate
		|| manifest.volume !== ai.speechVolume;

	for (const e of manifest.segments) {
		const expectedVoice = voiceForSpeaker(plugin, e.speaker, manifest.lang);
		const partExists = !!getPartFile(plugin, file, e.partFile);
		const stale = globalStale || e.voice !== expectedVoice || (e.status === 'done' && !partExists);
		if (stale || e.status === 'failed' || e.status === 'pending') {
			if (e.status === 'done' && (globalStale || e.voice !== expectedVoice)) {
				deletePart(plugin, file, e.partFile);
			}
			e.status = 'pending';
			e.voice = expectedVoice;
			e.error = undefined;
		}
	}
	manifest.model = ai.minimax.ttsModelPodcast;
	manifest.rate = ai.speechRate;
	manifest.volume = ai.speechVolume;
}

export async function synthesizeAudioAction(plugin: PDFPlus): Promise<PodcastManifest | null> {
	const file = activePDFFile(plugin);
	if (!file) { new Notice('PDF++ AI: open a PDF first.', 3000); return null; }

	plugin.ai.assertBudget();
	if (!plugin.ai.hasConsent()) return null;

	const manifest = await readManifest(plugin, file);
	if (!manifest) {
		new Notice('PDF++ AI: no podcast script found. Run "PDF++ AI: Podcast — Generate script" first.', 6000);
		return null;
	}
	if (!manifest.segments.length) {
		new Notice('PDF++ AI: script is empty. Re-run "Generate script".', 6000);
		return null;
	}

	markStalePending(plugin, file, manifest);
	await writeManifest(plugin, file, manifest);
	await ensurePartsDir(plugin, file);

	const pending = manifest.segments.filter((e) => e.status === 'pending');
	if (!pending.length) {
		new Notice(`PDF++ AI [podcast 2/3]: all ${manifest.segments.length} part(s) already synthesized. Run "Assemble final" next.`, 5000);
		return manifest;
	}

	const concurrency = Math.max(1, plugin.settings.ai.podcast.concurrency ?? 3);
	const ac = new AbortController();
	const modal = new AIProgressModal(plugin, 'PDF++ AI — Synthesizing podcast', () => ac.abort());
	modal.open();

	// Persistent sidebar block so the result is visible long after the modal is gone.
	const view = await getOrCreateAISidebar(plugin, true);
	const block = view?.addBlock({ action: 'Synthesize podcast', sourcePath: file.path });

	const total = manifest.segments.length;
	const startTime = Date.now();
	const counts = () => ({
		done: manifest.segments.filter((e) => e.status === 'done').length,
		polling: manifest.segments.filter((e) => e.status === 'pending').length,
		failed: manifest.segments.filter((e) => e.status === 'failed').length,
	});

	const setStatus = () => {
		const c = counts();
		const elapsed = Math.round((Date.now() - startTime) / 1000);
		const elapsedStr = elapsed >= 5 ? ` · ${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s` : '';
		const text = `${c.done} done · ${c.polling} polling · ${c.failed} failed${elapsedStr}`;
		modal.setStatus(text, total ? c.done / total : 0);
		block?.setLoading(text);
	};
	setStatus();
	// 1Hz heartbeat — the previous version only updated on part completion, so a 5-minute
	// polling stage looked like a hang. This makes the waiting visible.
	const heartbeat = setInterval(setStatus, 1000);

	const client = getSharedAsyncTTSClient(plugin);

	// One synthesis unit: TTS → write part → update manifest entry → persist (so an
	// interruption after any part keeps it). Never throws: failures are recorded.
	const synthOne = async (entry: PodcastPartEntry) => {
		if (ac.signal.aborted) return;
		const startedAt = Date.now();
		try {
			const synthP = client.synthesize(entry.text, { voice: entry.voice, rate: manifest.rate, model: manifest.model, signal: ac.signal });
			const timeoutP = new Promise<never>((_, reject) => setTimeout(
				() => reject(new Error(`Part ${entry.index} timed out after ${PER_PART_TIMEOUT_MS / 1000}s waiting on MiniMax — re-run "Synthesize audio" to retry.`)),
				PER_PART_TIMEOUT_MS,
			));
			const buf = await Promise.race([synthP, timeoutP]);

			const abs = normalizePath(partAbsPath(plugin, file, entry.partFile));
			const existing = plugin.app.vault.getAbstractFileByPath(abs);
			if (existing instanceof TFile) await plugin.app.vault.modifyBinary(existing, buf);
			else await plugin.app.vault.createBinary(abs, buf);

			entry.status = 'done';
			entry.error = undefined;
			console.log(`[pdf++ ai] part ${entry.index} synthesized in ${Math.round((Date.now() - startedAt) / 1000)}s`);
		} catch (e) {
			if (e instanceof AIError && e.kind === 'aborted') return;
			entry.status = 'failed';
			entry.error = e instanceof Error ? e.message : String(e);
			console.warn(`[pdf++ ai] part ${entry.index} failed (${Math.round((Date.now() - startedAt) / 1000)}s):`, e);
		} finally {
			setStatus();
			await writeManifest(plugin, file, manifest).catch(() => { /* ignore */ });
		}
	};

	try {
		await runPool(pending, concurrency, synthOne, ac.signal);
	} finally {
		clearInterval(heartbeat);
		modal.close();
	}

	const c = counts();
	await writeManifest(plugin, file, manifest);

	const failedList = manifest.segments.filter((e) => e.status === 'failed');
	const summaryLines: string[] = [];
	if (ac.signal.aborted) {
		summaryLines.push(`**Cancelled.** ${c.done}/${total} parts synthesized before cancel.`);
		summaryLines.push(`Re-run "Synthesize audio" to resume — already-done parts are skipped.`);
	} else if (failedList.length) {
		summaryLines.push(`**Synthesize finished with errors.** ${c.done}/${total} parts synthesized, ${failedList.length} failed.`);
		summaryLines.push(`Re-run "Synthesize audio" to retry failed parts.`);
		summaryLines.push('', '**Failed parts:**');
		for (const e of failedList.slice(0, 10)) {
			summaryLines.push(`- part ${e.index} (${e.speaker}, ${Math.round((e.text?.length ?? 0) / 100) / 10}k chars): ${e.error ?? 'unknown'}`);
		}
		if (failedList.length > 10) summaryLines.push(`- …and ${failedList.length - 10} more`);
		summaryLines.push('', 'Once all parts are done, run "Assemble final".');
	} else {
		summaryLines.push(`**Synthesize complete.** ${c.done}/${total} parts synthesized.`);
		summaryLines.push(`Next: run "PDF++ AI: Podcast — Assemble final".`);
	}
	block?.setMarkdown(summaryLines.join('\n'));
	block?.setDone();

	if (failedList.length) {
		new Notice(`PDF++ AI [podcast 2/3]: ${c.done}/${total} done, ${failedList.length} failed. See sidebar for details.`, 8000);
	} else if (ac.signal.aborted) {
		new Notice(`PDF++ AI [podcast 2/3]: cancelled at ${c.done}/${total}.`, 6000);
	} else {
		new Notice(`PDF++ AI [podcast 2/3]: ${c.done}/${total} parts synthesized. Run "Assemble final" next.`, 5000);
	}
	return manifest;
}

/** Simple bounded concurrency pool. Aborts promptly when `signal` fires. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
	let next = 0;
	const n = Math.min(concurrency, items.length);
	const workers = Array.from({ length: n }, async () => {
		while (!signal?.aborted) {
			const i = next++;
			if (i >= items.length) return;
			await worker(items[i]);
		}
	});
	await Promise.all(workers);
}