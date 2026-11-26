/**
 * HTTP 服务：OpenAI 兼容入口，这样现有客户端改个 base_url 就能接。
 *
 * 为什么入口做成「OpenAI 兼容」而不是自定义格式：
 *   接入成本为零是网关的核心价值。让调用方改代码，就不会有人用。
 */
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { Gateway } from './gateway.mjs';
import { anthropicProvider, openaiProvider, anthropicStreamProvider, fakeProvider } from './providers.mjs';

/**
 * 组装默认 provider 列表。
 * 关键点：非流式与流式是两套实现，必须都挂上——否则 /v1/chat/completions 带 stream:true
 * 会返回「该 provider 不支持流式」。这在容器里真实踩过。
 */
export function buildDefaultProviders() {
    const primary = anthropicProvider({ name: 'primary', weight: 1 });
    // 流式复用同一套 URL / 凭据
    primary.stream = anthropicStreamProvider({ name: 'primary', weight: 1 }).stream;

    const list = [primary];
    if (process.env.FALLBACK_API_KEY) {
        const fb = openaiProvider({ name: 'fallback', weight: 1, keyEnv: 'FALLBACK_API_KEY' });
        list.push(fb);
    }
    return list;
}

const MAX_BODY = 4 * 1024 * 1024;
// React 前端构建产物目录（vite build → web/dist）。
// 优先级：环境变量 > 打包位置 > 仓库内源码目录，方便本地开发和容器两种形态。
const DIST_DIR = [
    process.env.WEB_DIST_DIR,
    fileURLToPath(new URL('../web/dist', import.meta.url)),
    fileURLToPath(new URL('./public', import.meta.url)),
].find((d) => d && fs.existsSync(path.join(d, 'index.html'))) || null;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
};

const json = (res, code, body, extraHeaders = {}) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), ...extraHeaders });
    res.end(s);
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('请求体过大'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** OpenAI 请求 → 内部请求 */
function fromOpenAI(body, tenant) {
    const msgs = body.messages || [];
    const systemMsg = msgs.find((m) => m.role === 'system');
    return {
        tenant,
        // 控制台调试台允许不填模型：回落到服务端配置，避免必须知道模型名才能试
        model: body.model && body.model !== 'default-model' ? body.model : process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || body.model,
        system: systemMsg?.content,
        messages: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        tools: body.tools?.map((t) => t.function || t),
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        stream: body.stream,
    };
}

/** 内部结果 → OpenAI 响应 */
function toOpenAI(result, model) {
    const textBlocks = (result.content || []).filter((b) => b.type === 'text');
    const toolBlocks = (result.content || []).filter((b) => b.type === 'tool_use');
    return {
        id: result.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: textBlocks.map((b) => b.text).join('') || null,
                    ...(toolBlocks.length
                        ? { tool_calls: toolBlocks.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) }
                        : {}),
                },
                finish_reason: result.stopReason === 'tool_use' ? 'tool_calls' : 'stop',
            },
        ],
        usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens },
    };
}

/**
 * @param {object} o
 * @param {Gateway} [o.gateway]
 * @param {(req:object)=>object} [o.providerFactory] 测试注入
 */
