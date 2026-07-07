// F3 podcast script prompts. Narrator mode → one speaker; dialogue mode → two hosts (A/B).

export const PROMPT_VERSION = 'podcast.v1';

export function languageInstruction(lang: 'zh' | 'en'): string {
    return lang === 'zh' ? 'Write the script in 中文 (Simplified Chinese).' : 'Write the script in English.';
}

export function podcastSystem(mode: 'narrator' | 'dialogue', minutes: number, lang: 'zh' | 'en'): string {
    const shape = mode === 'dialogue'
        ? 'Return ONLY JSON: { "segments": [ { "speaker": "A" | "B", "text": "..." } ] }. Alternate hosts naturally; each "text" is one contiguous spoken turn (a few sentences). Aim for an engaging, conversational tone.'
        : 'Return ONLY JSON: { "segments": [ { "speaker": "N", "text": "..." } ] }. "N" is the single narrator. Split into ~6–15 sentences per segment for clean audio stitching.';
    return `You write engaging podcast scripts that explain an academic paper to a curious listener.
Target length: about ${minutes} minutes of spoken audio. Cover the research question, method, key results, limitations, and significance — faithfully, without inventing content.
${shape} ${languageInstruction(lang)}`;
}

export function podcastUser(): string {
    return 'Write the podcast script as JSON from the following paper text:\n\n';
}

export interface PodcastSegment { speaker: 'A' | 'B' | 'N'; text: string; }
