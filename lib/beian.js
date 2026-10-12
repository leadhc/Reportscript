// 备案查询模块。退出机制（实施计划决策 #6，硬性保障）：
//   1. 无循环无重试——「一轮顺序尝试」，不存在 while 重试，不可能死循环；
//   2. Provider 级 15s 独立超时，超时/反爬/DNS失败立即放弃，不重试；
//   3. 整体预算 45s 硬封顶，超预算渠道标记 skipped；
//   4. 默认只跑本地页面自述扫描（零网络请求，毫秒级），远程需显式 --beian-remote；
//   5. 任何失败路径汇入同一降级终点（固定行 + whois 兜底），不存在无限换渠道；
//   6. 每渠道状态/耗时/失败方式全程留痕进 report.beian.providers[]。
//
// 纪律：不做反反爬——命中验证码/风控即 blocked。

const fs = require('fs');
const path = require('path');
const { fetchRaw } = require('./net');
const { TIMEOUTS } = require('./constants');

// 备案号正则：含省份简称前缀（闽ICP备2024043513号-8）与无前缀两种形态
const PROVINCE = '京津沪渝冀晋辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云藏陕甘青宁新津';
const ICP_RE = new RegExp(`[${PROVINCE}]?ICP备\\s*\\d+号(?:-\\d+)?`);
const ICP_RE_G = new RegExp(`[${PROVINCE}]?ICP备\\s*\\d+号(?:-\\d+)?`, 'g');
const COMPANY_RE_G = /[一-龥（）]{2,20}(?:有限公司|有限责任公司|网络科技|文化传媒|信息技术|电子商务|商贸)/g;

/** provider #0：本地页面自述扫描（零网络请求）。扫描报告目录下已下载的 HTML。 */
function localScan(outDir) {
  const files = ['b_raw.html', 'b_www.html', 'b_rendered.html'];
  const icpNumbers = [];
  const companies = [];
  for (const f of files) {
    const p = path.join(outDir, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.match(ICP_RE_G) || []) {
      const v = m.replace(/\s+/g, '');
      if (!icpNumbers.includes(v)) icpNumbers.push(v);
    }
    for (const m of text.match(COMPANY_RE_G) || []) {
      if (!companies.includes(m)) companies.push(m);
    }
  }
  return { icpNumbers, companies };
}

/**
 * 网页类 provider 的严格备案号提取（防页脚/示例区误报）。
 * 误报教训（2026-10-12 实录）：chinaz 查询页壳的示例区与页脚含其自身备案号
 * 「闽ICP备08105208号-1」，朴素全文匹配会把两个不同域名都"命中"同一号码——假证据；
 * 且壳页导航/简介里就含「主办单位」字样，特征词也不可靠。
 * 强规则：候选备案号 ±600 字符上下文必须包含被查域名（真实结果表中域名与
 * 备案号同现于结果行；壳页的备案号在页脚/示例区，域名只在 title，天然分离）。
 * @returns {string|null} 备案号或 null
 */
function extractIcpStrict(html, domain) {
  const re = new RegExp(`[${PROVINCE}]?ICP备\\s*\\d+号(?:-\\d+)?`, 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const ctx = html.slice(Math.max(0, m.index - 600), m.index + 600);
    if (ctx.includes(domain)) return m[0].replace(/\s+/g, '');
  }
  return null;
}

/**
 * 远程 provider：朴素 HTTP 请求（能用 HTTP 的不引浏览器），命中反爬立即 blocked。
 * 全部为当前实测已灭渠道，保留接口供恢复（计划决策：接口不变，恢复时只改一处）。
 */
