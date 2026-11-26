/**
 * 网关指标。与其它项目的指标同构（Prometheus 文本格式、零 SDK），
 * 但维度不同——网关是按「租户 + 结果类型」看的。
 *
 * 选这几个维度的理由：
 *   outcome  —— 失败的原因分布（限流 / 预算 / 熔断 / 上游错误 / 缓存命中）
 *   tenant   —— 谁在用（找出异常租户，做出额度调整）
 *   延迟     —— 网关自身开销 vs 上游延迟
 */
export class Metrics {
    constructor() {
        this.requests = 0;
        this.byOutcome = {};
        this.byTenant = {};
        this.latencySumMs = 0;
        this.latencySamples = 0;
        this.latencies = []; // 保留最近 N 个用于分位数
        this.maxSamples = 2000;
        this.firstTokenMs = [];
    }

    /** 流式首 token 时间（TTFT）。只统计真正吐过内容的请求。 */
    markFirstToken(ms) {
        this.firstTokenMs.push(ms);
        if (this.firstTokenMs.length > this.maxSamples) this.firstTokenMs.shift();
    }

    _q(arr, q) {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        return Number(s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2));
    }

    observe({ tenant = 'anonymous', outcome = 'ok', ms = 0, failovers = 0, cached = false, status }) {
        this.requests++;
        this.byOutcome[outcome] = (this.byOutcome[outcome] || 0) + 1;
        const t = (this.byTenant[tenant] = this.byTenant[tenant] || { requests: 0, errors: 0, cached: 0, failovers: 0 });
        t.requests++;
        if (outcome !== 'ok' && outcome !== 'cache_hit') t.errors++;
        if (cached) t.cached++;
        t.failovers += failovers || 0;

        this.latencySumMs += ms;
        this.latencySamples++;
        this.latencies.push(ms);
        if (this.latencies.length > this.maxSamples) this.latencies.shift();
        void status;
    }

    p(q) {
        if (!this.latencies.length) return 0;
        const s = [...this.latencies].sort((a, b) => a - b);
        const idx = Math.min(s.length - 1, Math.floor(s.length * q));
        return Number(s[idx].toFixed(2));
    }

    renderPrometheus() {
        const L = [];
        const c = (name, help, v) => L.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${v}`);
        c('gateway_requests_total', '网关请求总数', this.requests);
        L.push('# HELP gateway_outcome_total 按结果分类的请求数', '# TYPE gateway_outcome_total counter');
        for (const [k, v] of Object.entries(this.byOutcome)) L.push(`gateway_outcome_total{outcome="${k}"} ${v}`);
        L.push('# HELP gateway_tenant_requests_total 按租户的请求数', '# TYPE gateway_tenant_requests_total counter');
        for (const [k, v] of Object.entries(this.byTenant)) L.push(`gateway_tenant_requests_total{tenant="${k}"} ${v.requests}`);
        L.push('# HELP gateway_tenant_errors_total 按租户的错误数', '# TYPE gateway_tenant_errors_total counter');
        for (const [k, v] of Object.entries(this.byTenant)) L.push(`gateway_tenant_errors_total{tenant="${k}"} ${v.errors}`);
        L.push('# HELP gateway_tenant_cached_total 按租户的缓存命中数', '# TYPE gateway_tenant_cached_total counter');
        for (const [k, v] of Object.entries(this.byTenant)) L.push(`gateway_tenant_cached_total{tenant="${k}"} ${v.cached}`);
        c('gateway_latency_ms_sum', '延迟累计（毫秒）', this.latencySumMs.toFixed(2));
        c('gateway_latency_ms_count', '延迟采样数', this.latencySamples);
        L.push('# HELP gateway_latency_ms 延迟分位数（来自最近样本）', '# TYPE gateway_latency_ms gauge');
        L.push(`gateway_latency_ms{quantile="0.5"} ${this.p(0.5)}`);
        L.push(`gateway_latency_ms{quantile="0.95"} ${this.p(0.95)}`);
        L.push(`gateway_latency_ms{quantile="0.99"} ${this.p(0.99)}`);
        L.push('# HELP gateway_ttft_ms 流式首 token 时间分位数', '# TYPE gateway_ttft_ms gauge');
        L.push(`gateway_ttft_ms{quantile="0.5"} ${this._q(this.firstTokenMs, 0.5)}`);
        L.push(`gateway_ttft_ms{quantile="0.95"} ${this._q(this.firstTokenMs, 0.95)}`);
        L.push(`gateway_ttft_ms{quantile="0.99"} ${this._q(this.firstTokenMs, 0.99)}`);
        c('gateway_first_token_samples', 'TTFT 采样数', this.firstTokenMs.length);
        return L.join('\n') + '\n';
    }
}
