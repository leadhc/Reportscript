// 离线测试集（实施计划第 9 步）。零测试框架依赖：node:assert + 自制微型 runner。
//
// 覆盖验证方案「离线」一节的全部断言：
//   1. 四种 fixture 分类正确（302 → redirect / 直出 → direct / iframe 壳 / 403 blocked）
//   2. 模板选择正确（redirect→B、direct→A、壳/被挡→需人工裁决）
//   3. 付费原话提取
//   4. MD5 逐字节断言（identity 语义）
//   5. 模板骨架回归（固定句逐字在位）
//   6. 脱敏纪律（token 名黑名单命中即报错）
//   7. terrain 关联按强度排序、whois/备案降级口径、本地自述扫描
//
// 运行：npm test  或  node fixtures/run.js
// 不启动 Playwright（渲染取证按计划第 6 步在普通终端人工执行）。

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startServer, PAGES } = require('./server');
const { probeTarget, registrableDomain, mainDomainOf, extractTitle } = require('../lib/probe');
const { normalizeLocation } = require('../lib/net');
const { WXUA, PLAIN_UA } = require('../lib/constants');
const { loadTerrain, matchTerrain } = require('../lib/terrain');
const {
  generateLetter, loadTemplate, stripQuery, redactUrl,
  assertNoTokenLeak, collectTokenNames,
} = require('../lib/letter');
const { extractPaidQuotes } = require('../lib/render');
const { localScan } = require('../lib/beian');

// ── 微型 runner ────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function runAll() {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      process.stdout.write(`  ✓  ${t.name}\n`);
    } catch (e) {
      failures.push({ name: t.name, error: e });
      process.stdout.write(`  ✗  ${t.name}\n       ${String(e && e.message).split('\n')[0]}\n`);
    }
  }
  process.stdout.write(`\n${failures.length ? '✗' : '✓'} fixtures: ${pass}/${tests.length} 通过\n`);
  if (failures.length) {
    process.stdout.write('\n失败详情：\n');
    for (const f of failures) process.stdout.write(`\n── ${f.name} ──\n${f.error && f.error.stack ? f.error.stack : f.error}\n`);
  }
  return failures.length;
}

// ── 工具 ───────────────────────────────────────────────────────

function tmpOutDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'report-tool-fix-'));
}
function md5str(s) {
  return crypto.createHash('md5').update(Buffer.from(s)).digest('hex');
}
function contains(hay, needle) {
  assert.ok(String(hay).includes(needle), `期望包含「${needle}」，实际未找到\n--- 实际 ---\n${hay}`);
}

// ══════════════════════════════════════════════════════════════

// 1. 纯函数：注册域提取 / Location 归一化 / 脱敏
test('registrableDomain：常见后缀与多级后缀', () => {
  assert.strictEqual(registrableDomain('ysddxmdfcjsd80.jsntcygg.com'), 'jsntcygg.com');
  assert.strictEqual(registrableDomain('a.b.example.com.cn'), 'example.com.cn');
  assert.strictEqual(registrableDomain('nfd109.yskyl.baby'), 'yskyl.baby');
  assert.strictEqual(registrableDomain('localhost'), 'localhost');
});

test('registrableDomain：大小写 / 尾点 / 深子域 / 新增二级后缀 / IP 兜底', () => {
  assert.strictEqual(registrableDomain('NFD109.YSKYL.BABY'), 'yskyl.baby');
  assert.strictEqual(registrableDomain('cs.6dfat1z.cn.'), '6dfat1z.cn');
  assert.strictEqual(registrableDomain('a.b.c.example.co.uk'), 'example.co.uk');
  assert.strictEqual(registrableDomain('x.example.com.br'), 'example.com.br');
  // IP 字面量没有注册域概念，必须原样返回（不得切成 11.179）
  assert.strictEqual(registrableDomain('47.57.11.179'), '47.57.11.179');
  assert.strictEqual(registrableDomain(''), '');
});

test('mainDomainOf：URL 与裸 host 均能取到主域名', () => {
  assert.strictEqual(mainDomainOf('https://ysddxmdfcjsd80.jsntcygg.com/p/?a=1'), 'jsntcygg.com');
  assert.strictEqual(mainDomainOf('nfd109.yskyl.baby'), 'yskyl.baby');
  assert.strictEqual(mainDomainOf('//h2.example.com/x', 'https://a.example.com/'), 'example.com');
  assert.strictEqual(mainDomainOf(''), null);
});

