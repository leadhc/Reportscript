// CLI 入口：侦察 → 取证 → 备案 → 生成举报信。
//
// 用法
//   node cli.js <URL>                跑全流程（--no-render 可跳过 Playwright）
//   node cli.js letter <report.json>  从已有底档离线重生成举报信
//   node cli.js probe <URL>           仅侦察阶段（调试用）
//
// 纪律：
//   - 发送环节不自动化（规格书 5.2 防重复投递铁律无法脚本托管）。
//   - 数据流单向：probe → dns → whois → beian → terrain + fingerprint → render → letter，
//     全部汇总进 report.json（唯一事实源），举报信是其派生物。
//   - 各阶段 try/catch 隔离，单阶段失败不中断；渲染失败也出信（标记无截图）。

const fs = require('fs');
const path = require('path');

const { probeTarget, registrableDomain } = require('./lib/probe');
const { resolveDns } = require('./lib/net');
const { whoisLookup } = require('./lib/whois');
const { beianLookup } = require('./lib/beian');
const { loadTerrain, matchTerrain } = require('./lib/terrain');
const { fingerprintMatches } = require('./lib/fingerprint');
const { renderEvidence } = require('./lib/render');
const { generateLetter } = require('./lib/letter');
const { WXUA } = require('./lib/constants');

const TOOL_ROOT = __dirname;
const REPORTS_DIR = path.join(TOOL_ROOT, 'reports');
const TERRAIN_FILE = path.join(TOOL_ROOT, 'terrain.json');

// ── 工具 ───────────────────────────────────────────────────────

// 输出汇聚点：默认写 stdout（CLI）；被 Web 服务 require 时可用 setLogSink 接管，
// 把进度实时推给前端（SSE）。
let LOG_SINK = null;
function setLogSink(fn) { LOG_SINK = (typeof fn === 'function') ? fn : null; }
function emit(line) {
  if (LOG_SINK) LOG_SINK(line);
  else process.stdout.write(line);
}

function log(stage, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  emit(`[${ts}] [${stage}] ${msg}\n`);
}

function warn(msg) { emit(`  ⚠  ${msg}\n`); }
function ok(msg) { emit(`  ✓  ${msg}\n`); }
function fail(msg) { emit(`  ✗  ${msg}\n`); }

