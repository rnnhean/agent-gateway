/**
 * 令牌桶限流。
 *
 * 为什么用令牌桶而不是固定窗口计数：
 *   固定窗口在窗口边界会有「双倍突发」——59 秒用光 60 个，下一秒又满血 60 个。
 *   令牌桶按时间连续补充，天然平滑，且允许配置的突发容量。
 *
 * 关键设计：桶按 key 隔离（通常是租户或 api key 的哈希），
 * 并且用惰性补充——不在定时器里补，而在每次取令牌时按经过时间补。
 * 这样没有后台定时器，桶再多也不占 CPU。
 */
export class TokenBucket {
    /**
     * @param {object} o
     * @param {number} o.capacity 桶容量（允许的最大突发）
     * @param {number} o.refillPerSec 每秒补充的令牌数（≈ 稳态 QPS 上限）
     * @param {number} [o.now] 可注入时钟，便于测试
     */
    constructor({ capacity, refillPerSec, now = () => Date.now() }) {
        this.capacity = capacity;
        this.refillPerSec = refillPerSec;
        this.now = now;
        this.buckets = new Map();
    }

    /**
     * 尝试取 n 个令牌。
     * @returns {{allowed:boolean, remaining:number, retryAfterMs:number}}
     */
    take(key, n = 1) {
        const t = this.now();
        let b = this.buckets.get(key);
        if (!b) {
            b = { tokens: this.capacity, last: t };
            this.buckets.set(key, b);
        }
        // 惰性补充：按经过时间补，不超过容量
        const elapsed = Math.max(0, (t - b.last) / 1000);
        b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
        b.last = t;

        if (b.tokens >= n) {
            b.tokens -= n;
            return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
        }
        // 还差多少令牌 → 还要等多久
        const deficit = n - b.tokens;
        return { allowed: false, remaining: Math.floor(b.tokens), retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000) };
    }

    /** 定期清理长期未用的桶，防止内存随租户数无限增长 */
    gc(idleMs = 10 * 60_000) {
        const t = this.now();
        for (const [k, b] of this.buckets) if (t - b.last > idleMs) this.buckets.delete(k);
        return this.buckets.size;
    }
}

/**
 * 并发闸门：限制同时在飞的请求数（上游通常按并发而非 QPS 限你）。
 *
 * 与令牌桶的分工：
 *   令牌桶管「速率」——每秒能发多少个
 *   并发闸门管「同时」——同一时刻有多少个在跑
 * 两个都要，因为 LLM 请求耗时长（几秒到几十秒），只限速率不限并发会堆满连接。
 */
export class ConcurrencyGate {
    constructor(max) {
        this.max = max;
        this.active = 0;
        this.queue = [];
    }

    /** @returns {Promise<() => void>} 返回释放函数 */
    acquire() {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve(() => this.release());
        }
        return new Promise((resolve) => {
            this.queue.push(() => {
                this.active++;
                resolve(() => this.release());
            });
        });
    }

    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) next();
    }

    get stats() {
        return { active: this.active, queued: this.queue.length, max: this.max };
    }
}
