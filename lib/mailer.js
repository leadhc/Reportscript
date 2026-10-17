// 邮件发送模块（可选）：把已生成的举报信正文 + 截图通过 SMTP 发出。
//
// 纪律：
//   1. 只有用户在结果页明确点击「自动发送邮件」并二次确认后才发送；
//   2. 一个报告目录只允许成功发送一次（send.json 为标记），拒绝重复投递；
//   3. 无截图附件不发信（证据不完整）；
//   4. SMTP 口令只从环境变量读取，不写入任何文件、不回传前端；
//   5. 发送失败保留 send-attempt.json，便于排查；重试前需人工确认。

const fs = require('fs');
const path = require('path');

const DEFAULT_TO = 'moment@tencent.com';
const SEND_FILE = 'send.json';
const ATTEMPT_FILE = 'send-attempt.json';
const LOCK_FILE = 'send.lock';
const LOCK_STALE_MS = 5 * 60 * 1000;

class MailError extends Error {
  constructor(message, status = 500, code = 'mail-error') {
    super(message);
    this.name = 'MailError';
    this.status = status;
    this.code = code;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 读取 SMTP 配置。全部来自环境变量，口令不落盘。
 * @returns {{configured:boolean, host:string, port:number, secure:boolean,
 *            user:string, pass:string, from:string, to:string,
 *            replyTo:string|null, maxAttachMB:number}}
 */
function mailConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const from = String(process.env.MAIL_FROM || user).trim();
  const to = String(process.env.MAIL_TO || DEFAULT_TO).trim() || DEFAULT_TO;

  const portNum = parseInt(process.env.SMTP_PORT || '465', 10);
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 465;

  const secureRaw = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureRaw ? !['false', '0', 'no'].includes(secureRaw) : port === 465;

  const maxAttachMB = Math.max(1, parseInt(process.env.MAIL_MAX_ATTACH_MB || '20', 10) || 20);

  // 有用户名就必须有口令；无用户名则按无认证 SMTP 处理
  const authOk = !user || !!pass;
  const configured = !!(host && from && authOk);

  return {
    configured, host, port, secure, user, pass, from, to,
    replyTo: String(process.env.MAIL_REPLY_TO || '').trim() || null,
    maxAttachMB,
  };
}

/** 可安全回传前端的配置（不含口令）。 */
function publicMailConfig() {
  const c = mailConfig();
  return {
    configured: c.configured,
    host: c.host || null,
    port: c.port,
    secure: c.secure,
    from: c.from || null,
    to: c.to,
    maxAttachMB: c.maxAttachMB,
  };
}

/**
 * 从举报信 markdown 中提取邮件主题与正文。
 * 正文只取「## 正文（复制以下内容到邮件正文）」到「## 取证底档」之间的内容，
 * 取证底档不进邮件。
 * @returns {{subject:string|null, body:string|null}}
 */
function parseLetterMarkdown(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');

  const subjectMatch = text.match(/^-\s*\*\*主题\*\*\s*[：:]\s*(.+)$/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;

  const marker = '## 正文（复制以下内容到邮件正文）';
  let body = null;
  const start = text.indexOf(marker);
  if (start >= 0) {
    let rest = text.slice(start + marker.length);
    const cut = rest.match(/\n---\s*\n\s*##\s*取证底档/) || rest.match(/\n##\s*取证底档/);
    if (cut) rest = rest.slice(0, cut.index);
    body = rest.replace(/^\s*\n/, '').trim() || null;
  }
  return { subject, body };
}

/** 报告目录里的举报信文件（取最后一个）。 */
function letterFileIn(dir) {
  try {
    const files = fs.readdirSync(dir).filter(n => /^举报信_.*\.md$/.test(n)).sort();
    return files.length ? files[files.length - 1] : null;
  } catch { return null; }
}

/** 收集渲染截图作为邮件附件（只认报告目录内实际存在的文件）。 */
function attachmentsFor(report, dir) {
  const shots = (report && report.render && report.render.screenshots) || {};
  const out = [];
  const seen = new Set();
  for (const name of [shots.viewport, shots.fullPage]) {
    if (!name) continue;
    const base = path.basename(String(name));
    if (seen.has(base)) continue;
    const abs = path.join(dir, base);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0) continue;
      seen.add(base);
      out.push({ filename: base, path: abs, size: st.size });
    } catch { /* 文件不存在则跳过 */ }
  }
  return out;
}

/**
 * 读取发送状态。
 *   sent    —— send.json 存在，已成功发送（禁止重发）
 *   sending —— 正在发送
 *   failed  —— 上次发送失败（可重试）
 *   unknown —— 上次发送中断且已超过锁有效期，结果未知（重试前须人工确认）
 *   none    —— 尚未发送
 */
function sendState(dir) {
  const sent = readJson(path.join(dir, SEND_FILE));
  if (sent && sent.status === 'sent') {
    return {
      state: 'sent',
      sentAt: sent.sentAt || null,
      messageId: sent.messageId || null,
      to: sent.to || null,
      subject: sent.subject || null,
      accepted: sent.accepted || [],
    };
  }

  const attemptPath = path.join(dir, ATTEMPT_FILE);
  const attempt = readJson(attemptPath);
  if (attempt) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(attemptPath).mtimeMs; } catch { /* ignore */ }
    const failed = attempt.status === 'failed';
    const stale = !failed && ageMs > LOCK_STALE_MS;
    return {
      state: failed ? 'failed' : (stale ? 'unknown' : 'sending'),
      startedAt: attempt.startedAt || null,
      to: attempt.to || null,
      subject: attempt.subject || null,
      error: attempt.error || null,
    };
  }

  return { state: 'none' };
}