export function createApp({ gateway, providerFactory } = {}) {
    const gw =
        gateway ||
        new Gateway({
            providers: providerFactory ? providerFactory() : buildDefaultProviders(),
            limiter: { capacity: Number(process.env.RL_CAPACITY || 60), refillPerSec: Number(process.env.RL_REFILL || 10) },
            maxConcurrency: Number(process.env.MAX_CONCURRENCY || 16),
            budget: { defaultLimitUsd: Number(process.env.TENANT_BUDGET_USD || 10) },
            cache: { enabled: process.env.CACHE_ENABLED !== '0' },
        });

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // React 控制台：静态托管 web/dist（SPA，非 /api 路径回落到 index.html）
        if (req.method === 'GET' && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/v1') && url.pathname !== '/health' && url.pathname !== '/metrics') {
            if (!DIST_DIR) {
                return json(res, 503, { error: { message: '前端未构建：请在 web/ 下执行 npm install && npm run build' } });
            }
            const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
            const target = path.join(DIST_DIR, rel);
            // 防目录穿越：解析后必须仍在 DIST_DIR 内
            const safe = path.resolve(target).startsWith(path.resolve(DIST_DIR)) && fs.existsSync(target) && fs.statSync(target).isFile();
            const file = safe ? target : path.join(DIST_DIR, 'index.html');
            if (!fs.existsSync(file)) return json(res, 503, { error: { message: '前端产物缺失' } });
            res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': safe ? 'public, max-age=3600' : 'no-store' });
            return res.end(fs.readFileSync(file));
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, { ok: true, version: '0.1.0', ...gw.stats(), uptimeSec: Math.round(process.uptime()) });
        }

        if (req.method === 'GET' && url.pathname === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            return res.end(gw.metrics.renderPrometheus());
        }

        if (req.method === 'GET' && url.pathname === '/api/usage') {
            const tenant = url.searchParams.get('tenant');
            return json(res, 200, tenant ? gw.budget.usage(tenant) : { tenants: gw.budget.all() });
        }

        if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (e) {
                return json(res, e.status || 400, { error: { message: e.message, type: 'invalid_request' } });
            }
            if (!Array.isArray(body?.messages) || !body.messages.length) {
                return json(res, 400, { error: { message: 'messages 必须是非空数组', type: 'invalid_request' } });
            }
            // 租户：优先取请求头（真实部署应校验 token；这里只做透传，不做鉴权）
            const tenant = req.headers['x-tenant'] || 'anonymous';
            const internal = fromOpenAI(body, tenant);

            if (body.stream) {
                // 真 SSE 透传：边收边发。客户端断开 → 中止上游，避免继续计费。
                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-transform',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no', // 防止 nginx 缓冲，否则「流式」变成一次性
                });
                const ctrl = new AbortController();
                let closed = false;
                req.on('close', () => {
                    closed = true;
                    ctrl.abort();
                });
                const id = `chatcmpl-${Date.now()}`;
                let sentRole = false;
                try {
                    for await (const evt of gw.streamComplete(internal, { signal: ctrl.signal })) {
                        if (closed) break;
                        if (evt.type === 'text') {
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: internal.model,
                                choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: 'assistant' }), content: evt.text }, finish_reason: null }],
                            };
                            sentRole = true;
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                    if (!closed) {
                        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: internal.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                } catch (e) {
                    if (!closed) {
                        // 头已发出，只能以 SSE 形式报错
                        res.write(`data: ${JSON.stringify({ error: { message: String(e.message || e), type: e.kind || 'stream_error' } })}\n\n`);
                        res.end();
                    }
                }
                return;
            }

            const out = await gw.complete(internal);
            if (out.error) {
                const headers = out.error.retryAfterMs ? { 'retry-after': String(Math.ceil(out.error.retryAfterMs / 1000)) } : {};
                return json(res, out.error.status, { error: { message: out.error.message, type: out.error.kind } }, headers);
            }
            return json(res, 200, toOpenAI(out.body, internal.model), {
                'x-gateway-provider': out.provider,
                'x-gateway-cached': out.cached ? '1' : '0',
                'x-gateway-cost-usd': String(out.costUsd.toFixed(8)),
            });
        }

        return json(res, 404, { error: { message: 'not found' } });
    });

    server.gateway = gw;
    return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const port = Number(process.env.PORT || 8794);
    const app = createApp();
    app.listen(port, () => console.log(`agent-gateway listening on :${port}`));
    const shutdown = (s) => {
        console.log(`${s} received, closing`);
        app.close(() => {
            app.gateway.close();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

export { Gateway, anthropicProvider, openaiProvider, fakeProvider };
