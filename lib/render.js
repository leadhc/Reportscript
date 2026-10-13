// Playwright 渲染取证模块（移植自实战验证的 report-jsntcygg.com/render.js）。
//
// 核心纪律（实施计划决策 #3）：渲染入口【永远从输入 URL goto】，让浏览器自己
// 跟随 302。A 页 catch-all 302 的动态 token 每次刷新，浏览器实时跟随拿到的才是
// 当场有效的 token。禁止用 probe 阶段抓到的旧 B URL 渲染——过期假证据。
//
// 沙箱说明：Edge 启动需写系统用户目录，受限沙箱环境会被拦——启动失败时
// 返回人话提示（在普通终端运行），不裸抛堆栈。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { WXUA, TIMEOUTS } = require('./constants');
const { getAbortSignal } = require('./net');

/** 付费原话候选提取：按行匹配，去重，短行（<60字）。
 *  注意：这是「候选」，最终进信由 letter 层拼装，信件生成后必须人工复核。 */
function extractPaidQuotes(text) {
  const lines = text.split(' | ');
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t && t.length < 60 && /付费|仅供参考|解锁|[\d.]+元|会员/.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 启动浏览器：优先项目默认通道，失败自动回落 Playwright 自带 Chromium。
 *  - 本机 Windows：默认 Edge（msedge）
 *  - 容器 / Linux：无 Edge，直接用自带 Chromium（镜像 mcr.microsoft.com/playwright 已内置）
 *  - 可用环境变量 BROWSER_CHANNEL 强制指定（如 msedge / chrome / chromium）
 *  Linux 下补 --no-sandbox / --disable-dev-shm-usage（容器内 headless 必需）。 */
async function launchBrowser() {
  const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'];
  if (process.platform !== 'win32') args.push('--no-sandbox');

  const attempts = [];
  const forced = process.env.BROWSER_CHANNEL;
  if (forced) attempts.push({ channel: forced });
  else if (process.platform === 'win32') attempts.push({ channel: 'msedge' });
  attempts.push({}); // 兜底：Playwright 自带 Chromium

  const errors = [];
  for (const a of attempts) {
    try {
      return await chromium.launch({ headless: true, args, ...a });
    } catch (e) {
      errors.push(`${a.channel || 'chromium'}: ${String(e && e.message).slice(0, 100)}`);
    }
  }
  throw new Error(`浏览器启动失败（已尝试 ${attempts.map(a => a.channel || 'chromium').join(' / ')}）：${errors.join('；')}`);
}

/**
 * 导航并返回结果（**永不抛**）：优先进 DOMContentLoaded，超时再退到 commit。
 * 这些违规页常见广告/统计/长连接资源永不结束，等 `load` 会白等 35s 并直接判失败；
 * DOMContentLoaded 在 DOM 解析完成即触发，是最稳的「页面已出来」信号。
 * @returns {{waitUntil: string|null, error: Error|null}}
 */
async function navigate(p, url) {
  const plans = [
    { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.render },
    { waitUntil: 'commit', timeout: 10000 },
  ];
  let lastErr = null;
  for (const plan of plans) {
    try {
      await p.goto(url, { waitUntil: plan.waitUntil, timeout: plan.timeout });
      return { waitUntil: plan.waitUntil, error: null };
    } catch (e) {
      lastErr = e;
    }
  }
  return { waitUntil: null, error: lastErr };
}

/**
 * 渲染取证。
 * 导航用 DOMContentLoaded（不再赌 `load`）并带 commit 兜底；整页截图失败降级为首屏截图。
 * @param {string} inputUrl 入口 URL（原样，浏览器跟随跳转）
 * @param {string} outDir 报告目录
 * @returns {Promise<object>} renderResult（失败时 { error }，永不抛异常）
 */
async function renderEvidence(inputUrl, outDir) {
  let b;
  try {
    b = await launchBrowser();
  } catch (e) {
    return { error: String(e && e.message).slice(0, 240) };
  }

  // 取消取证：外部中止时立刻关掉浏览器，让在途 goto / 截图 尽快失败退出
  const sig = getAbortSignal();
  const onAbort = () => { b.close().catch(() => { /* ignore */ }); };
  if (sig) sig.addEventListener('abort', onAbort, { once: true });

  try {
    const ctx = await b.newContext({
      viewport: { width: 414, height: 896 },
      deviceScaleFactor: 2,
      userAgent: WXUA,
    });
    const p = await ctx.newPage();
    const warnings = [];

    // 导航：不赌 `load`（广告/统计/长连接常让它永不触发），改用 DOMContentLoaded；
    // 超时再退到 commit（收到响应即算成功），两者都失败才看「页面是否已打开」定夺。
    const nav = await navigate(p, inputUrl);
    if (nav.error) {
      const cur = p.url();
      if (!cur || cur === 'about:blank') throw nav.error; // 压根没打开任何页面
      warnings.push(`导航未在超时内完成，已按已加载内容尽力抓取，结果可能不完整`);
    }

    // 给前端 JS 渲染/跳转留出时间（A 页 JS 跳 B 的常见形态依赖这段等待）
    await p.waitForTimeout(3500);

    const info = await p.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').replace(/\n+/g, ' | ').slice(0, 500),
    })).catch(() => ({ url: p.url(), title: '', text: '' }));

    // 截图命名：<域名>_<用途>.png（规格书第 1 节约定）
    let safeHost = 'unknown';
    try { safeHost = new URL(info.url).hostname.replace(/[^a-z0-9.-]/gi, '_'); } catch { /* keep */ }
    const shotViewport = `${safeHost}_首屏.png`;
    const shotFull = `${safeHost}_整页.png`;
    await p.screenshot({ path: path.join(outDir, shotViewport), fullPage: false, timeout: TIMEOUTS.render });

    // 整页截图可能因超长页面/资源挂起而失败——降级为首屏截图，不让整次取证挂掉
    const screenshots = { viewport: shotViewport };
    try {
      await p.screenshot({ path: path.join(outDir, shotFull), fullPage: true, timeout: TIMEOUTS.render });
      screenshots.fullPage = shotFull;
    } catch (e) {
      warnings.push(`整页截图失败（${String(e && e.message).slice(0, 80)}），仅保留首屏截图`);
    }

    // 渲染后 DOM 快照（与 b_raw.html 空壳对照，正是「JS 渲染」的证据）
    const domSnapshot = 'b_rendered.html';
    fs.writeFileSync(path.join(outDir, domSnapshot), await p.content());

    // 截图体积告警（>5MB 提示压缩，不自动处理）
    for (const f of Object.values(screenshots)) {
      try {
        const sz = fs.statSync(path.join(outDir, f)).size;
        if (sz > 5 * 1024 * 1024) {
          warnings.push(`${f} 约 ${(sz / 1024 / 1024).toFixed(1)}MB，附件可能超邮箱限制，发送前需压缩`);
        }
      } catch { /* 文件异常不阻塞 */ }
    }

    return {
      entryUrl: inputUrl,
      finalUrl: info.url,
      title: info.title || null,
      text: info.text,
      paidQuotes: extractPaidQuotes(info.text),
      screenshots,
      domSnapshot,
      warnings,
      error: null,
    };
  } catch (e) {
    return { error: '渲染失败：' + String(e && e.message).slice(0, 160) };
  } finally {
    if (sig) sig.removeEventListener('abort', onAbort);
    try { await b.close(); } catch { /* 已关 */ }
  }
}

module.exports = { renderEvidence, extractPaidQuotes, navigate };