/**
 * 发送举报邮件（成功后写 send.json，禁止重复投递）。
 * @param {string} dir 报告目录（含 report.json / 举报信_*.md / 截图）
 * @returns {Promise<object>} send.json 记录
 */
async function sendReportEmail(dir) {
  const cfg = mailConfig();
  if (!cfg.configured) {
    throw new MailError(
      '未配置 SMTP：请设置 SMTP_HOST 与 MAIL_FROM（需要认证时再设 SMTP_USER / SMTP_PASS）',
      400, 'not-configured',
    );
  }

  const reportPath = path.join(dir, 'report.json');
  if (!fs.existsSync(reportPath)) {
    throw new MailError('报告底档 report.json 不存在，无法发送', 404, 'no-report');
  }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch { throw new MailError('报告底档 report.json 解析失败', 500, 'bad-report'); }

  const letterFile = letterFileIn(dir);
  if (!letterFile) {
    throw new MailError('该报告尚未生成举报信，无法发送', 400, 'no-letter');
  }
  const markdown = fs.readFileSync(path.join(dir, letterFile), 'utf8');
  const parsed = parseLetterMarkdown(markdown);
  const subject = parsed.subject
    || `违规链接举报反馈【${report.resolvedDomain || '未知域名'}】`;
  if (!parsed.body) {
    throw new MailError('举报信缺少「正文」段，无法自动发送', 400, 'no-body');
  }

  const attachments = attachmentsFor(report, dir);
  if (!attachments.length) {
    throw new MailError('没有可用的截图附件；渲染失败时请人工补截图后再发送', 400, 'no-attachments');
  }
  const totalBytes = attachments.reduce((s, a) => s + a.size, 0);
  if (totalBytes > cfg.maxAttachMB * 1024 * 1024) {
    throw new MailError(
      `附件合计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，超过 ${cfg.maxAttachMB}MB 上限；请压缩截图后重试`,
      400, 'too-large',
    );
  }

  // 发送锁：防并发重复投递；进程异常退出留下的旧锁超过 5 分钟自动清理
  const lockPath = path.join(dir, LOCK_FILE);
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    let stale = false;
    try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { /* ignore */ }
    if (!stale) throw new MailError('该报告正在发送中，请稍后再试', 409, 'locked');
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    try { lockFd = fs.openSync(lockPath, 'wx'); }
    catch { throw new MailError('无法获取发送锁，请稍后再试', 409, 'locked'); }
  }

  let attemptWritten = false;
  try {
    // 拿到锁后再查一次，堵住并发窗口
    if (sendState(dir).state === 'sent') {
      throw new MailError('该报告已发送过，禁止重复投递', 409, 'already-sent');
    }

    const attempt = {
      status: 'sending',
      startedAt: new Date().toISOString(),
      to: cfg.to,
      subject,
      attachments: attachments.map(a => a.filename),
    };
    writeJsonAtomic(path.join(dir, ATTEMPT_FILE), attempt);
    attemptWritten = true;

    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new MailError('服务端未安装 nodemailer，请执行 npm install', 500, 'no-module'); }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
    });

    const info = await transporter.sendMail({
      from: cfg.from,
      to: cfg.to,
      replyTo: cfg.replyTo || undefined,
      subject,
      text: parsed.body,
      attachments: attachments.map(a => ({ filename: a.filename, path: a.path })),
    });

    const record = {
      status: 'sent',
      sentAt: new Date().toISOString(),
      to: cfg.to,
      from: cfg.from,
      subject,
      messageId: info.messageId || null,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      response: info.response || null,
      attachments: attachments.map(a => a.filename),
      totalBytes,
    };
    writeJsonAtomic(path.join(dir, SEND_FILE), record);
    try { fs.writeFileSync(path.join(dir, 'email-body.txt'), parsed.body, 'utf8'); } catch { /* 留档失败不阻塞 */ }
    try { fs.unlinkSync(path.join(dir, ATTEMPT_FILE)); } catch { /* ignore */ }
    return record;
  } catch (e) {
    if (attemptWritten) {
      const prev = readJson(path.join(dir, ATTEMPT_FILE)) || {};
      try {
        writeJsonAtomic(path.join(dir, ATTEMPT_FILE), {
          ...prev,
          status: 'failed',
          failedAt: new Date().toISOString(),
          error: String((e && e.message) || e).slice(0, 300),
        });
      } catch { /* ignore */ }
    }
    if (e instanceof MailError) throw e;
    throw new MailError(`邮件发送失败：${String((e && e.message) || e).slice(0, 240)}`, 502, 'smtp-error');
  } finally {
    if (lockFd !== null) { try { fs.closeSync(lockFd); } catch { /* ignore */ } }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

module.exports = {
  DEFAULT_TO, MailError,
  mailConfig, publicMailConfig, parseLetterMarkdown,
  attachmentsFor, sendState, sendReportEmail,
};
