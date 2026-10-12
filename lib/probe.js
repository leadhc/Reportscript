// 侦察模块：类型判断 + 跳转链跟踪 + 业务路径探测 + www 变体 + 最终页抓取。
// 只产出 probeResult 对象，不认识 terrain/letter。
//
// 纪律：跳转由 fetchRaw(manual) 上层循环控制（≤5 跳防环）；
//       Cookie 不跨跳转转发（无 cookie jar，与 curl 语义一致）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchRaw, normalizeLocation } = require('./net');
const {
  WXUA, PLAIN_UA, BUSINESS_PATHS, TIMEOUTS, MAX_REDIRECTS, SECOND_LEVEL_SUFFIXES,
} = require('./constants');

/** 注册域提取（零依赖：常见二级后缀表 + 兜底取最后两段）。 */
function registrableDomain(host) {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

function md5(buf) {
  return crypto.createHash('md5').update(Buffer.from(buf)).digest('hex');
}

function extractTitle(htmlText) {
  const m = htmlText.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractIframeSrc(htmlText) {
  const m = htmlText.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function bodyToText(body) {
  return Buffer.from(body).toString('utf8');
}

/** 单跳请求（微信 UA + 15s 超时）。 */
async function hop(url) {
  const t0 = Date.now();
  const r = await fetchRaw(url, { timeoutMs: TIMEOUTS.probe, userAgent: WXUA });
  return { r, ms: Date.now() - t0 };
}

/**
 * 探测目标。输入 URL（微信里拿到的投放地址，原样），输出 probeResult。
 * @param {string} inputUrl
 * @param {string} outDir 报告目录（b_raw.html 等落盘处）
 */
async function probeTarget(inputUrl, outDir) {
  const input = new URL(inputUrl);
  const registrable = registrableDomain(input.hostname);
  const result = {
    type: null,            // redirect | direct | iframe-shell | blocked
    template: null,        // 'A' | 'B' | null(人工裁决)
    chain: [],             // 每跳 {url,status,location,server,ms}
    finalUrl: null,
    finalRegistrableDomain: null,
    finalRaw: null,        // {md5, sizeBytes, file, contentEncoding, title}
    catchAll: null,        // {host, count} catch-all 跳转壳判定
    businessPaths: [],     // 23 条 {path,status,location,ms}
    wwwVariant: null,      // {url,status,md5,sizeBytes,title,file}
    blocked: null,         // blocked 时的详情 {wxTried, plainTried, statuses}
  };

  // ── 首跳与跳转链 ──────────────────────────────────────────────
  let currentUrl = inputUrl;
  let first = await hop(currentUrl);
  let firstBodyText = first.r.ok ? bodyToText(first.r.body) : '';
  let lastResponse = first; // 最新一跳的响应（链尾/直出页），最终页落盘用

  // blocked：403/5xx/网络失败 → 换裸 UA 重试一次
  const isBlocked = !first.r.ok || (first.r.status >= 400) || first.r.status === 0;
  if (isBlocked) {
    const plain = await fetchRaw(inputUrl, { timeoutMs: TIMEOUTS.probe, userAgent: PLAIN_UA });
    result.type = 'blocked';
    result.template = null;
    result.blocked = {
      wxTried: { ok: first.r.ok, status: first.r.ok ? first.r.status : null, error: first.r.error || null },
      plainTried: { ok: plain.ok, status: plain.ok ? plain.status : null, error: plain.error || null },
    };
    if (!plain.ok || plain.status >= 400) {
      // 仍失败：如实记录，业务路径照测（规格书教训：根路径死了业务路径可能活着）
      result.businessPaths = await probeBusinessPaths(inputUrl);
      return result;
    }
    // 裸 UA 成功：以裸 UA 结果作为直出页继续
    first = { r: plain, ms: null };
    firstBodyText = bodyToText(plain.body);
    lastResponse = first;
  }

  // 记录首跳
  result.chain.push({
    url: currentUrl,
    status: first.r.ok ? first.r.status : null,
    location: first.r.ok ? (first.r.headers['location'] || null) : null,
    server: first.r.ok ? (first.r.headers['server'] || null) : null,
    ms: first.ms,
    error: first.r.ok ? undefined : first.r.error,
  });

  // iframe 壳判定（200 + 小 body + iframe src）
  const size = first.r.ok ? first.r.body.byteLength : 0;
  const isRedirect = first.r.ok && [301, 302, 303, 307, 308].includes(first.r.status)
    && first.r.headers['location'];
  const isIframeShell = first.r.ok && first.r.status === 200 && size < 1024
    && extractIframeSrc(firstBodyText);

  if (isRedirect) {
    result.type = 'redirect';
    result.template = 'B';
    // 跳转链循环（≤5 跳）
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const locRaw = result.chain[result.chain.length - 1].location;
      const nextUrl = normalizeLocation(locRaw, currentUrl);
      if (!nextUrl) break;
      const h = await hop(nextUrl);
      result.chain.push({
        url: nextUrl,
        status: h.r.ok ? h.r.status : null,
        location: h.r.ok ? (h.r.headers['location'] || null) : null,
        server: h.r.ok ? (h.r.headers['server'] || null) : null,
        ms: h.ms,
        error: h.r.ok ? undefined : h.r.error,
      });
      currentUrl = nextUrl;
      lastResponse = h;
      if (!h.r.ok || ![301, 302, 303, 307, 308].includes(h.r.status) || !h.r.headers['location']) break;
    }
  } else if (isIframeShell) {
    result.type = 'iframe-shell';
    result.template = null; // 口径上不是「自动跳转」，人工裁决 A/B（计划决策 #8）
    const src = normalizeLocation(extractIframeSrc(firstBodyText), inputUrl);
    if (src) {
      const h = await hop(src);
      result.chain.push({
        url: src,
        status: h.r.ok ? h.r.status : null,
        location: h.r.ok ? (h.r.headers['location'] || null) : null,
        server: h.r.ok ? (h.r.headers['server'] || null) : null,
        ms: h.ms,
        error: h.r.ok ? undefined : h.r.error,
      });
      currentUrl = src;
      lastResponse = h; // iframe 目标作为最终页
    }
  } else {
    result.type = 'direct';
    result.template = 'A';
  }

  // ── 最终页落盘 + MD5 ─────────────────────────────────────────
  const last = result.chain[result.chain.length - 1];
  result.finalUrl = last.url;
  result.finalRegistrableDomain = registrableDomain(new URL(result.finalUrl).hostname);
  if (lastResponse.r.ok && lastResponse.r.body && lastResponse.r.body.byteLength > 0) {
    const file = 'b_raw.html';
    fs.writeFileSync(path.join(outDir, file), Buffer.from(lastResponse.r.body));
    result.finalRaw = {
      md5: md5(lastResponse.r.body),
      sizeBytes: lastResponse.r.body.byteLength,
      file,
      contentEncoding: lastResponse.r.headers['content-encoding'] || 'identity',
      title: extractTitle(bodyToText(lastResponse.r.body)),
    };
  }

  // ── 业务路径（23 条，并发 4，对输入 origin）────────────────────
  result.businessPaths = await probeBusinessPaths(inputUrl);

  // catch-all 判定：≥20 条 302 指向同一 host
  const hostCount = {};
  for (const p of result.businessPaths) {
    if (p.status && [301, 302, 303, 307, 308].includes(p.status) && p.location) {
      try {
        const h = new URL(p.location).hostname;
        hostCount[h] = (hostCount[h] || 0) + 1;
      } catch { /* 非法 Location 忽略 */ }
    }
  }
  const topHost = Object.entries(hostCount).sort((a, b) => b[1] - a[1])[0];
  if (topHost && topHost[1] >= 20) {
    result.catchAll = { host: topHost[0], count: topHost[1] };
  }

  // ── www 变体 ─────────────────────────────────────────────────
  const wwwUrl = `https://www.${registrable}/`;
  const w = await fetchRaw(wwwUrl, { timeoutMs: TIMEOUTS.probe, userAgent: WXUA });
  if (w.ok && w.status === 200 && w.body && w.body.byteLength > 0) {
    const file = 'b_www.html';
    fs.writeFileSync(path.join(outDir, file), Buffer.from(w.body));
    result.wwwVariant = {
      url: wwwUrl,
      status: w.status,
      md5: md5(w.body),
      sizeBytes: w.body.byteLength,
      title: extractTitle(bodyToText(w.body)),
      file,
    };
  } else {
    result.wwwVariant = { url: wwwUrl, status: w.ok ? w.status : null, error: w.error || null };
  }

  return result;
}

/** 业务路径批量探测：23 条，并发 4。 */
async function probeBusinessPaths(inputUrl) {
  const origin = new URL(inputUrl).origin;
  const out = [];
  for (let i = 0; i < BUSINESS_PATHS.length; i += 4) {
    const batch = BUSINESS_PATHS.slice(i, i + 4);
    const rs = await Promise.all(batch.map(async (p) => {
      const url = `${origin}/${p}/`;
      const t0 = Date.now();
      const r = await fetchRaw(url, { timeoutMs: TIMEOUTS.path, userAgent: WXUA });
      return {
        path: `/${p}/`,
        status: r.ok ? r.status : null,
        location: r.ok ? (r.headers['location'] || null) : null,
        ms: Date.now() - t0,
        error: r.ok ? undefined : r.error,
      };
    }));
    out.push(...rs);
  }
  return out;
}

module.exports = { probeTarget, registrableDomain, md5, extractTitle };