const REMOTE_PROVIDERS = [
  {
    name: 'vvhan-api',
    async query(domain) {
      // JSON API：无页面壳，宽松提取（API 返回体不会带页脚）
      const r = await fetchRaw(`https://api.vvhan.com/api/icp?url=${domain}`,
        { timeoutMs: TIMEOUTS.beianProvider });
      if (!r.ok) return { status: 'error', detail: r.error };
      const m = Buffer.from(r.body).toString('utf8').match(ICP_RE);
      return m ? { status: 'hit', icpNumber: m[0].replace(/\s+/g, '') }
               : { status: 'miss', detail: '响应无备案号' };
    },
  },
  {
    name: 'chinaz',
    async query(domain) {
      const r = await fetchRaw(`https://icp.chinaz.com/${domain}`,
        { timeoutMs: TIMEOUTS.beianProvider, extraHeaders: { referer: 'https://icp.chinaz.com/' } });
      if (!r.ok) return { status: 'error', detail: r.error };
      if (r.status !== 200) return { status: 'blocked', detail: `HTTP ${r.status}` };
      const icp = extractIcpStrict(Buffer.from(r.body).toString('utf8'), domain);
      return icp ? { status: 'hit', icpNumber: icp }
                 : { status: 'miss', detail: '结果区未渲染（JS 异步加载，朴素 HTTP 拿不到）' };
    },
  },
  {
    name: 'icplishi',
    async query(domain) {
      const r = await fetchRaw(`https://www.icplishi.com/search/${domain}`,
        { timeoutMs: TIMEOUTS.beianProvider });
      if (!r.ok) return { status: 'error', detail: r.error };
      if (r.status !== 200) return { status: 'blocked', detail: `HTTP ${r.status}` };
      const icp = extractIcpStrict(Buffer.from(r.body).toString('utf8'), domain);
      return icp ? { status: 'hit', icpNumber: icp }
                 : { status: 'miss', detail: '结果区未渲染（JS 异步加载，朴素 HTTP 拿不到）' };
    },
  },
];

/**
 * 备案查询主入口。
 * @param {string[]} domains 注册域列表（A 域、B 域）
 * @param {string} outDir 报告目录（本地扫描读 HTML、无网络写入）
 * @param {{remote?: boolean}} opts remote=true 才跑远程渠道（默认 false）
 */
async function beianLookup(domains, outDir, opts = {}) {
  const t0 = Date.now();
  const budget = TIMEOUTS.beianBudget;
  const perDomain = {};

  for (const domain of domains) {
    const entry = {
      domain,
      icpNumber: null,
      icpOwner: null,
      selfDeclared: null,
      status: null,           // hit | degraded
      providers: [],
    };

    // provider #0：本地自述扫描（毫秒级，永不失败）
    const pt0 = Date.now();
    const scan = localScan(outDir);
    entry.selfDeclared = scan;
    entry.providers.push({
      name: 'local-scan', status: scan.icpNumbers.length ? 'hit' : 'miss',
      ms: Date.now() - pt0,
    });

    if (scan.icpNumbers.length > 0) {
      entry.icpNumber = scan.icpNumbers[0];
      entry.icpOwner = scan.companies[0] || null;
      entry.status = 'hit';
      perDomain[domain] = entry;
      continue; // 页面自述已是可用证据，不再跑远程
    }

    if (!opts.remote) {
      entry.providers.push({
        name: 'remote', status: 'skipped', ms: 0,
        detail: '默认不跑远程（--beian-remote 启用）',
      });
      entry.status = 'degraded';
      perDomain[domain] = entry;
      continue;
    }

    // 远程渠道：串行，一轮顺序尝试，预算封顶，无重试
    for (const p of REMOTE_PROVIDERS) {
      const elapsed = Date.now() - t0;
      if (elapsed > budget) {
        entry.providers.push({
          name: p.name, status: 'skipped', ms: 0, detail: `整体预算 ${budget}ms 耗尽`,
        });
        continue;
      }
      const s0 = Date.now();
      let r;
      try {
        r = await p.query(domain); // 内部 15s 独立超时，永不抛异常
      } catch (e) {
        r = { status: 'error', detail: String(e && e.message).slice(0, 80) };
      }
      entry.providers.push({
        name: p.name, status: r.status, ms: Date.now() - s0, detail: r.detail,
      });
      if (r.status === 'hit') {
        entry.icpNumber = r.icpNumber;
        entry.icpOwner = r.icpOwner || null;
        entry.status = 'hit';
        break; // 命中即止，提前结束
      }
    }

    if (entry.status !== 'hit') entry.status = 'degraded';
    perDomain[domain] = entry;
  }

  const statuses = Object.values(perDomain).map(e => e.status);
  const overall = statuses.every(s => s === 'hit') ? 'hit'
    : statuses.some(s => s === 'hit') ? 'partial' : 'degraded';
  return { status: overall, perDomain, totalMs: Date.now() - t0 };
}

module.exports = { beianLookup, localScan };
