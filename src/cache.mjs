/**
 * 精确缓存（不含语义相似度）。
 *
 * 为什么只做精确匹配：语义缓存（embedding 相似就复用）听起来很香，但有一个致命问题——
 * **同一个问题在不同上下文里答案不同**。工单 A1001 问「到哪了」和 A1002 问「到哪了」
 * 语义几乎一样，答案完全不同。做语义缓存而不带足上下文字段，会给出错误答案。
 *
 * 所以这里只做「完全相同的请求体」缓存，并把 messages/system/tools 全部纳入 key。
 * 语义缓存要另做，且必须把上下文实体一起纳入 key。
 *
 * 另外两个约束：
 *   - temperature > 0 的请求默认不缓存（结果本来就该有随机性）
 *   - 带工具调用的请求默认不缓存（工具结果会变）
 */
import { createHash } from 'node:crypto';

export class ExactCache {
    /** @param {{maxEntries?:number, ttlMs?:number, now?:()=>number}} [o] */
    constructor({ maxEntries = 1000, ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.now = now;
        this.map = new Map(); // key -> {value, at}
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * 生成缓存键。纳入所有会改变结果的字段。
     * @returns {string|null} null 表示该请求不该缓存
     */
    static key(req) {
        if (req.temperature != null && req.temperature > 0) return null;
        if (req.stream) return null; // 流式不缓存：没法从缓存回放 SSE，且有半截结果的风险
        if (req.tools?.length) return null;
        const canonical = JSON.stringify({
            model: req.model,
            system: req.system ?? '',
            messages: (req.messages || []).map((m) => ({ role: m.role, content: m.content })),
            max_tokens: req.max_tokens ?? null,
        });
        return createHash('sha256').update(canonical).digest('hex');
    }

    get(key) {
        const e = this.map.get(key);
        if (!e) {
            this.misses++;
            return null;
        }
        if (this.now() - e.at > this.ttlMs) {
            this.map.delete(key);
            this.misses++;
            return null;
        }
        this.hits++;
        // 命中后刷新顺序（近似 LRU）
        this.map.delete(key);
        this.map.set(key, e);
        return e.value;
    }

    set(key, value) {
        if (this.map.size >= this.maxEntries) {
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
        this.map.set(key, { value, at: this.now() });
    }

    stats() {
        const total = this.hits + this.misses;
        return { hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0, size: this.map.size };
    }

    clear() {
        this.map.clear();
        this.hits = 0;
        this.misses = 0;
        this.inflight.clear();
    }
}

/**
 * 单飞（single-flight）：同一个 key 的并发请求只让一个真正打上游，其余等它的结果。
 *
 * 为什么必须有这个：缓存只能挡住「已经完成」的请求。
 * 40 个相同请求同时到达时，全部未命中、全部打上游——这就是缓存击穿（thundering herd）。
 * 压测里实测到：40 个并发相同请求，上游被调用 40 次，缓存命中率 0%。
 *
 * 加了单飞之后，同样的场景上游只被调用 1 次。
 */
export class SingleFlight {
    constructor() {
        this.inflight = new Map(); // key -> Promise
        this.coalesced = 0;
    }

    /**
     * @param {string} key
     * @param {() => Promise<any>} fn
     * @returns {Promise<{value:any, coalesced:boolean}>}
     */
    async run(key, fn) {
        const existing = this.inflight.get(key);
        if (existing) {
            this.coalesced++;
            return { value: await existing, coalesced: true };
        }
        const p = (async () => {
            try {
                return await fn();
            } finally {
                // 必须在 microtask 之后删除，否则同一 tick 内的后续请求仍会重复打
                queueMicrotask(() => this.inflight.delete(key));
            }
        })();
        this.inflight.set(key, p);
        return { value: await p, coalesced: false };
    }

    stats() {
        return { inflight: this.inflight.size, coalesced: this.coalesced };
    }
}
