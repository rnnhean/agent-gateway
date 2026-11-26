# SPEC — 设计契约

## 1. 目标与非目标

### 目标
1. **过载保护**：限流（速率）+ 并发闸门（同时在飞）+ 熔断（上游故障快速失败）。
2. **高可用**：加权路由 + 故障转移；上游全挂时响应时间 < 100ms。
3. **成本可控**：按租户预算预扣与结算，杜绝并发超支。
4. **不重复计费**：精确缓存 + 单飞合并。
5. **可观测**：Prometheus 指标 + React 控制台实时看板。
6. **接入零成本**：OpenAI 兼容入口，改 base_url 即可。

### 非目标
- 鉴权与多租户体系（仅 x-tenant 透传）
- 分布式限流（单机）
- 语义缓存
- 训练/微调

## 2. 请求处理顺序（不可调换）

1. 限流（令牌桶，按 tenant）— 缓存命中也要计
2. 单请求 token 上限
3. 预算预扣
4. 精确缓存查询
5. 单飞合并（同 key）
6. 并发闸门
7. 路由 + 故障转移
8. 结算 + 指标

理由：便宜的、能挡掉请求的放前面；会占用资源的放后面。

## 3. 限流

令牌桶，按 tenant 隔离，惰性补充（按经过时间），无后台定时器。

| 参数 | 默认 | 含义 |
|---|---|---|
| `capacity` | 60 | 允许的突发 |
| `refillPerSec` | 10 | 稳态速率 |

拒绝时返回 429 + `retryAfterMs`，并设置 `Retry-After` 头。

## 4. 熔断

按 provider 隔离的三态机：

- `closed`：放行
- `open`：直接拒绝（`failureThreshold` 默认 5，`cooldownMs` 默认 30s）
- `half-open`：只放 1 个探测

**只有可判定为上游问题的错误才计入失败**：429 / 408 / 5xx / 网络错误。400/401 等调用方错误不计入。

## 5. 路由与故障转移

按权重加权随机排序，依次尝试。**遇到调用方错误（非上游故障）立即停止**，不换 provider。

流式**不做故障转移**：一旦开始吐内容，换源会让用户看到重复片段。

## 6. 缓存与单飞

精确缓存 key = sha256(model + system + messages + max_tokens)。

不缓存的请求：`temperature > 0`、`stream: true`、带 `tools`。

单飞：同 key 并发请求只打一次上游，其余等待同一 Promise。

## 7. 预算

```
预扣 = cost(model, estInputTokens, max_tokens)
结算 = cost(model, realInput, realOutput)
```

预扣不足时返回 402。重复结算幂等（只生效一次）。

## 8. 流式

- 真 SSE 透传，`x-accel-buffering: no`
- 客户端断开 → abort 上游
- 思考块（thinking）不发给调用方，也不计入 TTFT
- 流结束发 `[DONE]`

## 9. 指标

`gateway_requests_total`、`gateway_outcome_total{outcome}`、`gateway_tenant_requests_total{tenant}`、`gateway_tenant_errors_total{tenant}`、`gateway_tenant_cached_total{tenant}`、`gateway_latency_ms{quantile}`、`gateway_ttft_ms{quantile}`、`gateway_first_token_samples`。

## 10. 前端

React 18 + Vite 5 + TypeScript。单页看板：

- KPI：总请求 / 成功率 / 缓存命中率 / 累计成本
- 趋势图（SVG 手绘，2 条折线）
- 延迟与限流表
- 熔断状态表
- 租户用量表
- 调试台：真实调用，支持流式，显示 TTFT 与成本

构建产物由 node 服务托管，SPA 路由回落 `index.html`；`/api`、`/v1`、`/health`、`/metrics` 优先于静态回落。

## 11. 验收标准

1. `npm test` 41 项全绿
2. `npm run bench` 8 项判定全绿
3. 真实模型：非流式返回正确内容；流式分片正确、有 `[DONE]`
4. 容器内 `/` 返回 React 页面，`/health` 正常
5. Playwright 无头测试 12 项全绿（含真实调用）
