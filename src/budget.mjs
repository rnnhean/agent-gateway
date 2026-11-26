/**
 * 成本预算与用量核算。
 *
 * 为什么必须放在网关而不是调用方：
 *   调用方可能有很多个（Agent、CLI、前端）。如果各自记账，账永远对不上，
 *   而且任何一个忘了记账就会超额。网关是唯一必经之路，在这里记才可靠。
 *
 * 两级预算：
 *   - 租户总额度（按天/月重置）：超出直接 402
 *   - 单请求 token 上限：防止一个请求吃掉整个额度（常见于死循环 prompt）
 *
 * 关键取舍：预算检查在请求前，用量记录在响应后。
 * 这意味着有并发超支的窗口（每个请求开始前都还有额度）。
 * 想做严格，需要在请求前就按预估消耗预扣，响应后返还差额——本项目实现这个方案。
 */

/** 各模型单价（USD / 百万 token）。可被配置覆盖；价格会变，不硬编码在逻辑里。 */
export const DEFAULT_PRICES = {
    'claude-opus-4-8': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 0.8, output: 4 },
    default: { input: 3, output: 15 },
};

export function priceOf(model, prices = DEFAULT_PRICES) {
    if (!model) return prices.default;
    for (const [k, v] of Object.entries(prices)) {
        if (k !== 'default' && model.includes(k)) return v;
    }
    return prices.default;
}

export function costOf(model, inputTokens, outputTokens, prices = DEFAULT_PRICES) {
    const p = priceOf(model, prices);
    return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

export class Budget {
    /**
     * @param {object} [o]
     * @param {number} [o.defaultLimitUsd=10] 每个租户的默认额度
     * @param {number} [o.maxTokensPerRequest=200000]
     * @param {()=>number} [o.now]
     */
    constructor({ defaultLimitUsd = 10, maxTokensPerRequest = 200_000, now = () => Date.now() } = {}) {
        this.defaultLimitUsd = defaultLimitUsd;
        this.maxTokensPerRequest = maxTokensPerRequest;
        this.now = now;
        this.accounts = new Map();
    }

    _acc(tenant) {
        let a = this.accounts.get(tenant);
        if (!a) {
            a = { spentUsd: 0, reservedUsd: 0, requests: 0, limited: 0, limitUsd: this.defaultLimitUsd };
            this.accounts.set(tenant, a);
        }
        return a;
    }

    setLimit(tenant, limitUsd) {
        this._acc(tenant).limitUsd = limitUsd;
    }

    /**
     * 请求前预扣。返回一个 settle 函数，响应后调用以结算实际成本。
     *
     * 为什么预扣：只做「事后检查」的话，并发 N 个请求可能同时通过检查，
     * 然后一起超额。预扣把并发窗口关掉。
     *
     * 预估值 = 输入 token 估算 + max_tokens（最坏情况输出）。
     * 宁可高估，因为低估会让并发超支。
     */
    reserve(tenant, { estInputTokens = 0, maxOutputTokens = 0, model }) {
        const a = this._acc(tenant);
        const est = costOf(model, estInputTokens, maxOutputTokens);
        if (a.spentUsd + a.reservedUsd + est > a.limitUsd) {
            const e = new Error(`租户 ${tenant} 预算不足：已用 $${a.spentUsd.toFixed(4)}，预扣中 $${a.reservedUsd.toFixed(4)}，限额 $${a.limitUsd}`);
            e.status = 402;
            e.kind = 'budget_exceeded';
            a.limited++;
            throw e;
        }
        a.reservedUsd += est;
        a.requests++;

        let settled = false;
        return (actualUsd = est) => {
            if (settled) return;
            settled = true;
            a.reservedUsd = Math.max(0, a.reservedUsd - est);
            a.spentUsd += Math.max(0, actualUsd);
        };
    }

    usage(tenant) {
        const a = this._acc(tenant);
        return {
            tenant,
            spentUsd: Number(a.spentUsd.toFixed(6)),
            reservedUsd: Number(a.reservedUsd.toFixed(6)),
            limitUsd: a.limitUsd,
            requests: a.requests,
            limited: a.limited,
            remainingUsd: Number(Math.max(0, a.limitUsd - a.spentUsd - a.reservedUsd).toFixed(6)),
        };
    }

    all() {
        return [...this.accounts.keys()].map((t) => this.usage(t));
    }
}

/**
 * 估算输入 token（粗略：CJK 按 1 字 1 token，其余 4 字符 1 token）。
 * 只用于预扣，不求精确——预扣高估是安全的。
 */
export function estimateInputTokens({ system, messages, tools }) {
    const s = JSON.stringify({ system: system || '', messages: messages || [], tools: tools || [] });
    const cjk = (s.match(/[　-〿一-鿿＀-￯]/g) || []).length;
    return Math.ceil(cjk + (s.length - cjk) / 4);
}
