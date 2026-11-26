/**
 * Provider 路由与故障转移。
 *
 * 三条策略，按优先级：
 *   1. 熔断器不开闸的 provider 才参与候选
 *   2. 按权重（或成本）选择
 *   3. 失败时转移到下一个候选，而不是重试同一个
 *
 * 为什么「转移到下一个」而不是「重试同一个」：
 *   部署里常见的情况是某个 provider 区域性故障或限流。重试同一个只会等更久，
 *   而换一个 provider 往往立刻成功。代价是不同 provider 的输出可能风格不同，
 *   所以只在「首次请求就失败」时转移；流式已经吐了内容就不转移（否则用户看到两段）。
 */
import { CircuitBreaker, isUpstreamFailure } from './breaker.mjs';

export class Router {
    /**
     * @param {object} o
     * @param {Array<{name:string, weight?:number, costPerMTok?:number, call:Function}>} o.providers
     * @param {CircuitBreaker} [o.breaker]
     * @param {(k:string)=>number} [o.random]
     */
    constructor({ providers, breaker = new CircuitBreaker(), random = Math.random }) {
        if (!providers?.length) throw new Error('至少需要一个 provider');
        this.providers = providers;
        this.breaker = breaker;
        this.random = random;
    }

    /** 当前的候选顺序：可用 provider 按权重加权随机 + 未选中者作为后备 */
    candidates() {
        const ok = this.providers.filter((p) => this.breaker.allow(p.name));
        if (!ok.length) return [];
        // 加权随机排序：权重大的更可能排第一
        const pool = [...ok];
        const ordered = [];
        while (pool.length) {
            const total = pool.reduce((a, p) => a + (p.weight ?? 1), 0);
            let r = this.random() * total;
            let idx = 0;
            for (let i = 0; i < pool.length; i++) {
                r -= pool[i].weight ?? 1;
                if (r <= 0) {
                    idx = i;
                    break;
                }
            }
            ordered.push(pool.splice(idx, 1)[0]);
        }
        return ordered;
    }

    /**
     * 发起调用，失败时按顺序转移。
     * @param {(provider:object)=>Promise<any>} invoke
     * @param {object} [o]
     * @param {(e:Error, provider:object, attempt:number)=>boolean} [o.shouldFailover]
     */
    async call(invoke, { shouldFailover = () => true } = {}) {
        const list = this.candidates();
        if (!list.length) {
            const e = new Error('所有 provider 都处于熔断状态');
            e.status = 503;
            e.kind = 'all_open';
            throw e;
        }
        const errors = [];
        for (const p of list) {
            try {
                const r = await invoke(p);
                this.breaker.record(p.name, true);
                return { provider: p.name, result: r, failovers: errors.length };
            } catch (err) {
                const status = err?.status ?? 0;
                const upstream = isUpstreamFailure(status, err);
                if (upstream) this.breaker.record(p.name, false);
                else this.breaker.record(p.name, true); // 调用方错误不算 provider 故障
                errors.push({ provider: p.name, status, message: String(err?.message || err) });
                if (!upstream || !shouldFailover(err, p, errors.length)) break;
            }
        }
        const e = new Error(`所有候选 provider 均失败：${errors.map((x) => `${x.provider}(${x.status})`).join(', ')}`);
        e.status = 502;
        e.kind = 'all_failed';
        e.details = errors;
        throw e;
    }

    stats() {
        return { providers: this.providers.map((p) => ({ name: p.name, weight: p.weight ?? 1 })), breaker: this.breaker.snapshot() };
    }
}
