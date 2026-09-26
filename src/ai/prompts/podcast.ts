// Spoken research briefing, with the schema consumed by the existing TTS pipeline.
import { EVIDENCE_RULES, JSON_RULES, languageInstruction } from './shared';

export const PROMPT_VERSION = 'podcast.v2';

export function podcastSystem(mode: 'narrator' | 'dialogue', minutes: number, lang: 'zh' | 'en'): string {
	const target = minutes * (lang === 'zh' ? 240 : 140);
	const length = lang === 'zh' ? `${target} Chinese characters` : `${target} English words`;
	const speakers = mode === 'dialogue'
		? 'Use only speakers A and B. A guides the argument; B asks concrete clarifying questions, probes evidence and offers faithful paraphrases. Alternate naturally, avoiding repetitive agreement or fabricated disagreement. Each segment is one spoken turn.'
		: 'Use only speaker N. Each segment is a coherent spoken paragraph of roughly 3–6 sentences. Use clear transitions between ideas.';
	return `Write a listenable explanation of the supplied academic paper for a curious researcher.
${EVIDENCE_RULES}
Target approximately ${minutes} minutes, about ${length}, with a tolerance of roughly 20 percent. Duration is a target, not a guarantee. Do not pad a short or incomplete source with invented details.
Build an argument: the problem and gap; an intuitive explanation of the method; the strongest results and their comparison conditions; limitations and unanswered questions; what the reader should take away.
Explain important acronyms on first use. For equations describe the meaning rather than reading LaTeX aloud. Keep a small number of decisive numerical results and explain their units or metrics. Mark analogies as analogies and distinguish the authors' conclusions from reading assessments.
Output schema: {"segments":[{"speaker":"${mode === 'dialogue' ? 'A' : 'N'}","text":"spoken text"}]}.
${speakers}
text must contain only words to be spoken: no Markdown, links, stage directions, speaker-name prefixes, sound-effect instructions or citation lists. Do not read p.N markers aloud. End with a concise evidence-based takeaway rather than a claim of certainty beyond the paper.
${languageInstruction(lang)}
${JSON_RULES}`;
}

export function podcastUser(): string {
	return 'Write the spoken research briefing from this supplied paper. p.N markers identify source pages and are not part of the narration.\n\n';
}

export interface PodcastSegment { speaker: 'A' | 'B' | 'N'; text: string; }
