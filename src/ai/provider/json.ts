// Shared helpers for strict-JSON chat calls: loose parsing (strips code fences / trailing prose)
// and a one-shot "fix your JSON" retry. Used by F2 (vision) and F5 (auto-annotate).

import PDFPlus from 'main';
import { getSharedChatClient } from './minimax-chat';
import { ChatMessage } from './types';
import { withRetry } from './ratelimit';

export function parseJsonLoose(text: string): any | null {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
    try { return JSON.parse(t); } catch { return null; }
}

/** Non-streaming chat that requests JSON and retries once with a repair prompt if parsing fails. */
export async function chatJSON(plugin: PDFPlus, messages: ChatMessage[], capability: 'chat' | 'vision' = 'chat'): Promise<any> {
    const client = getSharedChatClient(plugin);
    const baseMsgs = messages;
    let res = await withRetry(capability, () => client.chat({ messages: baseMsgs, json: true, thinking: 'off', temperature: 0.1 }));
    let parsed = parseJsonLoose(res.text);
    if (!parsed) {
        const repair: ChatMessage[] = [...baseMsgs, { role: 'assistant', content: res.text }, { role: 'user', content: 'Your previous response was not valid JSON. Return ONLY the JSON object now — no prose, no code fences.' }];
        res = await client.chat({ messages: repair, json: true, thinking: 'off', temperature: 0 });
        parsed = parseJsonLoose(res.text);
    }
    return parsed;
}
