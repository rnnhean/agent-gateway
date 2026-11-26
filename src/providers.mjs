import fsTmp from 'node:fs';
/**
 * Provider 适配：把内部统一请求转成各家的 HTTP 调用。
 *
 * 只做「转发 + 归一化用量」，不做业务逻辑——网关不能理解 prompt 的含义，
 * 否则它就成了业务代码，没法给所有调用方复用。
 */

/**
 * 思考块（thinking）的处理策略。
 *
 * 实测数据（同一模型、同一问题）：
 *   开启思考：output_tokens 22，答对
 *   关闭思考：output_tokens 1，也答对（简单问题）
 *   关闭思考询问需要推理的问题：答非所问（同一模型实测出现「我还没学会回答这个问题」）
 *
 * 所以不能一刀切关闭。默认「不发送该字段」，由上游决定；
 * 调用方可用 THINKING_MODE=disabled|adaptive 显式控制，
 * 或者单次请求传 thinking 字段覆盖。
 */
function thinkingField(req) {
    if (req.thinking) return { thinking: req.thinking };
    const mode = process.env.THINKING_MODE;
    if (mode === 'disabled') return { thinking: { type: 'disabled' } };
    if (mode === 'adaptive') return { thinking: { type: 'adaptive' } };
    return {};
}
export function anthropicProvider({ name = 'anthropic', baseUrl, apiKey, keyEnv = 'LLM_API_KEY', weight = 1, costPerMTok }) {
    const base = String(baseUrl || process.env.LLM_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    return {
        name,
        weight,
        costPerMTok,
        async call(req, { signal } = {}) {
            const key = apiKey || process.env[keyEnv];
            if (!key) throw Object.assign(new Error(`未配置 ${keyEnv}`), { status: 401 });
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                    model: req.model,
                    max_tokens: req.max_tokens ?? 1024,
                    temperature: req.temperature ?? 0,
                    // 思考块会吃掉大量 output token：实测同一问题，开启时 max_tokens=800 全被
                    // 思考消耗、正文为空；关闭后 output_tokens=1 就答完了。
                    // 详见 thinkingField()：默认不干预，策略可配置。
                    ...thinkingField(req),
                    ...(req.system ? { system: typeof req.system === 'string' ? req.system : undefined } : {}),
                    messages: req.messages,
                    ...(req.tools?.length ? { tools: req.tools } : {}),
                }),
                signal,
            });
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
            const j = await res.json();
            return {
                id: j.id,
                content: j.content || [],
                stopReason: j.stop_reason,
                usage: { inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0, cacheReadTokens: j.usage?.cache_read_input_tokens || 0 },
            };
        },
    };
}

/** OpenAI 兼容（中转站、自建网关大多是这个） */
export function openaiProvider({ name = 'openai', baseUrl, apiKey, keyEnv = 'LLM_API_KEY', weight = 1, costPerMTok }) {
    const base = String(baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    return {
        name,
        weight,
        costPerMTok,
        async call(req, { signal } = {}) {
            const key = apiKey || process.env[keyEnv];
            if (!key) throw Object.assign(new Error(`未配置 ${keyEnv}`), { status: 401 });
            const msgs = [];
            if (req.system) msgs.push({ role: 'system', content: String(req.system) });
            for (const m of req.messages || []) msgs.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: req.model,
                    max_tokens: req.max_tokens ?? 1024,
                    temperature: req.temperature ?? 0,
                    messages: msgs,
                    ...(req.tools?.length
                        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || t.parameters } })) }
                        : {}),
                }),
                signal,
            });
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
            const j = await res.json();
            const m = j.choices?.[0]?.message || {};
            const content = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const tc of m.tool_calls || []) {
                let args = {};
                try {
                    args = JSON.parse(tc.function?.arguments || '{}');
                } catch {
                    args = {};
                }
                content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: args });
            }
            return {
                id: j.id,
                content,
                stopReason: m.tool_calls?.length ? 'tool_use' : 'end_turn',
                usage: { inputTokens: j.usage?.prompt_tokens || 0, outputTokens: j.usage?.completion_tokens || 0 },
            };
        },
    };
}

/**
 * 可控的假 provider：测试与压测用。
 * 支持注入「失败率 / 固定延迟」，用来验证熔断和故障转移真的生效。
 */
