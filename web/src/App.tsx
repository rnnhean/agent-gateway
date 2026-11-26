import { useEffect, useMemo, useRef, useState } from 'react';

/** 网关状态类型：与 /health 返回一致 */
interface GatewayStats {
  ok: boolean;
  version: string;
  uptimeSec: number;
  limiter: { buckets: number };
  gate: { active: number; queued: number; max: number };
  cache: { hits: number; misses: number; hitRate: number; size: number; coalesced: number };
  breaker: Record<string, { state: string; failures: number }>;
}

interface TenantUsage {
  tenant: string;
  spentUsd: number;
  reservedUsd: number;
  limitUsd: number;
  requests: number;
  limited: number;
  remainingUsd: number;
}

interface Metrics {
  requests: number;
  outcome: Record<string, number>;
  latency: Record<string, number>;
  ttft: Record<string, number>;
}

/** 解析 Prometheus 文本格式。只取页面需要的几个指标。 */
function parseMetrics(text: string): Metrics {
  const num = (re: RegExp): number => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  const outcome: Record<string, number> = {};
  for (const m of text.matchAll(/^gateway_outcome_total\{outcome="([^"]+)"\} (\d+)$/gm)) outcome[m[1]] = Number(m[2]);
  const quantile = (prefix: string): Record<string, number> => {
    const out: Record<string, number> = {};
    // 注意转义：模板字符串里写 \\{ 才会传给 RegExp 一个 \{（表示字面量左花括号）
    const re = new RegExp(`^${prefix}\\{quantile="([^"]+)"\\} ([0-9.]+)$`, 'gm');
    for (const m of text.matchAll(re)) out[m[1]] = Number(m[2]);
    return out;
  };
  return {
    requests: num(/^gateway_requests_total (\d+)$/m),
    outcome,
    latency: quantile('gateway_latency_ms'),
    ttft: quantile('gateway_ttft_ms'),
  };
}

const fmtMs = (v: number | undefined) => (v == null ? '-' : `${v.toFixed(0)} ms`);
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 无依赖折线图：把序列缩放到视口 */
function Sparkline({ series, colors }: { series: { data: number[]; color: string; label: string }[]; colors?: string[] }) {
  const W = 640;
  const H = 140;
  const P = 8;
  const max = Math.max(1, ...series.flatMap((s) => s.data));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 150, display: 'block' }} role="img" aria-label="请求趋势图">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(88,166,255,0.35)" />
          <stop offset="100%" stopColor="rgba(88,166,255,0)" />
        </linearGradient>
      </defs>
      {series.map((s, i) => {
        if (s.data.length === 1) {
          // 只有一个采样点时画个点，否则页面刚打开时图表是空的，看起来像坏了
          const step = (W - P * 2) / Math.max(1, s.data.length - 1);
          const y = H - P - (s.data[0] / max) * (H - P * 2);
          return <circle key={s.label} cx={P + (s.data.length - 1) * step} cy={y} r={3} fill={colors?.[i] ?? s.color} />;
        }
        if (s.data.length < 2) return null;
        const step = (W - P * 2) / Math.max(1, s.data.length - 1);
        const d = s.data
          .map((v, idx) => `${idx ? 'L' : 'M'}${(P + idx * step).toFixed(1)},${(H - P - (v / max) * (H - P * 2)).toFixed(1)}`)
          .join(' ');
        return (
          <g key={s.label}>
            {i === 0 && <path d={`${d} L${W - P},${H - P} L${P},${H - P} Z`} fill="url(#fill)" />}
            <path d={d} fill="none" stroke={colors?.[i] ?? s.color} strokeWidth={i === 0 ? 2 : 1.6} />
          </g>
        );
      })}
    </svg>
  );
}

