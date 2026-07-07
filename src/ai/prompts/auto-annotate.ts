// Prompt for F5 (auto-annotation). M3 returns a strict-JSON list of important passages.

import { ANNOTATION_CATEGORIES, AnnotationCategory } from '../settings';

export const PROMPT_VERSION = 'auto-annotate.v1';

export function languageInstruction(lang: 'zh' | 'en'): string {
    return lang === 'zh' ? 'Reply in 中文 (Simplified Chinese).' : 'Reply in English.';
}

export function autoAnnotateSystem(lang: 'zh' | 'en'): string {
    return `You are an academic reading assistant. From the paper text, pick the most important passages worth annotating and return ONLY a JSON object:
{ "annotations": [ { "quote": "<verbatim excerpt copied exactly from the paper>", "category": "${ANNOTATION_CATEGORIES.join(' | ')}", "comment": "<one short sentence>" } ] }
Rules:
- "quote" MUST be copied verbatim from the paper (no paraphrasing, no ellipses) so it can be located by exact text match. Keep each quote 1–3 sentences.
- Choose at most ~15 annotations, covering the most important points across categories.
- Do not output any text outside the JSON object. ${languageInstruction(lang)}`;
}

export function autoAnnotateUser(): string {
    return 'Return the JSON object of important annotations for this paper. Paper text follows:\n\n';
}

export interface RawAnnotation {
    quote: string;
    category: AnnotationCategory;
    comment: string;
}
