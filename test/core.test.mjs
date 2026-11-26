import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TokenBucket, ConcurrencyGate } from '../src/limiter.mjs';
import { CircuitBreaker, isUpstreamFailure } from '../src/breaker.mjs';
import { Router } from '../src/router.mjs';
import { ExactCache } from '../src/cache.mjs';
import { Budget, costOf, priceOf, estimateInputTokens } from '../src/budget.mjs';
import { Gateway } from '../src/gateway.mjs';
import { fakeProvider } from '../src/providers.mjs';
import { Metrics } from '../src/metrics.mjs';

// ---------------------------------------------------------------- 限流

test('令牌桶：容量内放行，超出拒绝并给出重试时间', () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    assert.equal(b.take('u').allowed, true);
    assert.equal(b.take('u').allowed, true);
    assert.equal(b.take('u').allowed, true);
    const denied = b.take('u');
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs >= 900, `应给出约 1s 的重试时间，实际 ${denied.retryAfterMs}`);
});

test('令牌桶：按时间连续补充，不是固定窗口', () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 2, refillPerSec: 2, now: () => t });
    b.take('u');
    b.take('u');
    assert.equal(b.take('u').allowed, false);
    t += 500; // 0.5s → 补 1 个
    assert.equal(b.take('u').allowed, true);
    assert.equal(b.take('u').allowed, false);
});

test('令牌桶：按 key 隔离，互不影响', () => {
    const b = new TokenBucket({ capacity: 1, refillPerSec: 0 });
    assert.equal(b.take('a').allowed, true);
    assert.equal(b.take('a').allowed, false);
    assert.equal(b.take('b').allowed, true, '不同租户不该互相影响');
});

test('令牌桶：GC 清理闲置桶', () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 1, refillPerSec: 0, now: () => t });
    b.take('a');
    b.take('b');
    t += 20 * 60_000;
    assert.equal(b.gc(10 * 60_000), 0);
});

test('并发闸门：限制同时在飞数量，释放后放行排队者', async () => {
    const g = new ConcurrencyGate(2);
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    assert.equal(g.stats.active, 2);

    let thirdDone = false;
    const p3 = g.acquire().then((rel) => {
        thirdDone = true;
        return rel;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(thirdDone, false, '第三个应排队');
    assert.equal(g.stats.queued, 1);

    r1();
    const r3 = await p3;
    assert.equal(thirdDone, true);
    r2();
    r3();
    assert.equal(g.stats.active, 0);
});

// ---------------------------------------------------------------- 熔断

test('熔断：连续失败达阈值后开闸并快速失败', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) {
        assert.equal(b.allow('p'), true);
        b.record('p', false);
    }
    assert.equal(b.allow('p'), false, '应已开闸');
    assert.ok(b.retryAfterMs('p') > 0);
});

test('熔断：冷却期后进入 half-open，只放一个探测', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
    b.record('p', false);
    b.record('p', false);
    assert.equal(b.allow('p'), false);
    t += 1001;
    assert.equal(b.allow('p'), true, 'half-open 放一个探测');
    assert.equal(b.allow('p'), false, '探测在飞时不再放');
});

test('熔断：half-open 探测成功则恢复，失败则重新开闸', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
    b.record('p', false);
    b.record('p', false);
    t += 1001;
    assert.equal(b.allow('p'), true);
    b.record('p', true);
    assert.equal(b.allow('p'), true, '成功后恢复 closed');

    b.record('q', false);
    b.record('q', false);
    t += 1001;
    assert.equal(b.allow('q'), true);
    b.record('q', false);
    assert.equal(b.allow('q'), false, '探测失败应重新开闸');
});

test('isUpstreamFailure：参数错不算上游故障', () => {
    assert.equal(isUpstreamFailure(400), false);
    assert.equal(isUpstreamFailure(401), false);
    assert.equal(isUpstreamFailure(429), true);
    assert.equal(isUpstreamFailure(500), true);
    assert.equal(isUpstreamFailure(503), true);
    assert.equal(isUpstreamFailure(0), true);
    assert.equal(isUpstreamFailure(null, new Error('fetch failed')), true);
});

// ---------------------------------------------------------------- 路由

