// Web Audio playback for F4 (voice output). Singleton: starting a new utterance stops the
// previous. Plugin/view unload stops playback. Decodes mp3 ArrayBuffers from the TTS client.

import PDFPlus from 'main';

export class AudioPlayer {
    private ctx: AudioContext | null = null;
    private source: AudioBufferSourceNode | null = null;
    private gain: GainNode | null = null;

    private ensureCtx(): AudioContext {
        if (!this.ctx || this.ctx.state === 'closed') {
            const Ctor = window.AudioContext || (window as any).webkitAudioContext;
            this.ctx = new Ctor();
            this.gain = this.ctx.createGain();
            this.gain.connect(this.ctx.destination);
        }
        return this.ctx;
    }

    /** Decode + play; stops anything currently playing. Resolves when playback ends. */
    async play(arrayBuffer: ArrayBuffer, volume = 1): Promise<void> {
        this.stop();
        const ctx = this.ensureCtx();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => { /* ignore */ });
        const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        if (this.gain) this.gain.gain.value = volume;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain ?? ctx.destination);
        this.source = source;
        return new Promise<void>((resolve) => {
            source.onended = () => { if (this.source === source) this.source = null; resolve(); };
            source.start();
        });
    }

    /** Immediately stop current playback. */
    stop() {
        if (this.source) {
            try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
            try { this.source.disconnect(); } catch { /* ignore */ }
            this.source = null;
        }
    }

    /** Release the AudioContext (call on plugin unload). */
    async dispose() {
        this.stop();
        if (this.ctx) { try { await this.ctx.close(); } catch { /* ignore */ } this.ctx = null; this.gain = null; }
    }
}

let _player: AudioPlayer | null = null;
export function getAudioPlayer(plugin: PDFPlus): AudioPlayer {
    if (!_player) {
        _player = new AudioPlayer();
        plugin.register(() => _player?.dispose());
    }
    return _player;
}