test('normalizeLocation：绝对 / 相对 / 协议相对', () => {
  assert.strictEqual(normalizeLocation('/b', 'http://h/a'), 'http://h/b');
  assert.strictEqual(normalizeLocation('//h2/x', 'http://h/'), 'http://h2/x');
  assert.strictEqual(normalizeLocation('https://c/d', 'http://h/'), 'https://c/d');
  assert.strictEqual(normalizeLocation('http://[', 'http://h/'), null, '非法 URL 应归一化为 null');
});

test('脱敏：stripQuery 去 query、redactUrl 变 ?…', () => {
  assert.strictEqual(stripQuery('https://nfd109.yskyl.baby/?a=1&b=2'), 'https://nfd109.yskyl.baby');
  assert.strictEqual(redactUrl('https://nfd109.yskyl.baby/p/?a=1&b=2'), 'https://nfd109.yskyl.baby/p?…');
  assert.strictEqual(redactUrl('https://x.com/'), 'https://x.com');
});

// 2. 模板骨架回归
test('骨架回归：三套模板固定句逐字在位', () => {
  for (const name of ['A', 'B', 'C']) {
    assert.doesNotThrow(() => loadTemplate(name), `模板 ${name} 骨架校验不应失败`);
  }
  contains(loadTemplate('A'), '以封建迷信类内容诱导用户付费，申请核查处理。');
  contains(loadTemplate('B'), '（携带完整投放参数）');
  contains(loadTemplate('C'), '以下地址通过微信均可以正常访问并传播');
});

test('骨架回归：A 模板骨架句清单', () => {
  const t = loadTemplate('A');
  for (const p of ['通过微信可以正常访问并传播', '一级域名及备案信息如下：', '二级域名及可核验访问地址如下：', '页面截图如下：']) {
    contains(t, p);
  }
});

// 3. 付费原话提取（render 纯函数，不启浏览器）
test('付费原话提取：命中付费/仅供参考/元等特征行', () => {
  const text = '姓名 | 性别 | 生辰 | 立即分析 | 本报告需付费后方可查看结果，结果仅供参考！ | 本次姓名打分为39元付费服务，付费后可查看报告';
  const q = extractPaidQuotes(text);
  assert.ok(q.length >= 2, `期望至少 2 条付费原话，实际 ${q.length}：${JSON.stringify(q)}`);
  assert.ok(q.some(s => s.includes('付费后可查看报告')));
  assert.ok(q.some(s => s.includes('仅供参考')));
});