/** 目录存在则追加时间戳后缀，保证每跑一次都是新目录（审计链）。 */
function uniqueOutDir(base) {
  if (!fs.existsSync(base)) return base;
  let n = 1;
  while (fs.existsSync(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── Stage 隔离 ─────────────────────────────────────────────────

/**
 * 执行一个阶段：永不抛异常，返回 [value, error?]。
 * 失败时写 null 进 report.json 让后续阶段优雅降级。
 */
function stage(name, fn) {
  const t0 = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(v => { ok(`${name} 完成（${Date.now() - t0}ms）`); return [v, null]; })
    .catch(e => {
      const msg = (e && e.message) ? String(e.message).slice(0, 160) : String(e);
      fail(`${name} 失败：${msg}`);
      return [null, msg];
    });
}

// ── 子命令：letter（离线重生成） ───────────────────────────────

async function cmdLetter(reportFile) {
  if (!fs.existsSync(reportFile)) {
    fail(`底档不存在：${reportFile}`);
    return 1;
  }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); }
  catch (e) { fail(`底档解析失败：${e.message}`); return 1; }

  const outDir = path.dirname(reportFile);
  const [letter, err] = await stage('信件重生成', () => generateLetter(report, outDir));
  if (!letter) return 1;

  log('信件', `已写入 ${letter.file}`);
  log('信件', `模板：${letter.template} · 主题：${letter.subjectLine}`);
  if (letter.unresolvedSlots.length) {
    log('信件', `未填槽位（请人工补）：${letter.unresolvedSlots.join('、')}`);
  }
  return 0;
}

// ── 子命令：probe（仅侦察） ────────────────────────────────────

async function cmdProbe(inputUrl) {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outDir = uniqueOutDir(path.join(REPORTS_DIR, `probe-${ts}`));
  fs.mkdirSync(outDir, { recursive: true });
  log('侦察', `报告目录：${outDir}`);
  const [p] = await stage('侦察', () => probeTarget(inputUrl, outDir));
  if (!p) return 1;
  console.log(JSON.stringify({
    type: p.type, template: p.template, chain: p.chain.map(c => ({ url: c.url, status: c.status, location: c.location })),
    finalUrl: p.finalUrl, finalRegistrableDomain: p.finalRegistrableDomain,
    finalRaw: p.finalRaw && { md5: p.finalRaw.md5, sizeBytes: p.finalRaw.sizeBytes },
    catchAll: p.catchAll, businessPaths: p.businessPaths.filter(x => x.status === 302).length,
    wwwVariant: p.wwwVariant && { status: p.wwwVariant.status, md5: p.wwwVariant.md5 },
    blocked: p.blocked,
  }, null, 2));
  return 0;
}

// ── 主流程 ─────────────────────────────────────────────────────

async function runFull(inputUrl, opts) {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const input = new URL(inputUrl);
  const domainPart = registrableDomain(input.hostname);
  const outDir = uniqueOutDir(path.join(REPORTS_DIR, `${domainPart}-${ts}`));
  fs.mkdirSync(outDir, { recursive: true });
  log('流程', `报告目录：${outDir}`);
  log('流程', `目标 URL：${inputUrl}`);

  // 数据结构约定（letter.js 依赖）：report.input / report.target 独立于 stage 产出
  const report = {
    tool: 'report-tool/1.0',
    inputUrl,
    generatedAt: new Date().toISOString(),
    resolvedDomain: domainPart,
    input: { url: inputUrl },
    target: { host: input.hostname, registrableDomain: domainPart },
    // 以下由后续阶段填入；初始化为空对象，任一阶段失败时 letter.js 仍能照常组装
    probe: null, dns: {}, whois: {}, beian: { status: 'degraded', perDomain: {}, totalMs: 0 },
    terrain: { matches: [], note: '' },
    fingerprint: { knownMatches: [] },
    render: null,
  };
  const failures = [];

  // ── 侦察 ──────────────────────────────────────────────────────
  const [probe, pErr] = await stage('侦察', () => probeTarget(inputUrl, outDir));
  report.probe = probe || { type: null, template: null, chain: [], finalUrl: null, blocked: null };
  if (pErr) failures.push(`侦察: ${pErr}`);

  if (probe) {
    log('侦察', `类型：${probe.type} · 推荐模板：${probe.template || '需人工裁决'}`);
    if (probe.type === 'redirect') log('侦察', `链路 ${probe.chain.length} 跳终至 ${probe.finalUrl}`);
    if (probe.finalRaw) log('侦察', `落地页 MD5 ${probe.finalRaw.md5}（${probe.finalRaw.sizeBytes}B，${probe.finalRaw.contentEncoding}）`);
    if (probe.catchAll) log('侦察', `catch-all 跳转壳：${probe.catchAll.count}/23 条路径指向 ${probe.catchAll.host}`);
    if (probe.blocked) warn(`首站被挡（wx ${probe.blocked.wxTried.status} / plain ${probe.blocked.plainTried.status}），已换裸 UA 重试`);
  }

  // ── DNS ───────────────────────────────────────────────────────
  const dnsHosts = new Set();
  if (probe) {
    dnsHosts.add(input.hostname);
    if (probe.finalUrl) { try { dnsHosts.add(new URL(probe.finalUrl).hostname); } catch {} }
  }
  const dns = {};
  for (const h of dnsHosts) {
    const [d] = await stage(`DNS(${h})`, () => resolveDns(h));
    if (d) dns[h] = d;
    else failures.push(`DNS(${h})`);
  }
  report.dns = dns;
  if (dns[input.hostname]) {
    const d = dns[input.hostname];
    if (d.cnameChain.length) log('DNS', `CNAME ${d.cnameChain.join(' → ')}`);
    if (d.ips.length) log('DNS', `IP ${d.ips.join('、')}`);
  }

  // ── whois ─────────────────────────────────────────────────────
  const whois = {};
  const whoisDomains = [];
  if (probe) {
    const regs = new Set();
    regs.add(domainPart);
    if (probe.finalRegistrableDomain) regs.add(probe.finalRegistrableDomain);
    whoisDomains.push(...regs);
  }
  for (const d of whoisDomains) {
    const [w] = await stage(`whois(${d})`, () => whoisLookup(d, outDir));
    if (w) whois[d] = w;
    else failures.push(`whois(${d})`);
  }
  report.whois = whois;
  for (const d of whoisDomains) {
    const w = whois[d];
    if (w && w.status === 'ok') {
      const extra = [];
      if (w.registrarName) extra.push(`注册商 ${w.registrarName}`);
      if (w.registeredAt) extra.push(`注册 ${w.registeredAt}`);
      log('whois', `${d} — ${w.registrar || '?'}${extra.length ? '（' + extra.join('）') : ''}`);
    }
  }

  // ── 备案 ──────────────────────────────────────────────────────
  const [beian] = await stage('备案', () => beianLookup(whoisDomains, outDir, { remote: opts.beianRemote }));
  report.beian = beian || { status: 'degraded', perDomain: {}, totalMs: 0 };
  if (beian) {
    const hits = Object.values(beian.perDomain || {}).filter(e => e.status === 'hit');
    log('备案', `${beian.status} — ${hits.length}/${whoisDomains.length} 域名命中（${beian.totalMs}ms）`);
    for (const [d, e] of Object.entries(beian.perDomain || {})) {
      if (e.status === 'hit') log('备案', `  ${d}: ${e.icpNumber}${e.icpOwner ? `（${e.icpOwner}）` : ''}`);
      else for (const p of (e.providers || [])) if (p.status !== 'miss') log('备案', `  ${d} ${p.name}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`);
    }
  }

  // ── 地形 / 指纹（只读，不进信正文） ───────────────────────────
  let terrain = { matches: [], note: '' };
  if (opts.terrain && fs.existsSync(TERRAIN_FILE)) {
    const t = loadTerrain();
    const obs = {
      ips: [], cnameChain: [], md5s: [],
      icpNumber: (beian && whoisDomains.some(d => (beian.perDomain || {})[d]?.status === 'hit'))
        ? ((beian.perDomain || {})[whoisDomains[0]] || {}).icpNumber : null,
      pageTitle: (probe && probe.finalRaw && probe.finalRaw.title) || null,
    };
    for (const d of Object.values(dns)) {
      obs.ips.push(...(d.ips || []));
      obs.cnameChain.push(...(d.cnameChain || []));
    }
    if (probe) {
      if (probe.finalRaw && probe.finalRaw.md5) obs.md5s.push(probe.finalRaw.md5);
      if (probe.wwwVariant && probe.wwwVariant.md5) obs.md5s.push(probe.wwwVariant.md5);
    }
    const [m, mErr] = await stage('地形关联', () => matchTerrain(obs, t));
    if (m) {
      terrain = m;
      for (const x of m.matches) log('地形关联', `rank${x.rank} [${x.kind}] ${x.evidence}`);
      if (!m.matches.length) ok('地形关联：无历史快照命中（正常，目标可能已漂移）');
    } else failures.push(`地形关联: ${mErr}`);
    report.terrain = terrain;
    const known = fingerprintMatches(obs.md5s, t);
    report.fingerprint = { knownMatches: known };
    if (known.length) log('指纹', `命中 ${known.length} 个已知页面（见取证底档）`);
  } else {
    report.terrain = terrain;
    report.fingerprint = { knownMatches: [] };
  }

  // ── 渲染（最慢，可 --no-render 跳过） ─────────────────────────
  let render = null;
  if (opts.render) {
    const [r] = await stage('渲染取证', () => renderEvidence(inputUrl, outDir));
    render = r;
    report.render = r || { error: '渲染未产出' };
    if (r) {
      if (r.error) fail(`渲染：${r.error}`);
      else {
        ok(`渲染标题「${r.title}」`);
        if (r.paidQuotes.length) ok(`付费原话候选 ${r.paidQuotes.length} 条（信件生成后须人工复核）`);
        if (r.screenshots) ok(`截图 ${Object.values(r.screenshots).join('、')}`);
        for (const w of (r.warnings || [])) warn(w);
      }
    }
  } else {
    report.render = { skipped: true, reason: '--no-render' };
    log('渲染', '已跳过（--no-render）');
  }

  // ── 信件 ──────────────────────────────────────────────────────
  report.template = probe && probe.template;
  const [letter, lErr] = await stage('信件', () => generateLetter(report, outDir));
  if (letter) {
    log('信件', `已写入 ${letter.file}`);
    log('信件', `模板：${letter.template} · 主题：${letter.subjectLine}`);
    if (letter.unresolvedSlots.length) {
      log('信件', `未填槽位（请人工补）：${letter.unresolvedSlots.join('、')}`);
    }
  } else {
    fail(lErr || '信件生成失败——此类型需人工判断后套用模板');
    failures.push(`信件: ${lErr}`);
  }

  // ── 报告.json（唯一事实源） ──────────────────────────────────
  report.whois = whois;
  const reportFile = 'report.json';
  fs.writeFileSync(path.join(outDir, reportFile), JSON.stringify(report, null, 2));
  log('流程', `report.json 已写入 ${path.join(outDir, reportFile)}${failures.length ? `（${failures.length} 个阶段降级）` : ''}`);

  // ── 控制台摘要 + 人工发送提醒 ────────────────────────────────
  printSummary(report, { outDir, letter, terrain, failures, beianRemote: opts.beianRemote });
  const rc = failures.length === 0 || letter ? 0 : 2;
  return { rc, outDir, report, letter, terrain, failures };
}

function printSummary(report, ctx) {
  const p = report.probe || {};
  const domPart = report.resolvedDomain;
  emit('\n════════════ 举报材料摘要 ════════════\n');
  emit(`目标          : ${report.inputUrl}\n`);
  emit(`报告目录      : ${ctx.outDir}\n`);
  emit(`类型 / 模板   : ${p.type || '—'} / ${p.template || '需人工裁决'}\n`);
  if (p.chain.length) {
    emit(`链路          : ${p.chain.map(c => `${c.status || 'ERR'} ${c.url}`).join(' → ')}\n`);
  }
  if (p.finalRaw) emit(`落地页 MD5    : ${p.finalRaw.md5}（${p.finalRaw.sizeBytes}B）\n`);
  if (p.catchAll) emit(`业务路径      : catch-all 跳转壳 ${p.catchAll.count}/23 → ${p.catchAll.host}\n`);
  if (report.dns && Object.keys(report.dns).length) {
    for (const [h, d] of Object.entries(report.dns)) {
      const bits = [];
      if (d.cnameChain.length) bits.push(`CNAME ${d.cnameChain.join(' → ')}`);
      if (d.ips.length) bits.push(`IP ${d.ips.join('、')}`);
      if (bits.length) emit(`DNS ${h}       : ${bits.join('；')}\n`);
    }
  }
  if (report.beian && Object.keys(report.beian.perDomain || {}).length) {
    for (const [d, e] of Object.entries(report.beian.perDomain)) {
      if (e.status === 'hit') emit(`ICP ${d}        : ${e.icpNumber}${e.icpOwner ? `（${e.icpOwner}）` : ''}\n`);
      else emit(`ICP ${d}        : 未查到（${(e.providers || []).map(pp => pp.name).join('、')}已测）\n`);
    }
  }
  if (ctx.terrain.matches.length) {
    emit(`地形命中      : ${ctx.terrain.matches.map(m => `rank${m.rank} ${m.kind}`).join('、')}\n`);
  }
  const r = report.render || {};
  if (r.title) emit(`渲染标题      : 「${r.title}」\n`);
  if (r.paidQuotes && r.paidQuotes.length) emit(`付费原话候选  : ${r.paidQuotes.map(q => '「' + q + '」').join(' ')}\n`);
  if (ctx.letter) {
    emit(`\n[信件]        : ${ctx.letter.file}\n`);
    emit(`  主题        : ${ctx.letter.subjectLine}\n`);
    emit(`  未填槽位    : ${ctx.letter.unresolvedSlots.length ? ctx.letter.unresolvedSlots.join('、') : '无'}\n`);
  }
  if (ctx.failures.length) emit(`\n降级阶段      : ${ctx.failures.join('；')}\n`);

  emit('\n════════════ ⚠ 发送环节请人工操作 ═════════════\n');
  emit(`\n本工具只生成材料，不发送邮件。请按以下步骤人工发送（规格书第 5 节）：\n`);
  emit(`  1. 收件人：moment@tencent.com\n`);
  emit(`  2. 主题  ：${ctx.letter ? ctx.letter.subjectLine : `违规链接举报反馈【${domPart}】`}\n`);
  emit(`  3. 正文  ：复制「正文」段到邮件正文，逐字不改骨架\n`);
  emit(`  4. 附件  ：同目录下的首屏 / 整页截图（渲染失败则需人工补截图）\n`);
  emit(`  5. 重测  ：正文里每个 URL 发送前当场重测（见「发送前当场重测」段）\n`);
  emit(`  6. 自检  ：对照「发送前自检」逐项打勾\n`);
  emit(`\n  【铁律】记下发送时间 T；失败判据只看【收件方退信】。\n`);
  emit(`         任何情况下都【不要】因"本地已发送里查不到"而重发。\n`);
  emit(`         详见规格书第 5.2 节（重复投递无法撤回）。\n\n`);
}

// ── 参数解析 ───────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { beianRemote: false, render: true, terrain: true };
  let cmd = null;
  let url = null;
  for (const a of args) {
    if (a === '-h' || a === '--help') return { cmd: 'help', url: null, opts };
    if (a.startsWith('--')) {
      if (a === '--beian-remote') opts.beianRemote = true;
      else if (a === '--no-render') opts.render = false;
      else if (a === '--no-terrain') opts.terrain = false;
      else { fail(`未知选项：${a}`); return null; }
    } else if (!cmd && /^(letter|probe)$/i.test(a)) { cmd = a.toLowerCase(); }
    else if (url === null) { url = a; }
    else { fail(`多余的参数：${a}`); return null; }
  }
  if (cmd === 'help') return { cmd: 'help', url: null, opts };
  return { cmd: cmd || 'run', url, opts };
}

