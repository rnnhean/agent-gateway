/**
 * 网关压测 / 过载保护验证。
 *
 * 回答四个问题，每个都有数据：
 *   1. 限流真的生效吗？（超出配额被拒，且 retry-after 正确）
 *   2. 并发闸门真的挡住上游吗？（上游同时在飞数不超过配置）
 *   3. 熔断真的快吗？（上游全挂时，请求耗时应该接近 0，而不是等超时）
 *   4. 缓存省了多少？（命中率与节省的上游调用数）
 *
 * 用假 provider，不花钱、可重复。真实模型的 TTFT 见 bench/realtime.mjs。
 *
 * 用法：node bench/load.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Gateway } from '../src/gateway.mjs';
import { fakeProvider } from '../src/providers.mjs';
import { CircuitBreaker } from '../src/breaker.mjs';

const ROUNDS = Number(process.env.ROUNDS || 200);
const rows = [];

function makeGateway({ providers, capacity = 1e9, refill = 1e9, concurrency = 8, breaker }) {
    const gw = new Gateway({
        providers,
        limiter: { capacity, refillPerSec: refill },
        maxConcurrency: concurrency,
        budget: { defaultLimitUsd: 1e9 },
        cache: { enabled: false },
    });
    if (breaker) gw.router.breaker = breaker;
    return gw;
}

async function bench(name, gw, makeReq, rounds = ROUNDS) {
    const t0 = process.hrtime.bigint();
    const outcomes = {};
    let upstreamPeak = 0;

    // 跟踪上游同时在飞数
    const origCall = gw.router.providers.map((p) => p.call);
    gw.router.providers.forEach((p, i) => {
        let active = 0;
        p.call = async (...args) => {
            active++;
            upstreamPeak = Math.max(upstreamPeak, active);
            try {
                return await origCall[i].apply(p, args);
            } finally {
                active--;
            }
        };
    });

    const tasks = Array.from({ length: rounds }, (_, i) =>
        gw.complete(makeReq(i)).then((r) => {
            const k = r.error ? r.error.kind : r.cached ? "cache_hit" : r.coalesced ? "coalesced" : "ok";
            outcomes[k] = (outcomes[k] || 0) + 1;
            return r;
        }),
    );
    await Promise.all(tasks);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const row = {
        scenario: name,
        rounds,
        wallMs: Math.round(wallMs),
        rps: Number((rounds / (wallMs / 1000)).toFixed(1)),
        outcomes,
        upstreamPeak,
        p50: gw.metrics.p(0.5),
        p95: gw.metrics.p(0.95),
    };
    rows.push(row);
    console.log(
        `${name.padEnd(24)} | ${String(row.rounds).padStart(4)} 次 | ${String(row.rps).padStart(7)} rps | ` +
        `p50 ${String(row.p50).padStart(6)}ms p95 ${String(row.p95).padStart(6)}ms | 上游峰值并发 ${row.upstreamPeak} | ${JSON.stringify(outcomes)}`,
    );
    gw.close();
    return row;
}

console.log(`网关压测：每场景 ${ROUNDS} 次\n`);

// 1. 基线：无限流、上游 5ms
await bench('基线（无限流）', makeGateway({ providers: [fakeProvider({ name: 'p', latencyMs: 5 })], concurrency: 32 }), (i) => ({
    tenant: 't', model: 'm', messages: [{ role: 'user', content: `q${i}` }],
}));

// 2. 限流生效：容量 20、补充 50/s
const rl = await bench(
    '限流 20/50rps',
    makeGateway({ providers: [fakeProvider({ name: 'p', latencyMs: 5 })], capacity: 20, refill: 50, concurrency: 32 }),
    (i) => ({ tenant: 't', model: 'm', messages: [{ role: 'user', content: `q${i}` }] }),
    Math.max(ROUNDS, 120),
);

// 3. 并发闸门：上游慢（100ms），闸门 4 —— 上游峰值并发应 ≤ 4
const gate = await bench(
    '闸门=4 上游100ms',
    makeGateway({ providers: [fakeProvider({ name: 'p', latencyMs: 100 })], concurrency: 4 }),
    (i) => ({ tenant: 't', model: 'm', messages: [{ role: 'user', content: `q${i}` }] }),
    40,
);
if (gate.upstreamPeak > 4) throw new Error(`并发闸门失效：上游峰值并发 ${gate.upstreamPeak} > 4`);

// 4. 熔断：上游全挂，看是否快速失败
const deadBreaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
const cb = await bench(
    '熔断（上游全挂）',
    makeGateway({ providers: [fakeProvider({ name: 'dead', failRate: 1, failStatus: 503 })], concurrency: 32, breaker: deadBreaker }),
    (i) => ({ tenant: 't', model: 'm', messages: [{ role: 'user', content: `q${i}` }] }),
    60,
);

// 5. 故障转移：主 provider 挂，后备正常
const failover = await bench(
    '故障转移',
    makeGateway({
        providers: [fakeProvider({ name: 'bad', failRate: 1, failStatus: 503 }), fakeProvider({ name: 'good', latencyMs: 5 })],
        concurrency: 8,
        breaker: new CircuitBreaker({ failureThreshold: 99 }),
    }),
    (i) => ({ tenant: 't', model: 'm', messages: [{ role: 'user', content: `q${i}` }] }),
    40,
);

// 6. 缓存：重复请求
const cacheGw = new Gateway({
    providers: [fakeProvider({ name: 'p', latencyMs: 20 })],
    limiter: { capacity: 1e9, refillPerSec: 1e9 },
    maxConcurrency: 8,
    budget: { defaultLimitUsd: 1e9 },
    cache: { enabled: true },
});
const cacheRes = await bench('缓存（重复请求）', cacheGw, () => ({ tenant: 't', model: 'm', temperature: 0, messages: [{ role: 'user', content: 'same' }] }), 40);
// 「没打上游」的两种方式都算省：命中已有缓存（cache_hit）+ 并发合并（coalesced）
const savedUpstream = ((cacheRes.outcomes.cache_hit || 0) + (cacheRes.outcomes.coalesced || 0)) / 40;

// 再跑一轮「串行」重复请求，验证纯缓存命中（并发场景下大部分是 coalesced）
const sequentialHits = [];
for (let i = 0; i < 10; i++) {
    const r = await cacheGw.complete({ tenant: 't', model: 'm', temperature: 0, messages: [{ role: 'user', content: 'same' }] });
    sequentialHits.push(r.cached ? 1 : 0);
}
const seqHitRate = sequentialHits.reduce((a, b) => a + b, 0) / sequentialHits.length;

// 判断
const checks = [
    { name: '限流拒绝了超额请求', ok: (rl.outcomes.rate_limited || 0) > 0 },
    { name: '并发闸门限制上游并发 ≤ 4', ok: gate.upstreamPeak <= 4 },
    { name: '熔断后失败变快（p95 < 100ms）', ok: cb.p95 < 100 },
    { name: '熔断产生大量快速失败', ok: (cb.outcomes.upstream_error || 0) + (cb.outcomes.all_failed || 0) > 10 },
    { name: '故障转移全部成功', ok: (failover.outcomes.ok || 0) === 40 },
    { name: '并发相同请求只打一次上游（单飞）', ok: cacheRes.upstreamPeak === 1 },
    { name: '并发场景绝大多数被合并或命中', ok: savedUpstream > 0.9 },
    { name: '串行重复请求命中缓存', ok: seqHitRate > 0.9 },
];

console.log('\n判定：');
let failed = 0;
for (const c of checks) {
    console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
    if (!c.ok) failed++;
}

const outDir = path.resolve('results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(
    path.join(outDir, `load-${stamp}.json`),
    JSON.stringify({ env: { node: process.version, platform: os.platform(), cpus: os.cpus().length }, rows, checks }, null, 2),
);
const md = [
    `# 网关压测 ${new Date().toISOString().slice(0, 19)}`,
    '',
    `环境：Node ${process.version} / ${os.platform()} / ${os.cpus().length} 核`,
    '',
    '| 场景 | 请求数 | rps | p50 | p95 | 上游峰值并发 | 结果分布 |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| ${r.scenario} | ${r.rounds} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.upstreamPeak} | ${JSON.stringify(r.outcomes)} |`),
    '',
    '## 判定',
    '',
    ...checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}`),
    '',
    '> 用假 provider，衡量的是网关自身行为（限流/闸门/熔断/缓存），不含模型真实延迟。',
].join('\n');
fs.writeFileSync(path.join(outDir, `load-${stamp}.md`), md);
console.log(`\n结果已写入 results/load-${stamp}.json / .md`);
process.exit(failed ? 1 : 0);
