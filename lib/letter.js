// 举报信生成模块——纪律风险最高，实现以下硬约束：
//   1. 模板骨架一字不改：资产文件装载后校验固定句，不匹配 fail-fast（宁不出信）；
//   2. 脱敏三规则：输入 URL 原样保留；探测发现的 URL 脱 query；行文永不出现
//      参数名/token 名（黑名单从 probe 链动态提取，命中即报错）；
//   3. 填不出的槽位保留 {xxx} 原文并登记 unresolvedSlots，绝不编造；
//   4. terrain 关联只进取证底档，不进举报信正文（人工版先例：正文克制）；
//   5. 模板 A 降级时窄槽位用压缩表达，骨架不动、语义如实。

const fs = require('fs');
const path = require('path');
const { BEIAN_DEGRADED_LINE } = require('./constants');

// ── 模板装载与自校验 ──────────────────────────────────────────

const REQUIRED_PHRASES = {
  A: [
    '通过微信可以正常访问并传播',
    '以封建迷信类内容诱导用户付费，申请核查处理。',
    '一级域名及备案信息如下：',
    '二级域名及可核验访问地址如下：',
    '页面截图如下：',
  ],
  B: [
    '通过微信可以正常访问',
    '（携带完整投放参数）',
    '以封建迷信类内容诱导用户付费，申请核查处理。',
    '一级域名及备案信息如下：',
    '二级域名及可核验访问地址如下：',
    '页面截图如下：',
  ],
  C: [
    '以下地址通过微信均可以正常访问并传播',
    '以封建迷信类内容诱导用户付费，申请核查处理。',
    '一级域名及备案信息如下：',
    '页面截图如下：',
  ],
};

function loadTemplate(name) {
  const file = path.join(__dirname, 'templates', `${name}.md`);
  const t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const phrase of REQUIRED_PHRASES[name]) {
    if (!t.includes(phrase)) {
      throw new Error(`模板 ${name} 骨架校验失败：缺失固定句「${phrase}」——宁不出信也不出改骨架的信`);
    }
  }
  return t;
}

// ── 脱敏 ─────────────────────────────────────────────────────

/** 去 query + 去尾斜杠：用于模板 B 的 {B页URL}（https://nfd109.yskyl.baby）。 */
function stripQuery(u) {
  try {
    const url = new URL(u);
    const p = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return url.origin + p;
  } catch {
    return u;
  }
}

/** 脱 query 为 ?… 标记：用于底档（https://nfd109.yskyl.baby?…）。 */
function redactUrl(u) {
  try {
    const url = new URL(u);
    const p = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return url.origin + p + (url.search ? '?…' : '');
  } catch {
    return u;
  }
}

/** 从 probe 链提取出现过的 query 参数名（黑名单素材）。 */
function collectTokenNames(probe) {
  const names = new Set();
  const urls = [];
  for (const c of (probe && probe.chain) || []) {
    if (c.url) urls.push(c.url);
    if (c.location) urls.push(c.location);
  }
  for (const u of urls) {
    try {
      for (const key of new URL(u).searchParams.keys()) names.add(key);
    } catch { /* 非法 URL 忽略 */ }
  }
  return [...names];
}

/** 参数名黑名单终检：将进入信件的全文中不得出现参数名（输入 URL 本身除外）。 */
function assertNoTokenLeak(letterText, inputUrl, tokenNames) {
  if (!tokenNames.length) return;
  const masked = inputUrl ? letterText.split(inputUrl).join('<INPUT_URL>') : letterText;
  const leaks = tokenNames.filter(t => masked.includes(t));
  if (leaks.length) {
    throw new Error(`脱敏拦截：信件文本中出现参数名 ${JSON.stringify(leaks)} —— 纪律红线（不点名规避参数名）`);
  }
}

// ── 槽位组装 ─────────────────────────────────────────────────

/** 唯一注册域列表：输入域在前。 */
function uniqueRegistrables(report) {
  const list = [report.target.registrableDomain];
  const fr = report.probe && report.probe.finalRegistrableDomain;
  if (fr && !list.includes(fr)) list.push(fr);
  return list;
}