// 4. 本地页面自述扫描（备案 provider #0）
test('备案本地扫描：提取 ICP 号与主体名', () => {
  const dir = tmpOutDir();
  fs.writeFileSync(path.join(dir, 'b_raw.html'),
    '<footer>版权所有 某某网络科技有限公司 闽ICP备2024043513号-8</footer>');
  const scan = localScan(dir);
  assert.ok(scan.icpNumbers.includes('闽ICP备2024043513号-8'), JSON.stringify(scan));
  assert.ok(scan.companies.some(c => c.includes('有限公司')), JSON.stringify(scan));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('备案本地扫描：多域场景按页面归属绑定，不把 B 页自述备案号算到 A 域名头上', () => {
  const dir = tmpOutDir();
  fs.writeFileSync(path.join(dir, 'b_raw.html'),
    '<footer>版权所有 某某网络科技有限公司 闽ICP备2024043513号-8</footer>');
  const owners = { 'b_raw.html': 'b.example.com', 'b_www.html': 'a.example.com' };
  // 落地页属 B：查 B 命中
  const hitB = localScan(dir, 'b.example.com', owners);
  assert.ok(hitB.icpNumbers.includes('闽ICP备2024043513号-8'), JSON.stringify(hitB));
  // 落地页不属于 A，且 A 无自有页面：查 A 不得命中（防张冠李戴）
  const missA = localScan(dir, 'a.example.com', owners);
  assert.deepStrictEqual(missA.icpNumbers, [], JSON.stringify(missA));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pageOwners：b_raw=落地域 / b_www=输入域 / b_rendered=渲染落地域', () => {
  const { pageOwners } = require('../cli');
  const owners = pageOwners(
    { finalRegistrableDomain: 'example-b.com' },
    { finalUrl: 'https://x.example-c.com/y' },
    'example-a.com',
  );
  assert.strictEqual(owners['b_raw.html'], 'example-b.com');
  assert.strictEqual(owners['b_www.html'], 'example-a.com');
  assert.strictEqual(owners['b_rendered.html'], 'example-c.com');
});

// 5. terrain 关联：按 7.4 强度排序
test('terrain 关联：IP/md5/CNAME 命中且按强度升序', () => {
  const terrain = loadTerrain();
  const obs = {
    ips: ['121.40.169.198'],
    cnameChain: ['cname.akge.cn'],
    md5s: ['2d1fc51fe521a6cbe276544bc36c4e58'],
    pageTitle: '名字打分',
    icpNumber: null,
  };
  const { matches, note } = matchTerrain(obs, terrain);
  const kinds = matches.map(m => m.kind);
  assert.ok(kinds.includes('md5'), JSON.stringify(kinds));
  assert.ok(kinds.includes('cname'), JSON.stringify(kinds));
  assert.ok(kinds.includes('ip'), JSON.stringify(kinds));
  const ranks = matches.map(m => m.rank);
  assert.deepStrictEqual(ranks, [...ranks].sort((a, b) => a - b), `应按 rank 升序：${ranks}`);
  assert.ok(matches.find(m => m.kind === 'ip').rank === 5);
  assert.ok(matches.find(m => m.kind === 'md5').rank === 2);
  contains(note, '不得断言「同一家公司」');
  contains(matches.find(m => m.kind === 'md5').detail, '系同一套系统在多个域名部署');
});

// 6. 脱敏拦截
test('脱敏拦截：正文出现参数名即报错终止', () => {
  assert.throws(
    () => assertNoTokenLeak('这一行泄露了 token 名', 'https://x.com/?token=1', ['token']),
    /脱敏拦截/,
  );
  // 输入 URL 原样豁免：整串出现不算泄露
  assert.doesNotThrow(
    () => assertNoTokenLeak('访问地址：https://x.com/?token=1 结束', 'https://x.com/?token=1', ['token']),
  );
});

// 7. 端到端分类（本地服务器）
test('fixture /b 直出型 → direct / 模板 A + MD5 逐字节 + identity + 微信 UA', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    const before = srv.requests.length;
    const p = await probeTarget(`${srv.baseUrl}/b`, out);
    assert.strictEqual(p.type, 'direct');
    assert.strictEqual(p.template, 'A');
    assert.strictEqual(p.finalRaw.md5, md5str(PAGES.b), 'MD5 必须与 fixture 字节一致（identity 语义）');
    assert.strictEqual(p.finalRaw.contentEncoding, 'identity');
    assert.strictEqual(p.finalRaw.title, '名字打分');
    assert.strictEqual(extractTitle(PAGES.b), '名字打分');
    // 本段请求的 UA / 编码纪律
    const seg = srv.requests.slice(before);
    assert.ok(seg.length > 0);
    for (const r of seg) {
      assert.strictEqual(r.acceptEncoding, 'identity', `请求 ${r.path} 必须显式 identity`);
      assert.strictEqual(r.userAgent, WXUA, `请求 ${r.path} 必须微信 UA`);
    }
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fixture /a 跳转型 → redirect / 模板 B，链尾为 /b', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    const p = await probeTarget(`${srv.baseUrl}/a`, out);
    assert.strictEqual(p.type, 'redirect');
    assert.strictEqual(p.template, 'B');
    assert.strictEqual(p.chain.length, 2, `期望 2 跳，实际 ${JSON.stringify(p.chain.map(c => c.status))}`);
    assert.strictEqual(p.chain[0].status, 302);
    assert.strictEqual(p.chain[1].status, 200);
    assert.ok(p.finalUrl.endsWith('/b'));
    assert.strictEqual(p.finalRaw.md5, md5str(PAGES.b));
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fixture /shell iframe 壳 → iframe-shell / 不自动套模板', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    const p = await probeTarget(`${srv.baseUrl}/shell`, out);
    assert.strictEqual(p.type, 'iframe-shell');
    assert.strictEqual(p.template, null, 'iframe 壳需人工裁决，不得自动选模板');
    assert.ok(p.chain.length >= 2, '应跟随 iframe src 到目标页');
    assert.strictEqual(p.chain[0].status, 200);
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('fixture /blocked 403 → blocked / 换裸 UA 重试如实记录', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    const before = srv.requests.length;
    const p = await probeTarget(`${srv.baseUrl}/blocked`, out);
    assert.strictEqual(p.type, 'blocked');
    assert.strictEqual(p.template, null);
    assert.strictEqual(p.blocked.wxTried.status, 403);
    assert.strictEqual(p.blocked.plainTried.status, 403);
    const seg = srv.requests.slice(before);
    assert.ok(seg.some(r => r.userAgent === PLAIN_UA), 'blocked 时应换裸 UA 重试一次');
    for (const r of seg) assert.strictEqual(r.acceptEncoding, 'identity');
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('首跳证据落盘：直出型 h_a.txt=200 头 / b_a.html 与 b_raw.html 同源', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    await probeTarget(`${srv.baseUrl}/b`, out);
    const hA = fs.readFileSync(path.join(out, 'h_a.txt'), 'utf8');
    assert.ok(hA.startsWith('HTTP/1.1 200 OK\n'), `h_a.txt 首行应为 curl -D 风格：${JSON.stringify(hA.slice(0, 40))}`);
    assert.ok(/^content-type: text\/html/im.test(hA), `h_a.txt 应含 content-type：${hA}`);
    const bA = fs.readFileSync(path.join(out, 'b_a.html'));
    const bRaw = fs.readFileSync(path.join(out, 'b_raw.html'));
    assert.strictEqual(md5str(bA), md5str(PAGES.b), 'b_a.html 应为首跳响应体原样');
    assert.strictEqual(md5str(bA), md5str(bRaw), 'direct 时 b_a.html 应与 b_raw.html 逐字节一致');
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('首跳证据落盘：跳转型 h_a.txt 记录 302 与 Location / b_a.html 存在', async () => {
  const srv = await startServer();
  const out = tmpOutDir();
  try {
    await probeTarget(`${srv.baseUrl}/a`, out);
    const hA = fs.readFileSync(path.join(out, 'h_a.txt'), 'utf8');
    assert.ok(hA.startsWith('HTTP/1.1 302 Found\n'), `h_a.txt 首行应为 302：${JSON.stringify(hA.slice(0, 40))}`);
    assert.ok(/^location: \/b$/im.test(hA), `h_a.txt 应含 Location: /b：${hA}`);
    assert.ok(fs.existsSync(path.join(out, 'b_a.html')), 'b_a.html 必须存在（跳转壳响应体）');
    // 首跳壳与终点页是两个不同文件（A→B 证据）
    assert.ok(fs.existsSync(path.join(out, 'b_raw.html')), 'b_raw.html 终点页必须存在');
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// 8. 信件组装端到端（合成 report，覆盖 B 模板 + 脱敏 + 主题行）
function synthReport() {
  const inputUrl = 'https://ysddxmdfcjsd80.example-a.com/?token=tk_abc&sign=deadbeef';
  return {
    tool: 'report-tool/test',
    inputUrl,
    generatedAt: new Date().toISOString(),
    resolvedDomain: 'example-a.com',
    input: { url: inputUrl },
    target: { host: 'ysddxmdfcjsd80.example-a.com', registrableDomain: 'example-a.com' },
    probe: {
      type: 'redirect',
      template: 'B',
      chain: [
        { url: inputUrl, status: 302, location: 'https://nfd109.example-b.com/?token=tk_abc&sign=deadbeef' },
        { url: 'https://nfd109.example-b.com/?token=tk_abc&sign=deadbeef', status: 200, location: null },
      ],
      finalUrl: 'https://nfd109.example-b.com/?token=tk_abc&sign=deadbeef',
      finalRegistrableDomain: 'example-b.com',
      finalRaw: { md5: 'd6885b1e6299b4afa80383aa4d31b1a8', sizeBytes: 27183, contentEncoding: 'identity', title: '名字打分' },
      businessPaths: [],
      catchAll: null,
      wwwVariant: { url: 'https://www.example-a.com/', status: 200, md5: 'aaaa', sizeBytes: 27183, title: '名字打分', file: 'b_www.html' },
    },
    dns: {
      'ysddxmdfcjsd80.example-a.com': { cnameChain: ['all.example-a.com.a1.initcc.com'], ips: ['101.71.160.100'] },
      'nfd109.example-b.com': { cnameChain: [], ips: ['121.40.169.198'] },
    },
    whois: {
      'example-a.com': { status: 'ok', registrar: 'eName Technology Co., Ltd.', registrarName: '厦门易名科技', registeredAt: '2025-04-09', nameservers: ['ns1.example.net'] },
      'example-b.com': { status: 'ok', registrar: 'Dynadot Inc', registrarName: '境外注册商Dynadot', registeredAt: '2026-10-04', nameservers: ['ns2.example.net'] },
    },
    beian: {
      status: 'degraded',
      perDomain: {
        'example-a.com': { domain: 'example-a.com', status: 'degraded', icpNumber: null, providers: [] },
        'example-b.com': { domain: 'example-b.com', status: 'degraded', icpNumber: null, providers: [] },
      },
      totalMs: 3,
    },
    terrain: { matches: [], note: '' },
    fingerprint: { knownMatches: [] },
    render: {
      entryUrl: inputUrl,
      finalUrl: 'https://nfd109.example-b.com/?token=tk_abc&sign=deadbeef',
      title: '名字打分',
      text: '姓名 | 本报告需付费后方可查看结果，结果仅供参考！ | 本次姓名打分为39元付费服务，付费后可查看报告',
      paidQuotes: ['本报告需付费后方可查看结果，结果仅供参考！', '本次姓名打分为39元付费服务，付费后可查看报告'],
      screenshots: { viewport: 'example-b.com_首屏.png', fullPage: 'example-b.com_整页.png' },
    },
  };
}

test('信件组装（模板 B）：骨架在位 / 槽位填齐 / 主题行含双域', () => {
  const out = tmpOutDir();
  try {
    const report = synthReport();
    const r = generateLetter(report, out);
    assert.strictEqual(r.template, 'B');
    assert.strictEqual(r.subjectLine, '违规链接举报反馈【example-a.com / example-b.com】');
    assert.deepStrictEqual(r.unresolvedSlots, [], `不应有未填槽位：${r.unresolvedSlots.join('、')}`);

    const md = fs.readFileSync(path.join(out, r.file), 'utf8');
    contains(md, '通过微信可以正常访问');
    contains(md, '（携带完整投放参数）');
    contains(md, '以封建迷信类内容诱导用户付费，申请核查处理。');
    contains(md, '一级域名及备案信息如下：');
    contains(md, '二级域名及可核验访问地址如下：');
    contains(md, '页面截图如下：');
    contains(md, 'moment@tencent.com');
    // 正文里 A 页 URL 原样保留（含投放参数）
    contains(md, report.input.url);
    // 底档：B 页 URL 必须脱 query，正文不得出现 B 页的 token 参数
    const body = md.split('## 正文（复制以下内容到邮件正文）')[1].split('## 取证底档')[0];
    contains(body, 'https://nfd109.example-b.com');
    assert.ok(!body.includes('nfd109.example-b.com/?'), 'B 页 URL 必须脱 query（不得带投放参数）');
    // A 页 URL 原样保留：参数只应随 A 页 URL 出现，不得被单独点名
    assert.ok(body.includes(report.input.url), 'A 页 URL 应原样保留投放参数');
    // 举报信只保留正文 + 底档：重测/自检两节已按产品要求移除
    assert.ok(!md.includes('发送前当场重测'), '举报信不应再含「发送前重测」节');
    assert.ok(!md.includes('发送前自检'), '举报信不应再含「发送前自检」节');
    contains(md, '## 取证底档');
    // 取证底档：DNS 行应能解析出输入域 CNAME 与落地域 IP（回归 dns 键名 bug）
    contains(md, 'all.example-a.com.a1.initcc.com');
    contains(md, '101.71.160.100');
    contains(md, '121.40.169.198');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('信件组装：iframe 壳/被挡类型拒绝自动出信（需人工裁决）', () => {
  const out = tmpOutDir();
  try {
    const report = synthReport();
    report.probe.type = 'iframe-shell';
    report.probe.template = null;
    assert.throws(() => generateLetter(report, out), /人工裁决/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('collectTokenNames：从 probe 链提取参数名黑名单', () => {
  const names = collectTokenNames(synthReport().probe);
  assert.ok(names.includes('token'), JSON.stringify(names));
  assert.ok(names.includes('sign'), JSON.stringify(names));
});

test('主域名收敛：输入 + 每跳 + catch-all + www + 渲染落地全部抓到', () => {
  const { collectLinkUrls, hostsAndDomains } = require('../cli');
  const input = new URL('https://a.entry.com/?t=1');
  const probe = {
    chain: [
      { url: 'https://a.entry.com/?t=1', status: 302, location: 'https://b.mid.net/step' },
      { url: 'https://b.mid.net/step', status: 302, location: 'https://c.final.org/b' },
      { url: 'https://c.final.org/b', status: 200, location: null },
    ],
    catchAll: { host: 'c.final.org', count: 23 },
    wwwVariant: { url: 'https://www.entry.com/' },
  };
  const render = { finalUrl: 'https://d.js-land.co/real?x=1' };
  const { hosts, domains } = hostsAndDomains(collectLinkUrls(input, probe, render));
  for (const d of ['entry.com', 'mid.net', 'final.org', 'js-land.co']) {
    assert.ok(domains.includes(d), `应抓到主域名 ${d}：${JSON.stringify(domains)}`);
  }
  assert.strictEqual(domains[0], 'entry.com', '输入域必须在首位');
  for (const h of ['a.entry.com', 'b.mid.net', 'c.final.org', 'www.entry.com', 'd.js-land.co']) {
    assert.ok(hosts.includes(h), `应抓到主机 ${h}：${JSON.stringify(hosts)}`);
  }
});

test('信件组装：涉及多个一级域名时，主题与「一级域名/二级域名」块全部列出', () => {
  const out = tmpOutDir();
  try {
    const report = synthReport();
    report.mainDomains = ['example-a.com', 'example-b.com', 'example-c.com'];
    report.linkUrls = [
      report.input.url,
      'https://nfd109.example-b.com/?token=tk_abc&sign=deadbeef',
      'https://x.example-c.com/b?token=tk_abc',
    ];
    report.whois['example-c.com'] = { status: 'ok', registrar: 'X', registrarName: null, registeredAt: '2026-01-01', nameservers: [] };

    const r = generateLetter(report, out);
    assert.strictEqual(r.subjectLine, '违规链接举报反馈【example-a.com / example-b.com / example-c.com】');

    const md = fs.readFileSync(path.join(out, r.file), 'utf8');
    const body = md.split('## 正文（复制以下内容到邮件正文）')[1].split('## 取证底档')[0];
    for (const d of ['example-a.com', 'example-b.com', 'example-c.com']) contains(body, `域名：${d}`);
    contains(body, '域名：x.example-c.com');
    // 首个一级域名由骨架「域名：{一级域名}」行给出，主体信息块不得重复该行
    const firstDomainLines = body.split('\n').filter(l => l.trim() === '域名：example-a.com');
    assert.strictEqual(firstDomainLines.length, 1, `首个一级域名行应只出现一次：${JSON.stringify(firstDomainLines)}`);
    assert.ok(!body.includes('x.example-c.com/b?'), '新域主机 URL 必须脱 query');
    assert.doesNotThrow(() => assertNoTokenLeak(body, report.input.url, collectTokenNames(report.probe)));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('cli 可被 require：入口有 require.main 守卫，不自动执行', () => {
  const cli = require('../cli');
  assert.strictEqual(typeof cli.runFull, 'function');
  assert.strictEqual(typeof cli.main, 'function');
  assert.strictEqual(typeof cli.printSummary, 'function');
});

test('reports 清理：只保留最近 10 份，非记录目录/文件不动', () => {
  const { pruneReports } = require('../cli');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  try {
    const names = [];
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 13; i++) {
      const n = `x.com-2026-10-13-10-00-${String(i).padStart(2, '0')}`;
      const abs = path.join(tmp, n);
      fs.mkdirSync(abs);
      const t = new Date(base + i * 60000); // 越大越新
      fs.utimesSync(abs, t, t);
      names.push(n);
    }
    fs.mkdirSync(path.join(tmp, 'tmp-step2'));           // 非本工具记录目录 → 不碰
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x');  // 非目录 → 不碰

    const removed = pruneReports(10, tmp);

    assert.deepStrictEqual(removed, names.slice(0, 3), `应按修改时间删最旧的 3 份：${removed}`);
    const left = fs.readdirSync(tmp).filter(n => /^x\.com-/.test(n));
    assert.strictEqual(left.length, 10, `应剩 10 份：${left}`);
    assert.ok(!fs.existsSync(path.join(tmp, names[0])), '最旧一份应被删除');
    assert.ok(fs.existsSync(path.join(tmp, names[12])), '最新一份必须保留');
    assert.ok(fs.existsSync(path.join(tmp, 'tmp-step2')), '非记录目录不得删除');
    assert.ok(fs.existsSync(path.join(tmp, 'notes.txt')), '非目录不得删除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 入口 ───────────────────────────────────────────────────────

(async () => {
  process.stdout.write('fixtures 离线测试集\n\n');
  const failed = await runAll();
  process.exit(failed ? 1 : 0);
})();
