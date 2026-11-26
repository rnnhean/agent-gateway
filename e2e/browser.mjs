/**
 * 浏览器端到端测试（Playwright，无头）。
 *
 * 为什么必须有这个：API 测试证明不了页面能用。
 * 要验证的是「打开页面 → 数据渲染出来 → 点发送 → 看到真实答复」这条链路。
 *
 * 用法：
 *   node e2e/browser.mjs                    # 起自己的服务并测
 *   BASE_URL=http://127.0.0.1:8794 node e2e/browser.mjs   # 测已运行的服务
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve('results');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const base = process.env.BASE_URL || 'http://127.0.0.1:8796';
const checks = [];
const consoleErrors = [];

function check(name, ok, detail = '') {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 本机已装 chromium 但缺 chrome-headless-shell，显式指定可执行文件路径更稳
const EXE_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Users/v-renhan/AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe',
    'C:/Users/v-renhan/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe',
].filter(Boolean);
const exe = EXE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
console.log('浏览器:', exe || '默认');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// 收集页面级错误（未捕获异常、控制台 error）
page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
    // 1) 能打开
    const resp = await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30_000 });
    check('页面可打开', resp?.status() === 200, `HTTP ${resp?.status()}`);
    check('React 已挂载', (await page.locator('#root').count()) === 1);

    // 2) 关键区块渲染
    await page.waitForSelector('[data-testid="kpi-requests"]', { timeout: 15_000 });
    const reqText = await page.locator('[data-testid="kpi-requests"]').innerText();
    check('KPI 总请求已渲染', /^\d+$/.test(reqText.trim()), `值=${reqText.trim()}`);

    const okText = await page.locator('[data-testid="kpi-ok"]').innerText();
    check('KPI 成功率已渲染', okText.trim().length > 0, `值=${okText.trim()}`);

    const breakerRows = await page.locator('[data-testid="breaker-body"] tr').count();
    check('熔断状态表格已渲染', breakerRows >= 1, `${breakerRows} 行`);

    const tenantRows = await page.locator('[data-testid="tenant-body"] tr').count();
    check('租户表格已渲染', tenantRows >= 1, `${tenantRows} 行`);

    // 3) 图表：需要两次采样（间隔 3s）才有点——先等一轮刷新
    await page.waitForTimeout(4000);
    const svgPaths = await page.locator('svg[role="img"] path, svg[role="img"] circle').count();
    check('趋势图有内容', svgPaths > 0, `${svgPaths} 个 path`);

    // 4) 调试台：真实发送一次请求
    await page.fill('[aria-label="租户"]', 'e2e-browser');
    await page.fill('[aria-label="问题"]', '中国的首都是哪？只回答城市名。');
    const sendBtn = page.locator('[data-testid="send"]');
    check('发送按钮可见', await sendBtn.isVisible());

    await sendBtn.click();
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="meta"]');
        return el && String(el.textContent || '').length > 0 && !String(el.textContent).includes('请求中');
    }, { timeout: 120_000 });

    const output = await page.locator('[data-testid="output"]').innerText();
    const meta = await page.locator('[data-testid="meta"]').innerText();
    check('调试台返回非空答复', output.trim().length > 0, `答复=${output.trim().slice(0, 30)}`);
    check('调试台显示耗时信息', /\d+\s*ms/.test(meta), meta.slice(0, 80));

    // 5) 表格与图表可交互（刷新按钮）
    await page.click('button.ghost');
    await page.waitForTimeout(800);
    check('刷新后页面未崩溃', (await page.locator('[data-testid="kpi-requests"]').count()) === 1);

    // 6) 截图留证
    await page.screenshot({ path: path.join(OUT, `browser-${stamp}.png`), fullPage: true });

    // 7) 控制台无错误
    check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (e) {
    check('浏览器测试执行', false, String(e.message).slice(0, 200));
    await page.screenshot({ path: path.join(OUT, `browser-${stamp}-fail.png`), fullPage: true }).catch(() => {});
} finally {
    await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(OUT, `browser-${stamp}.json`), JSON.stringify({ base, checks, consoleErrors }, null, 2));
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
