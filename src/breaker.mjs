/**
 * 熔断器（circuit breaker）。
 *
 * 为什么需要：上游挂了的时候，最糟的做法是「继续重试」。每个请求都等超时、
 * 占住并发、拖垮自己的队列。熔断器的作用是**快速失败**——认了，别再打了。
 *
 * 三态机：
 *   closed    —— 正常放行；连续失败达阈值 → open
 *   open      —— 直接拒绝；冷却期结束 → half-open
 *   half-open —— 放少量探测请求；成功 → closed；失败 → open
 *
 * 关键设计取舍：
 *   - 按「按 provider 隔离」，不是全局。一个 provider 挂了不该影响另一个。
 *   - half-open 只放 1 个探测请求，不是固定比例——探测多了等于没熔断。
 *   - 只统计「可判定为上游问题」的错误（429/5xx/网络），参数错不算失败，
 *     否则用户传错参数会把 provider 熔断掉。
 */
export class CircuitBreaker {
    /**
     * @param {object} o
     * @param {number} [o.failureThreshold=5] 连续失败多少次开闸
     * @param {number} [o.cooldownMs=30000] open 状态持续多久后进入 half-open
     * @param {number} [o.now]
     */
    constructor({ failureThreshold = 5, cooldownMs = 30_000, now = () => Date.now() } = {}) {
        this.failureThreshold = failureThreshold;
        this.cooldownMs = cooldownMs;
        this.now = now;
        this.states = new Map(); // key -> {state, failures, openedAt, probing}
    }

    _get(key) {
        let s = this.states.get(key);
        if (!s) {
            s = { state: 'closed', failures: 0, openedAt: 0, probing: false };
            this.states.set(key, s);
        }
        return s;
    }

    /** 是否允许放行；half-open 下只放一个探测 */
    allow(key) {
        const s = this._get(key);
        if (s.state === 'closed') return true;
        if (s.state === 'open') {
            if (this.now() - s.openedAt >= this.cooldownMs) {
                s.state = 'half-open';
                s.probing = true;
                return true; // 放一个探测
            }
            return false;
        }
        // half-open：已有探测在飞就不放新的
        if (s.probing) return false;
        s.probing = true;
        return true;
    }

    /** @param {boolean} ok 这次调用成功吗 */
    record(key, ok) {
        const s = this._get(key);
        if (ok) {
            s.state = 'closed';
            s.failures = 0;
            s.probing = false;
            return;
        }
        if (s.state === 'half-open') {
            // 探测失败：重新开闸，冷却期重算
            s.state = 'open';
            s.openedAt = this.now();
            s.probing = false;
            return;
        }
        s.failures++;
        if (s.failures >= this.failureThreshold) {
            s.state = 'open';
            s.openedAt = this.now();
        }
    }

    /** 某个 key 被拒绝时，还要等多久才可能放行 */
    retryAfterMs(key) {
        const s = this._get(key);
        if (s.state !== 'open') return 0;
        return Math.max(0, this.cooldownMs - (this.now() - s.openedAt));
    }

    snapshot() {
        const out = {};
        for (const [k, s] of this.states) out[k] = { state: s.state, failures: s.failures };
        return out;
    }

    reset(key) {
        if (key) this.states.delete(key);
        else this.states.clear();
    }
}

/**
 * 判定一个错误是否算「上游故障」。
 * 参数错（400/401）不算——那是调用方的问题，熔断它毫无意义。
 */
export function isUpstreamFailure(status, err) {
    if (status === 429 || status === 408) return true;
    if (status >= 500) return true;
    if (status === 0 || status == null) return true; // 网络错误
    if (err && /ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/i.test(String(err.message || err))) return true;
    return false;
}
