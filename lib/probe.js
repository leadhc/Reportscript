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

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 注册域（一级/主域名）提取（零依赖：常见二级后缀表 + 兜底取最后两段）。
 * 纪律：任何 host 都能给出稳定的「主域名」，绝不因大小写/尾点/IP 而返回错值——
 * 举报信「一级域名及备案信息如下」段直接用它。
 *   - 去尾点、转小写后统一处理；
 *   - IPv4/IPv6 字面量没有注册域概念，原样返回（避免被切成 `11.179` 之类）；
 *   - 单标签（localhost 等）、两段域原样返回；
 *   - 命中二级后缀表（com.cn/co.uk…）时取三段，否则取最后两段。
 */
function registrableDomain(host) {
  const h = String(host == null ? '' : host).toLowerCase().replace(/\.+$/, '');
  if (!h) return h;
  if (IPV4_RE.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** 从 URL 或裸 host 提取主域名（非法输入返回 null）。 */
function mainDomainOf(value, base) {
  if (!value) return null;
  let host = null;
  try { host = new URL(value, base).hostname; }
  catch { host = String(value).split('/')[0]; }
  return host ? registrableDomain(host) : null;
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

// 常见状态码 reason phrase（curl -D 风格首行；fetch 不返回 reason，这里自行补全）
const HTTP_REASON = {
  200: 'OK', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * 首跳证据落盘（对齐人工流程 recon.ps1 的 h_a.txt / b_a.html）：
 *   h_a.txt  —— 首跳响应头，curl -D 风格：首行「HTTP/1.1 <code> <reason>」+ 逐行 header；
 *   b_a.html —— 首跳响应体原样（跳转型通常是几百字节的跳转壳，iframe 型是壳页）。
 * 终点页仍由 b_raw.html 承载：「b_a.html（首跳壳）↔ b_raw.html（落地页）」对照即 A→B 证据。
 * 落盘失败不阻塞侦察（与 b_raw.html 落盘同口径）。
 */
function writeFirstHopEvidence(outDir, r) {
  try {
    let headerText;
    if (r && r.ok) {
      const reason = HTTP_REASON[r.status] ? ` ${HTTP_REASON[r.status]}` : '';
      const lines = [`HTTP/1.1 ${r.status}${reason}`];
      for (const [k, v] of Object.entries(r.headers || {})) lines.push(`${k}: ${v}`);
      headerText = lines.join('\n') + '\n';
    } else {
      headerText = `HTTP/1.1 0 ${(r && r.error) || 'request failed'}\n`;
    }
    fs.writeFileSync(path.join(outDir, 'h_a.txt'), headerText);
    const body = (r && r.ok && r.body) ? Buffer.from(r.body) : Buffer.alloc(0);
    fs.writeFileSync(path.join(outDir, 'b_a.html'), body);
  } catch { /* 证据落盘失败不阻塞侦察 */ }
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
      writeFirstHopEvidence(outDir, first.r); // 首跳证据：微信 UA 尝试（被挡，如实留档）
      return result;
    }
    // 裸 UA 成功：以裸 UA 结果作为直出页继续
    first = { r: plain, ms: null };
    firstBodyText = bodyToText(plain.body);
    lastResponse = first;
  }

  // 首跳证据落盘：h_a.txt（响应头）+ b_a.html（响应体）——对齐人工流程 recon.ps1
  writeFirstHopEvidence(outDir, first.r);

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

module.exports = { probeTarget, registrableDomain, mainDomainOf, md5, extractTitle };