function Card({ title, span, children }: { title: string; span: number; children: React.ReactNode }) {
  return (
    <section className="card" style={{ gridColumn: `span ${span}` }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function App() {
  const [stats, setStats] = useState<GatewayStats | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tenants, setTenants] = useState<TenantUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [qps, setQps] = useState<number[]>([]);
  const [p50, setP50] = useState<number[]>([]);
  const prev = useRef<{ reqs: number; t: number } | null>(null);

  async function refresh() {
    try {
      const [h, m, u] = await Promise.all([
        fetch('/health').then((r) => r.json() as Promise<GatewayStats>),
        fetch('/metrics').then((r) => r.text()),
        fetch('/api/usage').then((r) => r.json() as Promise<{ tenants: TenantUsage[] }>),
      ]);
      const parsed = parseMetrics(m);
      setStats(h);
      setMetrics(parsed);
      setTenants((u.tenants || []).filter((t) => t.requests > 0));
      setError(null);

      const now = Date.now();
      if (prev.current) {
        const dt = (now - prev.current.t) / 1000;
        const dq = dt > 0 ? (parsed.requests - prev.current.reqs) / dt : 0;
        setQps((s) => [...s, Math.max(0, dq)].slice(-60));
        setP50((s) => [...s, parsed.latency['0.5'] ?? 0].slice(-60));
      }
      prev.current = { reqs: parsed.requests, t: now };
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const totals = useMemo(() => {
    if (!metrics) return { ok: 0, cache: 0, total: 0, cost: 0 };
    const ok = (metrics.outcome.ok ?? 0) + (metrics.outcome.coalesced ?? 0);
    return {
      ok,
      cache: metrics.outcome.cache_hit ?? 0,
      total: metrics.requests,
      cost: tenants.reduce((a, t) => a + t.spentUsd, 0),
    };
  }, [metrics, tenants]);

  return (
    <>
      <header>
        <h1>Agent Gateway</h1>
        <span className={`dot ${error ? '' : 'on'}`} aria-hidden />
        <span className="muted">{error ? `连接失败：${error}` : stats ? `运行 ${stats.uptimeSec}s · v${stats.version}` : '连接中…'}</span>
        <span className="spacer" />
        <button className="ghost" onClick={refresh}>刷新</button>
      </header>

      <main>
        <section className="kpi" style={{ gridColumn: 'span 12', display: 'grid', gap: 14, gridTemplateColumns: 'repeat(4,1fr)' }}>
          <div className="card"><div className="v" data-testid="kpi-requests">{totals.total}</div><div className="l">总请求</div></div>
          <div className="card"><div className="v ok" data-testid="kpi-ok">{totals.total ? fmtPct(totals.ok / totals.total) : '-'}</div><div className="l">成功（含合并）</div></div>
          <div className="card"><div className="v" data-testid="kpi-cache">{totals.total ? fmtPct(totals.cache / totals.total) : '-'}</div><div className="l">缓存命中率</div></div>
          <div className="card"><div className="v" data-testid="kpi-cost">${totals.cost.toFixed(4)}</div><div className="l">累计成本 (USD)</div></div>
        </section>

        <Card title="请求趋势（最近 60 次采样）" span={8}>
          <Sparkline
            series={[
              { data: qps, color: '#58a6ff', label: 'qps' },
              { data: p50, color: '#a371f7', label: 'p50' },
            ]}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>蓝：请求/秒　紫：p50 延迟(ms)</div>
        </Card>

        <Card title="延迟与限流" span={4}>
          <table><tbody>
            <tr><td className="muted">p50 延迟</td><td>{fmtMs(metrics?.latency['0.5'])}</td></tr>
            <tr><td className="muted">p95 延迟</td><td>{fmtMs(metrics?.latency['0.95'])}</td></tr>
            <tr><td className="muted">p99 延迟</td><td>{fmtMs(metrics?.latency['0.99'])}</td></tr>
            <tr><td className="muted">TTFT p50</td><td>{fmtMs(metrics?.ttft['0.5'])}</td></tr>
            <tr><td className="muted">并发闸门</td><td>{stats ? `${stats.gate.active}/${stats.gate.max}（排队 ${stats.gate.queued}）` : '-'}</td></tr>
            <tr><td className="muted">限流桶</td><td>{stats?.limiter.buckets ?? '-'}</td></tr>
          </tbody></table>
        </Card>

        <Card title="Provider 熔断状态" span={6}>
          <table>
            <thead><tr><th>Provider</th><th>状态</th><th>连续失败</th></tr></thead>
            <tbody data-testid="breaker-body">
              {Object.entries(stats?.breaker ?? {}).length === 0 ? (
                <tr><td colSpan={3} className="muted">所有 provider 正常，无熔断记录</td></tr>
              ) : (
                Object.entries(stats!.breaker).map(([name, v]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td><span className={`tag ${v.state}`}>{v.state}</span></td>
                    <td>{v.failures}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>

        <Card title="租户用量" span={6}>
          <table>
            <thead><tr><th>租户</th><th>请求</th><th>已用</th><th>额度</th></tr></thead>
            <tbody data-testid="tenant-body">
              {tenants.length === 0 ? (
                <tr><td colSpan={4} className="muted">暂无用量</td></tr>
              ) : (
                tenants.map((t) => {
                  const pct = t.limitUsd ? Math.min(100, (t.spentUsd / t.limitUsd) * 100) : 0;
                  return (
                    <tr key={t.tenant}>
                      <td>{t.tenant}</td><td>{t.requests}</td><td>${t.spentUsd.toFixed(4)}</td>
                      <td><div className="bar"><i style={{ width: `${pct.toFixed(1)}%` }} /></div></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Card>

        <Playground onDone={refresh} />
      </main>
    </>
  );
}

/** 调试台：真实调用网关，支持流式，显示 TTFT 与成本 */
function Playground({ onDone }: { onDone: () => void }) {
  const [tenant, setTenant] = useState('console');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('用一句话解释什么是令牌桶限流。');
  const [stream, setStream] = useState(true);
  const [out, setOut] = useState('等待发送…');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<string>('');

  async function send() {
    setBusy(true);
    setOut('');
    setMeta('请求中…');
    const t0 = performance.now();
    try {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant': tenant },
        body: JSON.stringify({ model: model || 'default-model', messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0, stream }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setOut(`HTTP ${r.status} ${j.error?.type ?? ''}\n${j.error?.message ?? ''}`);
        setMeta('失败');
        return;
      }
      if (stream) {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let first: number | null = null;
        let text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (!p || p === '[DONE]') continue;
            try {
              const e = JSON.parse(p);
              const t: string | undefined = e.choices?.[0]?.delta?.content;
              if (t) {
                if (first == null) first = performance.now() - t0;
                text += t;
                setOut(text);
              }
            } catch {
              /* 忽略非 JSON 行 */
            }
          }
        }
        setOut(text);
        setMeta(`首字 ${first?.toFixed(0) ?? '?'} ms · 总 ${(performance.now() - t0).toFixed(0)} ms`);
      } else {
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content ?? '(空)';
        setOut(text);
        setMeta(`${(performance.now() - t0).toFixed(0)} ms · ${r.headers.get('x-gateway-provider')} · $${r.headers.get('x-gateway-cost-usd')} · ${JSON.stringify(j.usage)}`);
      }
    } catch (e) {
      setOut(`请求失败：${(e as Error).message}`);
      setMeta('失败');
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <Card title="调试台 · 真实调用" span={12}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input aria-label="租户" value={tenant} onChange={(e) => setTenant(e.target.value)} style={{ flex: '0 0 140px' }} />
        <input aria-label="模型" placeholder="模型名（留空则用服务默认）" value={model} onChange={(e) => setModel(e.target.value)} />
        <label className="row" style={{ flex: '0 0 auto', gap: 6 }}>
          <input type="checkbox" aria-label="流式" checked={stream} onChange={(e) => setStream(e.target.checked)} style={{ width: 'auto' }} /> 流式
        </label>
        <button onClick={send} disabled={busy} style={{ flex: '0 0 auto' }} data-testid="send">
          {busy ? '请求中…' : '发送'}
        </button>
      </div>
      <textarea aria-label="问题" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <pre data-testid="output">{out}</pre>
      {meta && <div className="muted" style={{ fontSize: 12, marginTop: 6 }} data-testid="meta">{meta}</div>}
    </Card>
  );
}
