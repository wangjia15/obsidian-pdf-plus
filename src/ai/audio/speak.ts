// speakText(): the single entry point for "read this AI output aloud".
// Prefers MiniMax instant TTS (streamed via Web Audio); on any failure, or when no MiniMax
// key is set, falls back to the obsidian-tts integration via lib/speech.

import { Notice } from 'obsidian';
import PDFPlus from 'main';
import { getSharedTTSClient } from '../provider/minimax-tts';
import { getAudioPlayer } from './player';

export async function speakText(plugin: PDFPlus, text: string): Promise<void> {
    if (!text.trim()) return;
    const ai = plugin.settings.ai;

    if (ai.minimax.apiKey) {
        try {
            const tts = getSharedTTSClient(plugin);
            const buf = await tts.synthesize(text);
            await getAudioPlayer(plugin).play(buf, ai.speechVolume);
            return;
        } catch (e: any) {
            console.warn('PDF++ AI: MiniMax TTS failed, falling back to obsidian-tts.', e);
            // fall through
        }
    }

    if (plugin.lib.speech.isEnabled()) {
        await plugin.lib.speech.speak(text);
        return;
    }

    new Notice('PDF++ AI: no TTS available. Set a MiniMax API key, or enable the obsidian-tts plugin.', 6000);
}

/** Stop any in-flight playback (e.g. when switching notes). */
export function stopSpeaking(plugin: PDFPlus) {
    getAudioPlayer(plugin).stop();
}
