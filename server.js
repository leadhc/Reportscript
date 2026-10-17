// server.js —— 微信违规链接举报工具的 Web 界面（零依赖，仅用 node:http）
//
// 作用：把命令行流水线（cli.js runFull）包成一个受口令保护的网页。
//   - 网页输入 URL → 服务端跑「侦察→DNS→whois→备案→地形→渲染→写信」
//   - 进度通过 SSE 实时推给前端
//   - 结果页可看举报信正文 / 重测 / 自检 / 底档、看截图、下载 .md 与 report.json
//   - 结果页可选择「复制正文手动发送」或「自动发送邮件」（SMTP 需配置）
//   - 内置模板 A/B/C 只读浏览，另可添加自定义模板（持久化到 data/templates.json）
//
// 纪律：默认只生成材料；自动发送必须由用户显式点击并二次确认，
//       成功后写 send.json，同一报告禁止重复投递（规格书 5.2）。
//
// 环境变量：
//   PORT           默认 10000（Render 会自动注入）
//   APP_PASSWORD   访问口令（强烈建议设置；未设置则每次启动随机生成并打印到日志）
//   BROWSER_CHANNEL 浏览器通道（本机 Windows 默认 msedge；容器留空用自带 Chromium）
//
// 启动：node server.js

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { runFull, setLogSink } = require('./cli');
const {
  sendReportEmail, sendState, publicMailConfig, attachmentsFor,
} = require('./lib/mailer');

const TOOL_ROOT = __dirname;
const REPORTS_DIR = path.join(TOOL_ROOT, 'reports');
const WEB_DIR = path.join(TOOL_ROOT, 'web');
const TEMPLATES_DIR = path.join(TOOL_ROOT, 'lib', 'templates');

// 用户数据目录（自定义模板等）：与 reports/ 同理，不进仓库 / 不进镜像，运行时落盘。
const DATA_DIR = path.join(TOOL_ROOT, 'data');
const CUSTOM_TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const MAX_TEMPLATE_CONTENT = 12000; // 单个自定义模板内容上限（字）

const PORT = +(process.env.PORT || 10000);
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_BODY = 64 * 1024;

// ── 口令 / 会话 ────────────────────────────────────────────────
let PASSWORD = process.env.APP_PASSWORD || '';
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.log('──────────────────────────────────────────────────────────');
  console.log('  未设置 APP_PASSWORD，已生成临时口令（重启会变）：');
  console.log('    口令：' + PASSWORD);
  console.log('  生产环境请在 Render 环境变量里设置 APP_PASSWORD。');
  console.log('──────────────────────────────────────────────────────────');
}

const sessions = new Map(); // sid -> expiresAt

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function newSession() {
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}

