import crypto from 'crypto';

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
    }
    return '';
}

/**
 * Grok's web API takes a single `message` string per turn. We run stateless:
 * dump the whole OpenAI conversation into one prompt (Grok handles ~100k tokens
 * in a single /new request, so no continuation is needed).
 */
export function messagesToPrompt(messages) {
    const parts = [];
    for (const m of messages) {
        const text = contentToText(m.content);
        if (!text) continue;
        if (m.role === 'system') parts.push(`[System]:\n${text}`);
        else if (m.role === 'assistant') parts.push(`[Assistant]:\n${text}`);
        else parts.push(`[User]:\n${text}`);
    }
    return parts.join('\n\n');
}

export function generateId() {
    return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

export function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function buildOpenAIChunk(id, model, delta, finishReason, usage) {
    const obj = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
    };
    if (usage) obj.usage = usage;
    return 'data: ' + JSON.stringify(obj) + '\n\n';
}

export function buildOpenAIResponse(id, model, content, usage) {
    return {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: content || '' }, finish_reason: 'stop' }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}