test('路由：主 provider 失败时转移到后备', async () => {
    const bad = fakeProvider({ name: 'bad', failRate: 1, failStatus: 503 });
    const good = fakeProvider({ name: 'good' });
    const r = new Router({
        providers: [bad, good],
        breaker: new CircuitBreaker({ failureThreshold: 99 }),
        random: () => 0, // 固定先选第一个
    });
    const out = await r.call((p) => p.call({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(out.provider, 'good');
    assert.equal(out.failovers, 1);
});

test('路由：调用方错误（400）不重试也不转移，且不记 provider 故障', async () => {
    let called = 0;
    const p = {
        name: 'p',
        weight: 1,
        async call() {
            called++;
            throw Object.assign(new Error('HTTP 400'), { status: 400 });
        },
    };
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const r = new Router({ providers: [p], breaker, random: () => 0 });
    await assert.rejects(() => r.call((x) => x.call({})));
    assert.equal(called, 1, '不应重试');
    assert.equal(breaker.snapshot().p.failures, 0, '400 不该计入 provider 故障');
});

test('路由：全部熔断时快速失败 503', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.record('only', false);
    const r = new Router({ providers: [fakeProvider({ name: 'only' })], breaker });
    await assert.rejects(() => r.call((p) => p.call({})), (e) => e.status === 503 && e.kind === 'all_open');
});

// ---------------------------------------------------------------- 缓存

test('缓存 key：temperature>0 / 流式 / 带工具 不缓存', () => {
    assert.equal(ExactCache.key({ messages: [], temperature: 0.7 }), null);
    assert.equal(ExactCache.key({ messages: [], stream: true }), null);
    assert.equal(ExactCache.key({ messages: [], tools: [{ name: 'x' }] }), null);
    assert.ok(ExactCache.key({ messages: [{ role: 'user', content: 'hi' }], temperature: 0 }));
});

test('缓存 key：任何影响输出的字段变化都会改变 key', () => {
    const base = { model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };
    const k1 = ExactCache.key(base);
    assert.notEqual(k1, ExactCache.key({ ...base, model: 'm2' }));
    assert.notEqual(k1, ExactCache.key({ ...base, system: 's2' }));
    assert.notEqual(k1, ExactCache.key({ ...base, messages: [{ role: 'user', content: 'hi2' }] }));
    assert.equal(k1, ExactCache.key({ ...base }), '相同请求应命中同一 key');
});

test('缓存：TTL 过期与 LRU 淘汰', () => {
    let t = 0;
    const c = new ExactCache({ maxEntries: 2, ttlMs: 1000, now: () => t });
    c.set('a', 1);
    c.set('b', 2);
    assert.equal(c.get('a'), 1);
    t += 1500;
    assert.equal(c.get('a'), null, '过期应失效');

    const c2 = new ExactCache({ maxEntries: 2, now: () => t });
    c2.set('x', 1);
    c2.set('y', 2);
    c2.set('z', 3);
    assert.equal(c2.get('x'), null, '最旧的应被淘汰');
    assert.equal(c2.get('z'), 3);
});

// ---------------------------------------------------------------- 预算

test('价格表：按模型名匹配，未知走 default', () => {
    assert.equal(priceOf('claude-haiku-4-5-20251001').input, 0.8);
    assert.equal(priceOf('some-unknown-model').input, 3);
});

test('成本计算按百万 token', () => {
    const c = costOf('claude-sonnet-4-6', 1000, 500);
    assert.ok(Math.abs(c - (1000 / 1e6) * 3 - (500 / 1e6) * 15) < 1e-12);
});

test('预算：预扣阻止并发超支（关键）', () => {
    const b = new Budget({ defaultLimitUsd: 0.001 });
    // 单次预估就超过限额
    assert.throws(() => b.reserve('t', { estInputTokens: 100_000, maxOutputTokens: 100_000, model: 'claude-sonnet-4-6' }), (e) => e.status === 402);
});

test('预算：结算后返还预扣差额', () => {
    const b = new Budget({ defaultLimitUsd: 1 });
    const settle = b.reserve('t', { estInputTokens: 1000, maxOutputTokens: 1000, model: 'claude-sonnet-4-6' });
    assert.ok(b.usage('t').reservedUsd > 0);
    settle(0.0001);
    const u = b.usage('t');
    assert.equal(u.reservedUsd, 0);
    assert.ok(Math.abs(u.spentUsd - 0.0001) < 1e-9);
});

test('预算：重复 settle 不重复扣费', () => {
    const b = new Budget({ defaultLimitUsd: 1 });
    const settle = b.reserve('t', { estInputTokens: 10, maxOutputTokens: 10, model: 'm' });
    settle(0.01);
    settle(0.01);
    assert.ok(Math.abs(b.usage('t').spentUsd - 0.01) < 1e-9);
});

test('estimateInputTokens：中文按 1 字 1 token', () => {
    const zh = estimateInputTokens({ messages: [{ role: 'user', content: '你好世界你好世界' }] });
    assert.ok(zh >= 8);
});

// ---------------------------------------------------------------- 网关端到端

function gwWith(providers, opts = {}) {
    return new Gateway({
        providers,
        limiter: { capacity: 100, refillPerSec: 100 },
        maxConcurrency: 8,
        budget: { defaultLimitUsd: 10 },
        ...opts,
    });
}

test('网关：正常请求返回结果与成本', async () => {
    const gw = gwWith([fakeProvider({ name: 'p' })]);
    const out = await gw.complete({ tenant: 't', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(out.body.content[0].text.startsWith('fake reply'));
    assert.ok(out.costUsd > 0);
    assert.equal(out.provider, 'p');
    gw.close();
});

test('网关：相同请求命中缓存，且不重复计费', async () => {
    const p = fakeProvider({ name: 'p' });
    const gw = gwWith([p]);
    const req = { tenant: 't', model: 'm', temperature: 0, messages: [{ role: 'user', content: 'same' }] };
    const a = await gw.complete(req);
    const b = await gw.complete(req);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.provider, 'cache');
    assert.equal(p.calls, 1, '上游只应被调用一次');
    gw.close();
});

test('网关：限流拒绝时返回 429 与 retryAfter', async () => {
    const gw = new Gateway({
        providers: [fakeProvider({ name: 'p' })],
        limiter: { capacity: 1, refillPerSec: 0.001 },
    });
    const req = { tenant: 't', model: 'm', messages: [{ role: 'user', content: 'x' }] };
    await gw.complete(req);
    const second = await gw.complete({ ...req, messages: [{ role: 'user', content: 'y' }] });
    assert.equal(second.error.status, 429);
    assert.equal(second.error.kind, 'rate_limited');
    assert.ok(second.error.retryAfterMs > 0);
    gw.close();
});

test('网关：预算耗尽返回 402', async () => {
    const gw = new Gateway({
        providers: [fakeProvider({ name: 'p' })],
        limiter: { capacity: 100, refillPerSec: 100 },
        budget: { defaultLimitUsd: 1e-9 },
    });
    const out = await gw.complete({ tenant: 't', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }], max_tokens: 1000 });
    assert.equal(out.error.status, 402);
    assert.equal(out.error.kind, 'budget_exceeded');
    gw.close();
});

test('网关：单请求 token 超限返回 413', async () => {
    const gw = new Gateway({ providers: [fakeProvider({ name: 'p' })], budget: { maxTokensPerRequest: 10 } });
    const out = await gw.complete({ tenant: 't', model: 'm', messages: [{ role: 'user', content: '这是一段很长的中文内容需要超过十个token' }], max_tokens: 100 });
    assert.equal(out.error.status, 413);
    gw.close();
});

test('网关：上游全挂时返回 502 并带失败明细', async () => {
    const gw = gwWith([fakeProvider({ name: 'a', failRate: 1 })]);
    const out = await gw.complete({ tenant: 't', model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(out.error.status, 502);
    assert.ok(Array.isArray(out.error.details));
    gw.close();
});

test('网关：流式吐分片并记录 TTFT', async () => {
    const gw = gwWith([fakeProvider({ name: 'p', chunkMs: 10, chunks: 3 })]);
    const parts = [];
    for await (const evt of gw.streamComplete({ tenant: 't', model: 'm', messages: [{ role: 'user', content: 'x' }] })) {
        if (evt.type === 'text') parts.push(evt.text);
    }
    assert.equal(parts.length, 3);
    assert.match(gw.metrics.renderPrometheus(), /gateway_ttft_ms\{quantile="0.5"\} \d/);
    gw.close();
});

test('网关：流式遇到限流抛 429', async () => {
    const gw = new Gateway({ providers: [fakeProvider({ name: 'p' })], limiter: { capacity: 1, refillPerSec: 0.0001 } });
    for await (const _ of gw.streamComplete({ tenant: 't', model: 'm', messages: [{ role: 'user', content: 'a' }] })) {
        /* 消费 */
    }
    await assert.rejects(async () => {
        for await (const _ of gw.streamComplete({ tenant: 't', model: 'm', messages: [{ role: 'user', content: 'b' }] })) {
            /* 消费 */
        }
    }, (e) => e.status === 429);
    gw.close();
});

test('指标：结果分布与租户维度都能读出来', async () => {
    const gw = gwWith([fakeProvider({ name: 'p' })]);
    await gw.complete({ tenant: 'alice', model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await gw.complete({ tenant: 'bob', model: 'm', messages: [{ role: 'user', content: 'b' }] });
    const text = gw.metrics.renderPrometheus();
    assert.match(text, /gateway_requests_total 2/);
    assert.match(text, /gateway_tenant_requests_total\{tenant="alice"\} 1/);
    assert.match(text, /gateway_outcome_total\{outcome="ok"\} 2/);
    gw.close();
});

test('Metrics：分位数计算', () => {
    const m = new Metrics();
    for (const ms of [10, 20, 30, 40, 50]) m.observe({ tenant: 't', outcome: 'ok', ms });
    assert.equal(m.p(0.5), 30);
    assert.equal(m.p(0.99), 50);
});
