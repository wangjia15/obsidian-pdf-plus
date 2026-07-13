// Shared helpers for strict-JSON chat calls: loose parsing (strips code fences / trailing prose)
// and a one-shot "fix your JSON" retry. Used by F2 (vision) and F5 (auto-annotate).

import PDFPlus from 'main';
import { getSharedChatClient } from './minimax-chat';
import { ChatMessage } from './types';

/** Result of a strict-JSON chat call: the parsed value, or null if the model output wasn't JSON. */
export type ParsedJSON = Record<string, unknown>;

/** Strip code fences and surrounding prose, then JSON.parse. Returns null on any parse failure. */
export function parseJsonLoose(text: string): ParsedJSON | null {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
    try { return JSON.parse(t) as ParsedJSON; } catch { return null; }
}

/**
 * Non-streaming chat that requests JSON and retries with a repair prompt (up to 2 rounds) if
 * parsing fails. Vision responses in particular sometimes preface JSON with prose despite
 * instructions, so a single repair attempt occasionally still isn't enough.
 * Retry/concurrency is owned by the provider's `withRetry` (inside client.chat) keyed by the
 * given capability — do NOT wrap this in another withRetry, or retries compound (see review).
 */
export async function chatJSON(plugin: PDFPlus, messages: ChatMessage[], capability: 'chat' | 'vision' = 'chat'): Promise<ParsedJSON | null> {
    const client = getSharedChatClient(plugin);
    let res = await client.chat({ messages, capability, json: true, thinking: 'off', temperature: 0.1 });
    let parsed = parseJsonLoose(res.text);
    let history = messages;
    const REPAIR_ROUNDS = 2;
    for (let attempt = 0; !parsed && attempt < REPAIR_ROUNDS; attempt++) {
        history = [...history, { role: 'assistant', content: res.text }, { role: 'user', content: 'Your previous response was not valid JSON. Return ONLY the JSON object now — no prose, no code fences, no explanation.' }];
        res = await client.chat({ messages: history, capability, json: true, thinking: 'off', temperature: 0 });
        parsed = parseJsonLoose(res.text);
    }
    return parsed;
}
