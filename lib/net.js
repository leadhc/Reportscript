// 网络层：fetch 封装 + DNS 解析。
//
// 纪律（规格书第 1 节硬性约定）：
// - Node 24 的 fetch（undici）默认不读 HTTP_PROXY/HTTPS_PROXY 环境变量，
//   等价于 curl --noproxy '*'。全项目【禁止】引入任何 ProxyAgent/EnvHttpProxyAgent
//   ——直连是纪律，不是默认值。
// - 一律显式 accept-encoding: identity：规格书指纹库是 curl（identity）的产物，
//   undici 若透明解压 gzip，MD5 与指纹库不可比（实施计划关键决策 #2）。

const dns = require('dns').promises;
const { CNAME_MAX_HOPS } = require('./constants');

// ── 可中止信号 ─────────────────────────────────────────────────
// Web 界面点「取消取证」时，把在途 fetch 一并掐断。
// 服务端已限制同一时刻只跑一个任务，因此用全局信号即可，无需层层透传。
let ABORT = null;
function setAbortSignal(sig) { ABORT = (sig && typeof sig === 'object') ? sig : null; }
function getAbortSignal() { return ABORT; }
function isAborted() { return !!(ABORT && ABORT.aborted); }

/** 把外部中止信号与超时信号合并；不支持 AbortSignal.any 时退回超时信号。 */
function combineSignal(timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!ABORT) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, ABORT]);
  return ABORT;
}

/**
 * 原始 HTTP 请求（redirect: 'manual'，不跟随跳转，跳转由上层循环控制）。
 * 永不抛异常，返回结构化结果：
 *   ok: true  → { status, headers, body(ArrayBuffer), url }
 *   ok: false → { error: 'timeout'|'ENOTFOUND'|... }
 */
async function fetchRaw(url, opts = {}) {
  const {
    timeoutMs = 15000,
    method = 'GET',
    userAgent,
    extraHeaders = {},
  } = opts;
  const headers = { 'accept-encoding': 'identity', ...extraHeaders };
  if (userAgent) headers['user-agent'] = userAgent;
  try {
    const res = await fetch(url, {
      method,
      headers,
      redirect: 'manual', // undici 返回真实 3xx 响应（status + Location 可读）
      signal: combineSignal(timeoutMs),
    });
    const body = await res.arrayBuffer();
    const flatHeaders = {};
    for (const [k, v] of res.headers) flatHeaders[k.toLowerCase()] = v;
    return { ok: true, status: res.status, headers: flatHeaders, body, url };
  } catch (e) {
    if (isAborted()) return { ok: false, error: 'aborted', aborted: true };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: (e.cause && e.cause.code) || e.code || e.message };
  }
}

/** JSON 请求（redirect: 'follow'，用于 RDAP 等 API）。同样永不抛异常。 */
async function fetchJson(url, opts = {}) {
  const { timeoutMs = 15000, extraHeaders = {} } = opts;
  try {
    const res = await fetch(url, {
      // rdap.org 等服务拒绝无 UA 请求（实测 403），默认带工具 UA
      headers: {
        'user-agent': 'report-tool/1.0',
        accept: 'application/json',
        ...extraHeaders,
      },
      redirect: 'follow',
      signal: combineSignal(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isAborted()) return { ok: false, error: 'aborted', aborted: true };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: (e.cause && e.cause.code) || e.message };
  }
}

/**
 * DNS 解析：CNAME 链 + A 记录（c-ares 直查，反映真实 DNS 视图）。
 * 任何失败降级为空数组，不阻塞主流程。
 */
async function resolveDns(host) {
  const result = { cnameChain: [], ips: [] };
  // CNAME 链循环跟随（上限 CNAME_MAX_HOPS）
  try {
    let current = host;
    for (let i = 0; i < CNAME_MAX_HOPS; i++) {
      const cnames = await dns.resolveCname(current).catch(() => null);
      if (!cnames || cnames.length === 0) break;
      result.cnameChain.push(...cnames);
      current = cnames[0];
    }
  } catch { /* 整链失败不影响 A 记录 */ }
  try {
    result.ips = await dns.resolve4(host);
  } catch { result.ips = []; }
  return result;
}

/** Location 归一化：兼容绝对 / 相对 / 协议相对（//host/…）三种写法。 */
function normalizeLocation(locationHeader, currentUrl) {
  try {
    return new URL(locationHeader, currentUrl).href;
  } catch {
    return null;
  }
}

module.exports = { fetchRaw, fetchJson, resolveDns, normalizeLocation, setAbortSignal, getAbortSignal, isAborted };