function validSession(sid) {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(sid); return false; }
  sessions.set(sid, Date.now() + SESSION_TTL_MS); // 滑动续期
  return true;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sidFrom(req) {
  const cookies = parseCookies(req);
  if (cookies.sid) return cookies.sid;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function isAuthed(req) { return validSession(sidFrom(req)); }

// ── HTTP 小工具 ────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// 把文件限制在某个根目录内（防目录穿越）
function safeJoin(rootDir, ...parts) {
  const p = path.resolve(rootDir, ...parts);
  const r = path.resolve(rootDir);
  if (p !== r && !p.startsWith(r + path.sep)) return null;
  return p;
}

function serveFile(res, absPath, { downloadName } = {}) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { sendJson(res, 404, { error: 'not found' }); return; }
  if (!stat.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
  const ext = path.extname(absPath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  res.writeHead(200, headers);
  fs.createReadStream(absPath).pipe(res);
}

// ── 报告读取 ───────────────────────────────────────────────────
const LETTER_RE = /^举报信_.*\.md$/;

function readDirArtifacts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } })
    .map(n => {
      const st = fs.statSync(path.join(dir, n));
      const ext = path.extname(n).toLowerCase();
      const kind = ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image'
        : ext === '.json' ? 'json'
          : ext === '.html' ? 'html' : 'text';
      return { name: n, size: st.size, kind };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function letterFileIn(dir) {
  try {
    const f = fs.readdirSync(dir).filter(n => LETTER_RE.test(n)).sort();
    return f.length ? f[f.length - 1] : null;
  } catch { return null; }
}

function summarizeDir(dir) {
  let report = null;
  const rp = path.join(dir, 'report.json');
  if (fs.existsSync(rp)) { try { report = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { /* ignore */ } }

  const lf = letterFileIn(dir);
  let letterMarkdown = null;
  if (lf) { try { letterMarkdown = fs.readFileSync(path.join(dir, lf), 'utf8'); } catch { /* ignore */ } }

  const probe = (report && report.probe) || {};
  const render = (report && report.render) || {};
  const subjectLine = report && report.letter && report.letter.subjectLine
    || (report && `违规链接举报反馈【${report.resolvedDomain}】`) || null;

  // 邮件发送能力与状态：未配置 SMTP 时前端只展示「手动复制发送」
  const mailCfg = publicMailConfig();
  const send = sendState(dir);
  const mail = {
    configured: mailCfg.configured,
    to: mailCfg.to,
    from: mailCfg.from,
    host: mailCfg.host,
    maxAttachMB: mailCfg.maxAttachMB,
    attachmentCount: attachmentsFor(report, dir).length,
    state: send.state,
    sentAt: send.sentAt || null,
    messageId: send.messageId || null,
    startedAt: send.startedAt || null,
    sendError: send.error || null,
    accepted: send.accepted || [],
    rejected: send.rejected || [],
    response: send.response || null,
  };

  return {
    outDirName: path.basename(dir),
    inputUrl: (report && report.inputUrl) || null,
    generatedAt: (report && report.generatedAt) || null,
    resolvedDomain: (report && report.resolvedDomain) || null,
    mainDomains: (report && report.mainDomains) || null,
    type: probe.type || null,
    template: probe.template || (report && report.template) || null,
    subjectLine,
    letterFile: lf,
    letterMarkdown,
    unresolvedSlots: (report && report.letter && report.letter.unresolvedSlots) || [],
    title: render.title || null,
    paidQuotes: render.paidQuotes || [],
    screenshotError: render.error || null,
    artifacts: readDirArtifacts(dir),
    mail,
    report,
  };
}

function listReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  let dirs = [];
  try { dirs = fs.readdirSync(REPORTS_DIR); } catch { return []; }
  return dirs
    .map(n => path.join(REPORTS_DIR, n))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .map(p => summarizeDir(p))
    .filter(s => s.report || s.letterMarkdown)
    .sort((a, b) => String(b.generatedAt || b.outDirName).localeCompare(String(a.generatedAt || a.outDirName)));
}

// ── 模板读取 / 自定义模板持久化 ─────────────────────────────────
// 内置 A/B/C 只读（举报信骨架，逐字沿用）；自定义模板存 data/templates.json，
// 进程重启 / 页面重开仍在。
function builtinTemplates() {
  const out = {};
  for (const f of ['A.md', 'B.md', 'C.md']) {
    const p = safeJoin(TEMPLATES_DIR, f);
    if (p && fs.existsSync(p)) out[f.replace('.md', '')] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

function readCustomTemplates() {
  try {
    const arr = JSON.parse(fs.readFileSync(CUSTOM_TEMPLATES_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.content === 'string');
  } catch { return []; } // 文件不存在 / 解析失败：视作空，不阻塞页面
}

function writeCustomTemplates(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CUSTOM_TEMPLATES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, CUSTOM_TEMPLATES_FILE); // 原子替换，避免留下半截文件
}

// ── 作业（单飞：一次只跑一个，避免日志串台） ────────────────────
const jobs = new Map();
let runningJobId = null;

function startJob(url, opts) {
  const id = crypto.randomBytes(8).toString('hex');
  const controller = new AbortController();
  const job = {
    id, url, opts, status: 'running', lines: [], subs: new Set(),
    startedAt: Date.now(), result: null, error: null, controller,
  };
  jobs.set(id, job);
  runningJobId = id;

  setLogSink(line => {
    job.lines.push(line);
    for (const s of job.subs) { try { s(line); } catch { /* ignore */ } }
  });

  Promise.resolve()
    .then(() => runFull(url, { ...opts, signal: controller.signal }))
    .then(res => {
      job.status = 'done';
      job.result = summarizeDir(res.outDir);
      job.result.failures = res.failures || [];
    })
    .catch(e => {
      if (controller.signal.aborted) {
        job.status = 'cancelled';
        job.error = '已取消取证';
      } else {
        job.status = 'error';
        job.error = String((e && e.message) || e);
      }
    })
    .finally(() => {
      setLogSink(null);
      if (runningJobId === id) runningJobId = null;
      for (const s of job.subs) { try { s(null); } catch { /* ignore */ } }
      job.subs.clear();
      job.controller = null;
    });

  return id;
}

function jobSummary(job) {
  return {
    id: job.id, url: job.url, status: job.status, error: job.error,
    startedAt: job.startedAt, result: job.result,
  };
}

// ── 路由 ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { sendJson(res, 400, { error: 'bad url' }); return; }
  const { pathname } = u;
  const method = req.method || 'GET';

  try {
    if (pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }

    // ── 公开：登录相关 ──
    if (pathname === '/api/login' && method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (!body || typeof body.password !== 'string' || !safeEqual(body.password, PASSWORD)) {
        sendJson(res, 401, { error: '口令不正确' });
        return;
      }
      const sid = newSession();
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/session' && method === 'GET') {
      sendJson(res, 200, { authed: isAuthed(req) });
      return;
    }

    // ── 静态资源（UI 本体不含敏感数据） ──
    if (!pathname.startsWith('/api/')) {
      let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const abs = safeJoin(WEB_DIR, rel);
      if (!abs) { sendJson(res, 400, { error: 'bad path' }); return; }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { serveFile(res, abs); return; }
      serveFile(res, path.join(WEB_DIR, 'index.html')); // SPA 兜底
      return;
    }

    // ── 以下均需登录 ──
    if (!isAuthed(req)) { sendJson(res, 401, { error: '未登录' }); return; }

    if (pathname === '/api/logout' && method === 'POST') {
      const sid = sidFrom(req);
      if (sid) sessions.delete(sid);
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      sendJson(res, 200, { ok: true });
      return;
    }

    // 邮件发送配置（只回传是否可用与收件人，不含口令）
    if (pathname === '/api/mail' && method === 'GET') {
      sendJson(res, 200, { mail: publicMailConfig() });
      return;
    }

    if (pathname === '/api/templates' && method === 'GET') {
      sendJson(res, 200, { templates: builtinTemplates(), custom: readCustomTemplates() });
      return;
    }

    // 新增自定义模板并持久化到 data/templates.json
    if (pathname === '/api/templates' && method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const name = String(body.name == null ? '' : body.name).trim();
      const content = String(body.content == null ? '' : body.content);
      if (!name) { sendJson(res, 400, { error: '请填模板名称' }); return; }
      if (name.length > 40) { sendJson(res, 400, { error: '模板名称过长（≤40 字）' }); return; }
      if (!content.trim()) { sendJson(res, 400, { error: '模板内容不能为空' }); return; }
      if (content.length > MAX_TEMPLATE_CONTENT) {
        sendJson(res, 400, { error: `模板内容过长（≤${MAX_TEMPLATE_CONTENT} 字）` });
        return;
      }
      const list = readCustomTemplates();
      const builtin = builtinTemplates();
      if (Object.prototype.hasOwnProperty.call(builtin, name) || list.some(t => t.name === name)) {
        sendJson(res, 409, { error: `模板名称「${name}」已存在` });
        return;
      }
      const tpl = { id: crypto.randomBytes(8).toString('hex'), name, content, createdAt: new Date().toISOString() };
      list.push(tpl);
      writeCustomTemplates(list);
      sendJson(res, 200, { ok: true, template: tpl });
      return;
    }

    // 删除自定义模板（内置 A/B/C 不可删）
    const dm = pathname.match(/^\/api\/templates\/([a-f0-9]+)$/);
    if (dm && method === 'DELETE') {
      const list = readCustomTemplates();
      const next = list.filter(t => t.id !== dm[1]);
      if (next.length === list.length) { sendJson(res, 404, { error: '模板不存在' }); return; }
      writeCustomTemplates(next);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/reports' && method === 'GET') {
      sendJson(res, 200, { reports: listReports().map(r => ({ ...r, letterMarkdown: undefined, report: undefined })) });
      return;
    }

    // /api/reports/:dir
    let m = pathname.match(/^\/api\/reports\/([^/]+)$/);
    if (m && method === 'GET') {
      const dir = safeJoin(REPORTS_DIR, decodeURIComponent(m[1]));
      if (!dir || !fs.existsSync(dir)) { sendJson(res, 404, { error: '报告不存在' }); return; }
      sendJson(res, 200, summarizeDir(dir));
      return;
    }

    // /api/reports/:dir/artifact/:name
    m = pathname.match(/^\/api\/reports\/([^/]+)\/artifact\/(.+)$/);
    if (m && method === 'GET') {
      const dir = safeJoin(REPORTS_DIR, decodeURIComponent(m[1]));
      if (!dir) { sendJson(res, 400, { error: 'bad path' }); return; }
      const file = safeJoin(dir, decodeURIComponent(m[2]));
      if (!file) { sendJson(res, 400, { error: 'bad path' }); return; }
      const dl = u.searchParams.get('download');
      serveFile(res, file, { downloadName: dl ? path.basename(file) : undefined });
      return;
    }

    // /api/reports/:dir/send  自动发送举报邮件（前端二次确认；服务端防重复投递）
    m = pathname.match(/^\/api\/reports\/([^/]+)\/send$/);
    if (m && method === 'POST') {
      try { await readBody(req); } catch { /* 无 body 也允许 */ }
      const dir = safeJoin(REPORTS_DIR, decodeURIComponent(m[1]));
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        sendJson(res, 404, { error: '报告不存在' });
        return;
      }
      try {
        const r = await sendReportEmail(dir);
        sendJson(res, 200, { ok: true, ...r, mail: publicMailConfig() });
      } catch (e) {
        const status = e && e.status ? e.status : 500;
        sendJson(res, status, {
          error: (e && e.message) || '发送失败',
          code: (e && e.code) || 'mail-error',
          send: sendState(dir),
        });
      }
      return;
    }

    // /api/run
    if (pathname === '/api/run' && method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const url = String(body.url || '').trim();
      let parsed;
      try { parsed = new URL(url); } catch { sendJson(res, 400, { error: 'URL 无效' }); return; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        sendJson(res, 400, { error: '只支持 http/https' });
        return;
      }
      if (runningJobId) { sendJson(res, 409, { error: '已有取证任务在运行，请等它跑完' }); return; }
      const opts = {
        render: body.render !== false,
        beianRemote: body.beianRemote === true,
        terrain: body.terrain !== false,
      };
      const id = startJob(parsed.href, opts);
      sendJson(res, 200, { jobId: id });
      return;
    }

    // /api/job/:id/cancel
    m = pathname.match(/^\/api\/job\/([a-f0-9]+)\/cancel$/);
    if (m && method === 'POST') {
      const job = jobs.get(m[1]);
      if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
      if (job.status === 'running' && job.controller) {
        const line = '  ⛔ 用户取消取证\n';
        job.lines.push(line);
        for (const s of job.subs) { try { s(line); } catch { /* ignore */ } }
        job.controller.abort();
      }
      sendJson(res, 200, { ok: true, status: job.status });
      return;
    }

    // /api/job/:id
    m = pathname.match(/^\/api\/job\/([a-f0-9]+)$/);
    if (m && method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
      sendJson(res, 200, jobSummary(job));
      return;
    }

    // /api/job/:id/events  (SSE)
    m = pathname.match(/^\/api\/job\/([a-f0-9]+)\/events$/);
    if (m && method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) { sendJson(res, 404, { error: '任务不存在' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = line => {
        if (line === null) { res.write('event: end\ndata: {}\n\n'); res.end(); return; }
        for (const part of String(line).replace(/\n+$/, '').split('\n')) res.write('data: ' + part + '\n');
        res.write('\n');
      };
      job.lines.forEach(send);
      if (job.status !== 'running') { send(null); return; }
      job.subs.add(send);
      req.on('close', () => job.subs.delete(send));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    try { sendJson(res, 500, { error: String((e && e.message) || e) }); } catch { /* ignore */ }
  }
});

fs.mkdirSync(REPORTS_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`[web] 举报工具已启动：http://localhost:${PORT}`);
  console.log(`[web] 报告目录：${REPORTS_DIR}`);
  console.log('[web] 默认人工发送；结果页可选自动发送（需配置 SMTP，成功后禁止重发）。');
});