/** {主体信息} 块（模板 B 自由变量区；结构对照人工版举报信）。 */
function buildSubjectInfoBlock(report) {
  const blocks = [];
  for (const d of uniqueRegistrables(report)) {
    const lines = [`域名：${d}`];
    const b = report.beian && report.beian.perDomain[d];
    const w = report.whois && report.whois[d];
    if (b && b.status === 'hit') {
      if (b.icpOwner) lines.push(`ICP备案主体：${b.icpOwner}`);
      lines.push(`备案号：${b.icpNumber}`);
    } else {
      if (w && w.status === 'ok') {
        const reg = w.registrarName
          ? `${w.registrar}（${w.registrarName}）`
          : (w.registrar || null);
        if (reg) lines.push(`域名注册商：${reg}`);
        if (w.registeredAt) lines.push(`域名注册时间：${w.registeredAt}`);
      }
      lines.push(BEIAN_DEGRADED_LINE);
    }
    // www 变体行：只挂在输入域块（人工版先例）
    const wv = report.probe && report.probe.wwwVariant;
    if (d === report.target.registrableDomain && wv && wv.status === 200 && wv.title) {
      lines.push(`该域名下 www.${d} 直接呈现同款「${wv.title}」付费页面`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** 二级域名块（骨架「域名：/访问地址：」结构按组重复，先例认可）。 */
function buildSubdomainBlock(report) {
  const groups = [];
  groups.push(`域名：${report.target.host}\n访问地址：${report.input.url}`);
  const fr = report.probe && report.probe.finalRegistrableDomain;
  if (fr && fr !== report.target.registrableDomain && report.probe.finalUrl) {
    let host = null;
    try { host = new URL(report.probe.finalUrl).hostname; } catch { /* ignore */ }
    if (host) groups.push(`域名：${host}\n访问地址：${stripQuery(report.probe.finalUrl)}`);
  }
  return groups.join('\n\n');
}

/** 付费原话拼接：「a」「b」（候选由 render.paidQuotes 提供，人工复核兜底）。 */
function buildPaidQuotes(report, unresolved) {
  const q = (report.render && report.render.paidQuotes) || [];
  if (!q.length) {
    unresolved.push('{页面上的付费原话}');
    return '{页面上的付费原话}';
  }
  return q.map(s => `「${s}」`).join('');
}

// ── 举报信正文 ───────────────────────────────────────────────

function buildLetterBody(report, unresolved) {
  const template = report.probe.template;
  if (template === 'B') {
    const t = loadTemplate('B');
    const bUrl = (report.render && report.render.finalUrl)
      || (report.probe.finalUrl || '');
    const title = (report.render && report.render.title)
      || (report.probe.finalRaw && report.probe.finalRaw.title)
      || null;
    return t
      .split('{A页URL}').join(report.input.url)
      .split('{B页URL}').join(bUrl ? stripQuery(bUrl) : '{B页URL}')
      .split('{页面名}').join(title || (unresolved.push('{页面名}'), '{页面名}'))
      .split('{页面上的付费原话}').join(buildPaidQuotes(report, unresolved))
      .split('{A页完整URL}').join(report.input.url)
      .split('{一级域名}').join(report.target.registrableDomain)
      .split('{主体信息}').join(buildSubjectInfoBlock(report))
      .split('域名：{二级域名}\n访问地址：{URL}')
      .join(buildSubdomainBlock(report));
  }
  if (template === 'A') {
    const t = loadTemplate('A');
    const d = report.target.registrableDomain;
    const b = report.beian && report.beian.perDomain[d];
    const w = report.whois && report.whois[d];
    let subjectName, icpNumber;
    if (b && b.status === 'hit') {
      subjectName = b.icpOwner || (unresolved.push('{主体名}'), '{主体名}');
      icpNumber = b.icpNumber || (unresolved.push('{备案号}'), '{备案号}');
    } else {
      // 降级压缩表达（计划决策：骨架不动、语义如实）
      const reg = w && w.status === 'ok' && w.registrar
        ? `（域名注册商：${w.registrarName ? w.registrar + '（' + w.registrarName + '）' : w.registrar}`
          + `${w.registeredAt ? '，注册于' + w.registeredAt : ''}）`
        : '';
      subjectName = BEIAN_DEGRADED_LINE + reg;
      icpNumber = '公开渠道未查询到';
    }
    return t
      .split('{URL}').join(report.input.url)
      .split('{完整URL带参数}').join(report.input.url)
      .split('{一级域名}').join(d)
      .split('{主体名}').join(subjectName)
      .split('{备案号}').join(icpNumber)
      .split('{二级域名}').join(report.target.host)
      .split('访问地址：{URL}').join(`访问地址：${report.input.url}`);
  }
  // iframe-shell / blocked 等需人工裁决类型：不出正文骨架，返回标记
  return null;
}

// ── 重测命令 / 自检清单 / 底档 ────────────────────────────────

function buildRetestSection(report) {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) MicroMessenger/8.0.49';
  const cmds = [];
  const chain = (report.probe && report.probe.chain) || [];
  const firstStatus = chain.length ? chain[0].status : null;

  cmds.push({
    url: report.input.url,
    cmd: `curl.exe --noproxy "*" --max-time 15 -A "${UA}" -D - -o NUL -s -w "code=%{http_code}" "${report.input.url}"`,
    expect: firstStatus === 302 || firstStatus === 301
      ? `302，Location 指向 ${(() => { try { return new URL(report.probe.finalUrl).hostname; } catch { return '落地域名'; } })()}`
      : `${firstStatus || '200'}（与本次探测一致）`,
  });

  const fr = report.probe && report.probe.finalRegistrableDomain;
  if (fr && fr !== report.target.registrableDomain && report.probe.finalUrl) {
    const u = stripQuery(report.probe.finalUrl);
    const size = report.probe.finalRaw ? Math.round(report.probe.finalRaw.sizeBytes / 1024) : null;
    cmds.push({
      url: u,
      cmd: `curl.exe --noproxy "*" --max-time 15 -A "${UA}" -o NUL -s -w "code=%{http_code} size=%{size_download}" "${u}"`,
      expect: `200${size ? `，约 ${size}KB` : ''}`,
    });
  }

  const wv = report.probe && report.probe.wwwVariant;
  if (wv && wv.status === 200) {
    cmds.push({
      url: wv.url,
      cmd: `curl.exe --noproxy "*" --max-time 15 -A "${UA}" -o NUL -s -w "code=%{http_code} size=%{size_download}" "${wv.url}"`,
      expect: `200${wv.sizeBytes ? `，约 ${Math.round(wv.sizeBytes / 1024)}KB` : ''}`,
    });
  }

  let md = '发送前必须重测正文里出现的每个 URL，确认状态与正文描述一致：\n\n```powershell\n';
  for (const c of cmds) {
    md += `${c.cmd}\n# 预期：${c.expect}\n\n`;
  }
  md += '```\n';
  return md;
}

function buildChecklistSection() {
  return [
    '```',
    '□ 首句与所选模板骨架逐字一致',
    '□ 主诉句逐字为「以封建迷信类内容诱导用户付费，申请核查处理。」',
    '□ 三个段落标题为「一级域名及备案信息如下：」「二级域名及可核验访问地址如下：」「页面截图如下：」',
    '□ 未改写任何固定短语、未调整段落顺序',
    '□ 正文里出现的每个 URL 都当场重测过（状态与正文描述一致）',
    '□ 附件截图存在且能打开',
    '□ 主题格式为「违规链接举报反馈【域名】」，含域名做唯一标识',
    '□ 收件人是 moment@tencent.com',
    '□ 已记下发送时间 T',
    '□ 发送后按文档 5.2 节流程验证；任何情况下都不因"本地查不到"而重发',
    '```',
  ].join('\n');
}

function buildArchiveSection(report) {
  const p = report.probe || {};
  const chain = (p.chain || []).map(c => {
    const loc = c.location ? ` -> ${redactUrl(c.location)}` : '';
    const st = c.status || `ERR(${c.error || '?'})`;
    return `${st} ${redactUrl(c.url)}${loc}`;
  }).join('；');

  const dnsMap = report.dns || {};
  const inputHost = report.target && report.target.host;
  let finalHost = null;
  try { finalHost = p.finalUrl ? new URL(p.finalUrl).hostname : null; } catch { /* ignore */ }
  const dnsIn = inputHost ? dnsMap[inputHost] : null;
  const dnsOut = (finalHost && finalHost !== inputHost) ? dnsMap[finalHost] : null;
  const r = report.render || {};
  const rows = [
    ['链路', chain || '无'],
    ['输入域 DNS', dnsIn ? `CNAME: ${dnsIn.cnameChain.join(' → ') || '无'}；IP: ${dnsIn.ips.join(', ') || '无'}` : '未解析'],
  ];
  if (dnsOut && dnsOut !== dnsIn) {
    rows.push(['落地域 DNS', `CNAME: ${dnsOut.cnameChain.join(' → ') || '无'}；IP: ${dnsOut.ips.join(', ') || '无'}`]);
  }
  if (p.catchAll) rows.push(['业务路径', `catch-all 跳转壳：${p.catchAll.count}/${(p.businessPaths || []).length} 条路径 302 指向 ${p.catchAll.host}`]);
  else if (p.businessPaths) {
    const c302 = p.businessPaths.filter(x => x.status === 302).length;
    rows.push(['业务路径', `${p.businessPaths.length} 条中 ${c302} 条 302`]);
  }
  if (r.title) rows.push(['渲染标题', r.title]);
  if (r.text) rows.push(['渲染正文', r.text]);
  if (p.finalRaw) rows.push(['落地页 MD5', `${p.finalRaw.md5}（${p.finalRaw.sizeBytes} 字节，${p.finalRaw.contentEncoding}）`]);
  if (p.wwwVariant && p.wwwVariant.md5) {
    rows.push(['www 变体 MD5', `${p.wwwVariant.md5}（title: ${p.wwwVariant.title || '无'}）`]);
  }
  for (const d of uniqueRegistrables(report)) {
    const w = report.whois && report.whois[d];
    if (w && w.status === 'ok') {
      rows.push([`whois ${d}`, `${w.registrar || '?'}${w.registrarName ? '（' + w.registrarName + '）' : ''} / 注册于 ${w.registeredAt || '?'} / NS: ${w.nameservers.join(', ') || '?'}`]);
    } else if (w) {
      rows.push([`whois ${d}`, `查询不可用（${w.error}）`]);
    }
  }
  if (report.beian) {
    const parts = Object.values(report.beian.perDomain).map(e =>
      `${e.domain}: ${e.status}${e.icpNumber ? '（' + e.icpNumber + '）' : ''}`);
    rows.push(['备案查询', `${report.beian.status} — ${parts.join('；')}（渠道：${Object.values(report.beian.perDomain).flatMap(e => e.providers.map(p2 => p2.name + '=' + p2.status)).join(', ')}）`]);
  }
  if (report.terrain && report.terrain.matches && report.terrain.matches.length) {
    for (const m of report.terrain.matches) {
      rows.push([`关联证据(rank${m.rank} ${m.kind})`, m.detail]);
    }
  }
  if (report.fingerprint && report.fingerprint.knownMatches) {
    for (const f of report.fingerprint.knownMatches) {
      rows.push(['指纹命中', `MD5 ${f.md5} 与快照「${f.pageName}」（${f.capturedAt}，标价 ${f.price || '未知'}）一致`]);
    }
  }

  let md = '| 项目 | 结果 |\n|---|---|\n';
  for (const [k, v] of rows) md += `| ${k} | ${String(v).replace(/\|/g, '\\|')} |\n`;
  md += `\n${(report.terrain && report.terrain.note) || ''}\n`;
  return md;
}

// ── 主入口 ───────────────────────────────────────────────────

/**
 * 生成举报信（含正文 + 重测命令 + 自检清单 + 取证底档）。
 * @param {object} report 完整 report.json 数据
 * @param {string} outDir 报告目录
 * @returns {{file, template, subjectLine, unresolvedSlots}}
 */
function generateLetter(report, outDir) {
  const unresolved = [];
  const body = buildLetterBody(report, unresolved);
  if (body === null) {
    throw new Error(`目标类型为 ${report.probe.type}（需人工裁决模板 A/B），不自动生成正文——请人工判断后套用模板`);
  }

  // 残留槽位登记（替换失败/数据缺失）
  const leftover = body.match(/\{[^}\n]{1,20}\}/g) || [];
  for (const s of leftover) if (!unresolved.includes(s)) unresolved.push(s);

  // 参数名黑名单终检（输入 URL 原样豁免）
  const tokenNames = collectTokenNames(report.probe);
  assertNoTokenLeak(body, report.input.url, tokenNames);

  // 主题行：单域直出只写一个域名
  const fr = report.probe.finalRegistrableDomain;
  const domPart = fr && fr !== report.target.registrableDomain
    ? `${report.target.registrableDomain} / ${fr}`
    : report.target.registrableDomain;
  const subjectLine = `违规链接举报反馈【${domPart}】`;

  // 附件清单
  const shots = (report.render && report.render.screenshots) || {};
  const attachments = [shots.viewport, shots.fullPage].filter(Boolean);

  let md = `# 举报信 · ${domPart}\n\n`;
  md += `- **收件人**：moment@tencent.com\n`;
  md += `- **主题**：${subjectLine}\n`;
  if (attachments.length) {
    md += `- **附件**（同目录下）：\n`;
    for (const a of attachments) md += `  - ${a}\n`;
  } else {
    md += `- **附件**：⚠️ 渲染失败，无截图——请人工补截图后再发送\n`;
  }
  md += `\n---\n\n## 正文（复制以下内容到邮件正文）\n\n`;
  md += body.trimEnd() + '\n';
  md += `\n---\n\n## 发送前当场重测\n\n`;
  md += buildRetestSection(report);
  md += `\n## 发送前自检（对照文档第 8 节）\n\n`;
  md += buildChecklistSection() + '\n';
  md += `\n## 取证底档（不进举报信，供核对）\n\n`;
  md += buildArchiveSection(report);

  const file = `举报信_${report.target.registrableDomain}.md`;
  fs.writeFileSync(path.join(outDir, file), md);

  return { file, template: report.probe.template, subjectLine, unresolvedSlots: unresolved };
}

module.exports = {
  generateLetter, loadTemplate,
  stripQuery, redactUrl, collectTokenNames, assertNoTokenLeak,
};
