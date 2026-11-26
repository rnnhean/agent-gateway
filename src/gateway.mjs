/**
 * 网关核心：把限流、预算、熔断、路由、缓存、指标串成一次请求处理。
 *
 * 顺序是有讲究的，不能随便调：
 *   auth/限流   → 最便宜，先挡掉不该进来的
 *   预算预扣    → 便宜，且必须在真正花钱前
 *   缓存查询    → 便宜，命中就完全不花钱
 *   并发闸门    → 资源占用，要在确定要发请求之后
 *   路由调用    → 最贵
 *   结算与指标  → 最后，无论成功失败都要记
 *
 * 反例：先查缓存再限流——缓存命中也要消耗限流配额吗？要。
 * 否则有人可以靠刷缓存把你的限流绕开，CPU 仍然被你自己的进程吃掉。
 */
import { TokenBucket, ConcurrencyGate } from './limiter.mjs';
import { Router } from './router.mjs';
import { isUpstreamFailure } from './breaker.mjs';
import { ExactCache, SingleFlight } from './cache.mjs';
import { Budget, estimateInputTokens, costOf } from './budget.mjs';
import { Metrics } from './metrics.mjs';

export class Gateway {
    /**
     * @param {object} o
     * @param {object[]} o.providers
     * @param {object} [o.limiter] { capacity, refillPerSec }
     * @param {number} [o.maxConcurrency]
     * @param {object} [o.budget] { defaultLimitUsd, maxTokensPerRequest }
     * @param {object} [o.cache] { enabled, ttlMs, maxEntries }
     * @param {number} [o.requestTimeoutMs]
     * @param {object} [o.prices]
     */
    constructor(o) {
        this.router = new Router({ providers: o.providers });
        this.limiter = new TokenBucket({
            capacity: o.limiter?.capacity ?? 60,
            refillPerSec: o.limiter?.refillPerSec ?? 10,
        });
        this.gate = new ConcurrencyGate(o.maxConcurrency ?? 16);
        this.budget = new Budget(o.budget || {});
        this.cacheEnabled = o.cache?.enabled !== false;
        this.cache = new ExactCache({ ttlMs: o.cache?.ttlMs ?? 300_000, maxEntries: o.cache?.maxEntries ?? 1000 });
        this.singleFlight = new SingleFlight();
        this.timeoutMs = o.requestTimeoutMs ?? 120_000;
        this.prices = o.prices;
        this.metrics = new Metrics();

        // 定期清理限流桶，防止租户数增长导致内存无限上涨
        this._gcTimer = setInterval(() => this.limiter.gc(), 60_000);
        this._gcTimer.unref?.();
    }

    /**
     * 处理一次补全请求。
     * @param {object} req { tenant, model, system, messages, tools, max_tokens, temperature, stream }
     * @returns {Promise<{body:object, cached:boolean, provider:string, usage:object, costUsd:number}>}
     */
    async complete(req, { stream = false } = {}) {
        const started = process.hrtime.bigint();
        const tenant = req.tenant || 'anonymous';
        const finish = (outcome, extra = {}) => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            this.metrics.observe({ tenant, outcome, ms, ...extra });
            return ms;
        };

        // 1) 限流：缓存命中也要算，因为 CPU 是你的
        const rl = this.limiter.take(tenant);
        if (!rl.allowed) {
            finish('rate_limited');
            return fail(429, 'rate_limited', `请求过快，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`, { retryAfterMs: rl.retryAfterMs });
        }

        // 2) 单请求 token 上限
        const estIn = estimateInputTokens(req);
        const maxOut = req.max_tokens ?? 1024;
        if (estIn + maxOut > this.budget.maxTokensPerRequest) {
            finish('too_large');
            return fail(413, 'too_large', `单请求 token 超限：估算 ${estIn}+${maxOut} > ${this.budget.maxTokensPerRequest}`);
        }

        // 3) 预算预扣
        let settle;
        try {
            settle = this.budget.reserve(tenant, { estInputTokens: estIn, maxOutputTokens: maxOut, model: req.model });
        } catch (e) {
            finish('budget_exceeded');
            return fail(e.status || 402, 'budget_exceeded', e.message);
        }

        // 4) 缓存
        const cacheKey = this.cacheEnabled ? ExactCache.key(req) : null;
        if (cacheKey) {
            const hit = this.cache.get(cacheKey);
            if (hit) {
                const cost = costOf(req.model, hit.usage.inputTokens, hit.usage.outputTokens, this.prices);
                settle(cost);
                finish('cache_hit');
                return { body: hit, cached: true, provider: 'cache', usage: hit.usage, costUsd: cost };
            }
        }

        // 5) 并发闸门（单飞在外层：合并的请求不应各占一个并发额度）
        const exec = async () => {
            const release = await this.gate.acquire();
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
            try {
                const { provider, result, failovers } = await this.router.call((p) =>
                    p.call({ ...req, messages: normalizeMessages(req.messages, req.system) }, { signal: ctrl.signal }),
                );
                const cost = costOf(req.model, result.usage.inputTokens, result.usage.outputTokens, this.prices);
                // 注意：这里只返回，不记指标。指标统一由调用方记一次，
                // 否则单飞/缓存路径会重复计数（测试抓出过 requests_total 翻倍）。
                return { result, provider, cost, failovers };
            } finally {
                clearTimeout(timer);
                release();
            }
        };

