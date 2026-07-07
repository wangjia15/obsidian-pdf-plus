// Prompt templates for F1 (summary + selection actions). Versioned so cache keys can bust.
// Each prompt adapts to outputLanguage (zh / en / auto).

export const PROMPT_VERSION = 'summarize.v1';

export function languageInstruction(lang: 'zh' | 'en' | 'auto'): string {
    if (lang === 'zh') return 'Reply in 中文 (Simplified Chinese).';
    if (lang === 'en') return 'Reply in English.';
    return 'Reply in the same language as the paper (or English if ambiguous).';
}

/** Whole-paper structured summary. */
export function summarizePaperPrompt(text: string, lang: 'zh' | 'en' | 'auto'): { system: string; user: string } {
    const system = `You are an expert academic research assistant. Produce a structured summary of the user's paper.
Use this exact Markdown structure (keep headings): Research question · Method · Key results · Limitations · Contributions.
Be concise and faithful — do not invent content not present in the paper. ${languageInstruction(lang)}
When you cite a specific passage, prefix it with the page number like "p.7: …".`;

    const user = `Paper text (page-anchored, "p.N:" markers indicate page boundaries):\n\n${text}`;
    return { system, user };
}

/** Explain a passage in plain terms. */
export function explainPrompt(selection: string, lang: 'zh' | 'en' | 'auto'): { system: string; user: string } {
    return {
        system: `You explain academic text in plain, intuitive terms for a non-expert. ${languageInstruction(lang)}`,
        user: `Explain this passage clearly, including any jargon:\n\n"""\n${selection}\n"""`,
    };
}

/** Summarize a passage. */
export function summarizeSelectionPrompt(selection: string, lang: 'zh' | 'en' | 'auto'): { system: string; user: string } {
    return {
        system: `You summarize academic text faithfully and concisely. ${languageInstruction(lang)}`,
        user: `Summarize in 2–4 sentences:\n\n"""\n${selection}\n"""`,
    };
}

/** Translate a passage (target language resolved from outputLanguage). */
export function translatePrompt(selection: string, lang: 'zh' | 'en' | 'auto'): { system: string; user: string } {
    const target = lang === 'zh' ? 'English' : '中文 (Simplified Chinese)'; // translate to the "other" language by default
    return {
        system: `You are a precise academic translator. ${languageInstruction(lang)}`,
        user: `Translate the following passage into ${target}. Preserve technical terms, give the original in parentheses on first use.\n\n"""\n${selection}\n"""`,
    };
}

/** Free-form Q&A about a passage. */
export function askPrompt(selection: string, question: string, lang: 'zh' | 'en' | 'auto'): { system: string; user: string } {
    return {
        system: `You answer questions about academic text accurately, using only the provided passage. Say if the passage doesn't contain the answer. ${languageInstruction(lang)}`,
        user: `Passage:\n"""\n${selection}\n"""\n\nQuestion: ${question}`,
    };
}
