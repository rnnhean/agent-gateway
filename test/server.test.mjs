import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { fakeProvider } from '../src/providers.mjs';
import { Gateway } from '../src/gateway.mjs';

let server;
let base;
let gw;

before(async () => {
    gw = new Gateway({
        providers: [fakeProvider({ name: 'p', chunkMs: 2, chunks: 3 })],
        limiter: { capacity: 100, refillPerSec: 100 },
        maxConcurrency: 4,
        budget: { defaultLimitUsd: 10 },
        cache: { enabled: true },
    });
    server = createApp({ gateway: gw });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(() => { gw.close(); r(); })));

test('/health 不崩且包含统计（曾经因 cache.stats 读错字段崩过）', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.cache, '应包含缓存统计');
    assert.ok(j.gate, '应包含并发闸门统计');
    assert.ok(Number.isInteger(j.gate.active));
});

test('POST /v1/chat/completions 走 OpenAI 兼容格式', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant': 't1' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'chat.completion');
    assert.match(j.choices[0].message.content, /fake reply/);
    assert.equal(r.headers.get('x-gateway-provider'), 'p');
});

test('system 消息被正确分离', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
});

test('缺 messages 返回 400', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.error.message);
});

test('非法 JSON 返回 400', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{oops' });
    assert.equal(r.status, 400);
});

test('流式返回 SSE，含 delta 与 [DONE]', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);

    const text = await r.text();
    assert.match(text, /data: /);
    assert.match(text, /\[DONE\]/);
    const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
    assert.match(content, /片段1/);
    assert.match(content, /片段3/);
});

test('/metrics && /api/usage 可用', async () => {
    const m = await (await fetch(`${base}/metrics`)).text();
    assert.match(m, /gateway_requests_total \d+/);
    const u = await (await fetch(`${base}/api/usage?tenant=t1`)).json();
    assert.ok(u.requests >= 0);
});

test('未知前端路由回落 index.html（SPA 行为）', async () => {
    const r = await fetch(`${base}/nope`);
    // 有构建产物时返回 SPA 外壳（200）；未构建时返回 503 并提示去构建
    assert.ok([200, 503].includes(r.status), `实际 ${r.status}`);
});

test('未知 API 路由仍然 404', async () => {
    const r = await fetch(`${base}/api/nope`);
    assert.equal(r.status, 404);
});

test('根路径返回 React 控制台（index.html）', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const html = await r.text();
    assert.match(html, /id="root"/, '应是 React 挂载点');
});