        try {
            let result;
            let provider;
            let cost;
            let failovers = 0;
            if (cacheKey) {
                // 单飞：并发相同请求只打一次上游，其余等结果——避免缓存击穿（压测实测过 40 并发打 40 次）
                const { value, coalesced } = await this.singleFlight.run(cacheKey, async () => {
                    const r = await exec();
                    this.cache.set(cacheKey, r.result);
                    return r;
                });
                result = value.result;
                provider = value.provider;
                cost = value.cost;
                failovers = value.failovers || 0;
                settle(cost);
                finish(coalesced ? 'coalesced' : 'ok', { coalesced, failovers });
                return { body: result, cached: false, coalesced, provider, usage: result.usage, costUsd: cost };
            }
            const r = await exec();
            settle(r.cost);
            finish('ok', { failovers: r.failovers || 0 });
            return { body: r.result, cached: false, provider: r.provider, usage: r.result.usage, costUsd: r.cost };
        } catch (e) {
            settle(0); // 失败不扣费（预估的部分返还）
            const status = e.status || 502;
            finish(e.kind || 'upstream_error', { status });
            return fail(status, e.kind || 'upstream_error', e.message, e.details ? { details: e.details } : {});
        }
    }

    /**
     * 流式补全：返回一个异步生成器，逐个吐 {type:'text'|'usage'} 事件。
     *
     * 与 complete 的差异（为什么不能简单复用）：
     *   1. 流式一旦开始吐字就不能故障转移——用户会看到两段重复内容
     *   2. 用量在流结束时才知道，预扣的结算必须放进 finally
     *   3. 客户端断开必须中止上游（否则上游继续算钱）
     */
    async *streamComplete(req, { signal } = {}) {
        const started = process.hrtime.bigint();
        const tenant = req.tenant || 'anonymous';
        const rl = this.limiter.take(tenant);
        if (!rl.allowed) {
            const e = new Error(`请求过快，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`);
            e.status = 429;
            e.retryAfterMs = rl.retryAfterMs;
            this.metrics.observe({ tenant, outcome: 'rate_limited', ms: Number(process.hrtime.bigint() - started) / 1e6 });
            throw e;
        }

        const estIn = estimateInputTokens(req);
        const maxOut = req.max_tokens ?? 1024;
        let settle;
        try {
            settle = this.budget.reserve(tenant, { estInputTokens: estIn, maxOutputTokens: maxOut, model: req.model });
        } catch (e) {
            this.metrics.observe({ tenant, outcome: 'budget_exceeded', ms: Number(process.hrtime.bigint() - started) / 1e6 });
            throw e;
        }

        const release = await this.gate.acquire();
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });

        let tokensIn = 0;
        let tokensOut = 0;
        let outcome = 'ok';
        let chosen = null;
        try {
            const list = this.router.candidates();
            if (!list.length) throw Object.assign(new Error('所有 provider 都处于熔断状态'), { status: 503 });
            chosen = list[0]; // 流式不做故障转移，只选一个：已吐内容再换源会让用户看到重复
            if (typeof chosen.stream !== 'function') throw Object.assign(new Error(`provider ${chosen.name} 不支持流式`), { status: 501 });

            let firstChunk = true;
            // 注意：provider.stream 是 async 函数，返回的是 Promise<AsyncGenerator>。
            // 必须 await 之后再 for-await，否则会得到 "Promise is not async iterable"。
            const gen = await chosen.stream({ ...req, messages: normalizeMessages(req.messages, req.system) }, { signal: ctrl.signal });
            for await (const evt of gen) {
                if (evt.type === 'text') {
                    if (firstChunk) {
                        firstChunk = false;
                        this.metrics.markFirstToken(Number(process.hrtime.bigint() - started) / 1e6);
                    }
                    yield evt;
                } else if (evt.type === 'thinking') {
                    // thinking 不发给调用方（那是模型草稿），但也不计入 TTFT
                    continue;
                } else if (evt.type === 'usage') {
                    tokensIn = evt.inputTokens || tokensIn;
                    tokensOut = evt.outputTokens || tokensOut;
                }
            }
            this.router.breaker.record(chosen.name, true);
        } catch (e) {
            outcome = 'stream_error';
            if (chosen && isUpstreamFailure(e.status, e)) this.router.breaker.record(chosen.name, false);
            throw e;
        } finally {
            const cost = costOf(req.model, tokensIn, tokensOut, this.prices);
            settle(cost);
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            this.metrics.observe({ tenant, outcome, ms });
            signal?.removeEventListener('abort', onAbort);
            release();
        }
    }

    async stream(req) {
        const tenant = req.tenant || 'anonymous';
        const rl = this.limiter.take(tenant);
        if (!rl.allowed) throw Object.assign(new Error('请求过快'), { status: 429, retryAfterMs: rl.retryAfterMs });
        const release = await this.gate.acquire();
        return { release };
    }

    stats() {
        return {
            limiter: { buckets: this.limiter.buckets.size },
            gate: this.gate.stats,
            cache: { ...this.cache.stats(), ...this.singleFlight.stats() },
            breaker: this.router.stats().breaker,
            budget: this.budget.all(),
        };
    }

    close() {
        clearInterval(this._gcTimer);
    }
}

/**
 * 内部统一消息格式：content 可以是字符串或块数组。
 * 这里只做「system 合并进 messages」的兼容处理，具体 provider 差异在 providers.mjs 里。
 */
function normalizeMessages(messages, system) {
    const out = [];
    if (system && Array.isArray(messages) && !messages.some((m) => m.role === 'system')) {
        out.push({ role: 'user', content: `${String(system)}\n\n---\n\n${String(messages[0]?.content ?? '')}` });
        return [...out, ...messages.slice(1)];
    }
    return messages || [];
}

function fail(status, kind, message, extra = {}) {
    return { error: { status, kind, message, ...extra }, cached: false, provider: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
}