function usage() {
  emit([
    '用法: node cli.js <URL> [选项]',
    '      node cli.js letter <report.json>',
    '      node cli.js probe <URL>',
    '',
    '选项:',
    '  --beian-remote   启用远程备案渠道（默认仅本地页面自述扫描）',
    '  --no-render      跳过 Playwright 渲染（无截图，信件标记⚠）',
    '  --no-terrain     跳过地形关联比对',
    '  -h, --help       显示本帮助',
    '',
    '说明:',
    '  报告写入 reports/<域名>-<时间戳>/，每跑一次新建目录，不覆盖历史底档。',
    '  信件生成失败不阻塞 report.json 落盘，可事后用 letter 子命令重生成。',
    '  本工具不发送邮件（规格书 5.2 防重复投递铁律）。',
  ].join('\n'));
}

// ── 入口 ───────────────────────────────────────────────────────

async function main() {
  if (process.stdout.isTTY) {
    // Windows 默认 GBK 代码页会让中文在终端乱码，粘贴进邮箱后正文不可读。
    const chcp = process.platform === 'win32' ? +(process.env.CHCP || 0) : 0;
    if (chcp !== 65001) warn(`Windows 终端当前代码页 ${chcp || '未知'}，中文可能乱码：发送前请先执行 chcp 65001`);
  }
  const parsed = parseArgs(process.argv);
  if (!parsed) process.exit(2);
  if (parsed.cmd === 'help') { usage(); process.exit(0); }

  let rc = 0;
  if (parsed.cmd === 'letter') {
    if (!parsed.url) { fail('letter 子命令需要 report.json 路径'); usage(); rc = 2; }
    else rc = await cmdLetter(parsed.url);
  } else if (parsed.cmd === 'probe') {
    if (!parsed.url) { fail('probe 子命令需要 URL'); usage(); rc = 2; }
    else rc = await cmdProbe(parsed.url);
  } else if (parsed.cmd === 'run') {
    let url;
    try { url = new URL(parsed.url).href; } catch { fail(`无效 URL：${parsed.url}`); rc = 2; url = null; }
    if (url) rc = (await runFull(url, parsed.opts)).rc;
  } else {
    fail(`未知子命令：${parsed.cmd}`); rc = 2;
  }
  process.exit(rc);
}

// 仅在被直接执行时启动；被 require（测试）时不自动跑。
if (require.main === module) main();

module.exports = { parseArgs, runFull, cmdLetter, cmdProbe, printSummary, setLogSink, main };