export function fakeProvider({ name = 'fake', latencyMs = 0, failRate = 0, failStatus = 503, weight = 1, chunkMs = 0, chunks = 3 } = {}) {
    let calls = 0;
    return {
        name,
        weight,
        get calls() {
            return calls;
        },
        async call(req) {
            calls++;
            if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
            if (failRate > 0 && Math.random() < failRate) throw Object.assign(new Error(`HTTP ${failStatus}`), { status: failStatus });
            return {
                id: `fake-${calls}`,
                content: [{ type: 'text', text: `fake reply to: ${String(req.messages?.[req.messages.length - 1]?.content ?? '').slice(0, 40)}` }],
                stopReason: 'end_turn',
                usage: { inputTokens: 100, outputTokens: 50 },
            };
        },
        /** 流式：按 chunkMs 间隔吐 chunks 个分片，用来测 TTFT 与背压 */
        async *stream(req) {
            calls++;
            if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
            if (failRate > 0 && Math.random() < failRate) throw Object.assign(new Error(`HTTP ${failStatus}`), { status: failStatus });
            for (let i = 0; i < chunks; i++) {
                if (chunkMs) await new Promise((r) => setTimeout(r, chunkMs));
                yield { type: 'text', text: `片段${i + 1} ` };
            }
            yield { type: 'usage', inputTokens: 100, outputTokens: chunks * 4 };
        },
    };
}

// ---------------------------------------------------------------- 流式（SSE）解析

/**
 * 把上游 SSE 流解析成统一事件序列。
 *
 * 支持两种上游格式：
 *   Anthropic: event: content_block_delta / data: {...}
 *   OpenAI   : data: {"choices":[{"delta":{"content":"..."}}]}
 * 网关对外统一按 OpenAI 的 chunk 形状再发出去。
 *
 * @param {ReadableStream} body
 * @param {'anthropic'|'openai'} kind
 */
export async function* parseSse(body, kind) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let evt;
            try {
                evt = JSON.parse(payload);
            } catch {
                continue;
            }
            if (kind === 'anthropic') {
                if (evt.type === 'content_block_delta') {
                    // thinking 与 text 要分开：thinking 是模型的草稿，不能当成答复内容发给用户，
                    // 但它确实消耗 token，所以单独作为一个事件类型透出去（上层可选择丢弃）。
                    if (evt.delta?.thinking) yield { type: 'thinking', text: evt.delta.thinking };
                    if (evt.delta?.text) yield { type: 'text', text: evt.delta.text };
                } else if (evt.type === 'message_start' && evt.message?.usage) {
                    yield { type: 'usage', inputTokens: evt.message.usage.input_tokens || 0, outputTokens: 0 };
                } else if (evt.type === 'message_delta' && evt.usage) {
                    yield { type: 'usage', inputTokens: 0, outputTokens: evt.usage.output_tokens || 0 };
                }
            } else {
                const d = evt.choices?.[0]?.delta;
                if (d?.content) yield { type: 'text', text: d.content };
                if (evt.usage) yield { type: 'usage', inputTokens: evt.usage.prompt_tokens || 0, outputTokens: evt.usage.completion_tokens || 0 };
            }
        }
    }
}

/** 实际发流式请求，返回 ReadableStream（供 parseSse 消费） */
export function anthropicStreamProvider({ name = 'anthropic-stream', baseUrl, apiKey, keyEnv = 'LLM_API_KEY', weight = 1, kind = 'anthropic' } = {}) {
    const base = String(baseUrl || process.env.LLM_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    return {
        name,
        weight,
        kind,
        async stream(req, { signal } = {}) {
            const key = apiKey || process.env[keyEnv];
            if (!key) throw Object.assign(new Error(`未配置 ${keyEnv}`), { status: 401 });
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                    model: req.model,
                    max_tokens: req.max_tokens ?? 1024,
                    temperature: req.temperature ?? 0,
                    stream: true,
                    // 与非流式一致：默认关闭思考块，否则流式前几百毫秒全是 thinking delta，
                    // 客户端看到的 TTFT 会被拉长，而且 token 白白烧掉。
                    ...thinkingField(req),
                    ...(req.system ? { system: String(req.system) } : {}),
                    messages: req.messages,
                    ...(req.tools?.length ? { tools: req.tools } : {}),
                }),
                signal,
            });
            if (!res.ok) {
                // 把上游错误体带回错误信息（不含凭据：响应体里不会有请求头），
                // 否则排障时只知道 400 不知道为什么，白花时间。
                const detail = await res.text().catch(() => '');
                throw Object.assign(new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`), { status: res.status });
            }
            return parseSse(res.body, 'anthropic');
        },
    };
}

