'use strict';

// ── 小工具 ─────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

// 按 "## " 标题切分举报信（保留顺序）
function splitSections(md) {
  const secs = [];
  let cur = { title: '（前言）', lines: [] };
  for (const line of String(md).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) { secs.push(cur); cur = { title: m[1].trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  secs.push(cur);
  return secs.map(s => ({ title: s.title, body: s.lines.join('\n') }));
}

function copyText(text) {
  const done = () => toast('已复制到剪贴板');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}
let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:99;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

// ── 登录 ───────────────────────────────────────────────────────
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

// 邮件发送配置（是否已配置 SMTP、默认收件人），口令不会回传前端
let mailConfig = { configured: false, to: 'moment@tencent.com' };
async function loadMailConfig() {
  try {
    const d = await api('/api/mail');
    if (d && d.mail) mailConfig = d.mail;
  } catch { /* 未登录或网络失败时保持默认（仅手动发送） */ }
}

async function init() {
  try {
    const s = await api('/api/session');
    if (s.authed) { showApp(); loadMailConfig(); loadHistory(); } else showLogin();
  } catch { showLogin(); }
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    showApp(); loadMailConfig(); loadHistory();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
});

// ── 顶部导航 ───────────────────────────────────────────────────
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  const v = t.dataset.view;
  $$('.view').forEach(s => s.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  if (v === 'history') loadHistory();
  if (v === 'templates') loadTemplates();
}));

// ── 取证（按钮三态：开始取证 / 取消取证 / 完成取证） ────────────
let evtSource = null;
let runState = 'idle';   // idle | running | done
let currentJobId = null;
let currentResult = null; // 本次取证完成的结果（取证区自动发送按钮的数据源）

function setRunState(state) {
  runState = state;
  const b = $('#run-btn');
  b.dataset.state = state;
  b.disabled = false;
  b.classList.remove('primary', 'danger', 'success');
  if (state === 'running') { b.textContent = '取消取证'; b.classList.add('danger'); }
  else if (state === 'done') { b.textContent = '完成取证'; b.classList.add('success'); }
  else { b.textContent = '开始取证'; b.classList.add('primary'); }
}

async function startRun() {
  const url = $('#url').value.trim();
  if (!url) { $('#run-status').textContent = '请先填 URL'; return; }
  $('#run-log').textContent = '';
  $('#result').innerHTML = '';
  currentResult = null;
  syncRunSendButton();
  $('#run-status').textContent = '提交中…';
  if (evtSource) { evtSource.close(); evtSource = null; }
  try {
    const r = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        url,
        render: $('#opt-render').checked,
        terrain: $('#opt-terrain').checked,
        beianRemote: $('#opt-beian').checked,
      }),
    });
    currentJobId = r.jobId;
    setRunState('running');
    openSSE(r.jobId);
  } catch (err) {
    $('#run-status').textContent = '失败：' + err.message;
    setRunState('idle');
  }
}

async function cancelRun() {
  if (!currentJobId) { setRunState('idle'); return; }
  $('#run-status').textContent = '正在取消…';
  try { await api('/api/job/' + currentJobId + '/cancel', { method: 'POST' }); }
  catch (err) { $('#run-status').textContent = '取消失败：' + err.message; }
}

function openSSE(jobId) {
  $('#run-status').textContent = '取证中…（可点「取消取证」中止）';
  const log = $('#run-log');
  evtSource = new EventSource('/api/job/' + jobId + '/events');
  evtSource.onmessage = ev => {
    log.textContent += ev.data + '\n';
    log.scrollTop = log.scrollHeight;
  };
  evtSource.addEventListener('end', async () => {
    if (evtSource) { evtSource.close(); evtSource = null; }
    try {
      const job = await api('/api/job/' + jobId);
      if (job.status === 'done') {
        $('#run-status').textContent = '取证完成';
        await loadMailConfig();
        renderResult(job.result);
        currentResult = job.result;
        syncRunSendButton();
        setRunState('done');
        loadHistory();
      } else if (job.status === 'cancelled') {
        $('#run-status').textContent = '已取消取证';
        currentResult = null;
        syncRunSendButton();
        setRunState('idle');
      } else {
        $('#run-status').textContent = '失败：' + (job.error || '未知错误');
        renderResult(job.result || { error: job.error });
        currentResult = null;
        syncRunSendButton();
        setRunState('idle');
      }
    } catch (err) {
      $('#run-status').textContent = '读取结果失败：' + err.message;
      currentResult = null;
      syncRunSendButton();
      setRunState('idle');
    } finally {
      currentJobId = null;
    }
  });
  evtSource.onerror = () => {
    if (evtSource && evtSource.readyState === EventSource.CLOSED) {
      $('#run-status').textContent = '连接中断，请到「历史报告」查看。';
      setRunState('idle');
    }
  };
}

// 按钮按状态派发
$('#run-btn').addEventListener('click', () => {
  if (runState === 'idle') startRun();
  else if (runState === 'running') cancelRun();
  else if (runState === 'done') setRunState('idle'); // 回到「开始取证」，便于接着跑下一个
});

// 取证区自动发送：发送「本次取证完成」的报告
$('#run-send-btn').addEventListener('click', () => {
  if (!currentResult) return;
  sendReport(currentResult, $('#run-send-btn'), $('#run-send-hint'));
});

// 表单回车 = 开始取证（仅 idle 时）
$('#run-form').addEventListener('submit', e => {
  e.preventDefault();
  if (runState === 'idle') startRun();
});

// 改动 URL 时，若处「完成」态则回到「开始取证」
$('#url').addEventListener('input', () => { if (runState === 'done') setRunState('idle'); });

setRunState('idle');

// ── 邮件发送状态（结果卡片 / 取证区按钮共用） ───────────────────
function mailUiState(s) {
  const mail = (s && s.mail) || {};
  const sent = mail.state === 'sent';
  const sending = mail.state === 'sending';
  const attachCount = Number(mail.attachmentCount || 0);
  const configured = !!mail.configured;
  const canSend = !!(s && s.letterFile) && configured && attachCount > 0 && !sent && !sending;
  const to = mail.to || mailConfig.to || 'moment@tencent.com';

  let label = '自动发送邮件';
  let hintClass = 'alert';
  let hint;
  if (sent) {
    label = '已发送';
    hint = `已于 ${mail.sentAt || '—'} 自动发送至 ${to}`
      + `${mail.messageId ? `（messageId: ${mail.messageId}）` : ''}`;
  } else if (sending) {
    label = '发送中…';
    hint = `正在发送至 ${to}，请稍候…`;
  } else if (!s || !s.letterFile) {
    hintClass = 'alert warn';
    hint = '缺少举报信文件，无法自动发送。';
  } else if (!configured) {
    hintClass = 'alert warn';
    hint = '自动发送未配置：服务端需设置 SMTP_HOST 与 MAIL_FROM（认证另需 SMTP_USER / SMTP_PASS）。仍可复制正文手动发送。';
  } else if (attachCount <= 0) {
    hintClass = 'alert warn';
    hint = '渲染未产出截图，不能自动发送；请人工补截图后再发送，或复制正文手动发送。';
  } else if (mail.state === 'unknown') {
    hintClass = 'alert warn';
    hint = `上次发送结果未知（${mail.startedAt || '—'}），请先确认对方是否收到，再决定是否重发。`;
  } else if (mail.state === 'failed') {
    hintClass = 'alert warn';
    hint = `上次发送失败：${mail.sendError || '未知错误'}。可重试，或复制正文手动发送。`;
  } else {
    hint = `自动发送将投递至 ${to}，附件 ${attachCount} 个截图；点击后会二次确认。`;
  }
  return { sent, sending, attachCount, configured, canSend, label, hint, hintClass, to, mail };
}

function renderSendState(btn, statusEl, ui) {
  if (btn) {
    btn.disabled = !ui.canSend;
    btn.textContent = ui.label;
    btn.classList.toggle('danger', ui.canSend);
  }
  if (statusEl) {
    statusEl.textContent = ui.hint;
    statusEl.className = ui.hintClass;
  }
}

// 取证完成后的区级按钮：只在有本次结果时显示
function syncRunSendButton() {
  const btn = $('#run-send-btn');
  const hint = $('#run-send-hint');
  if (!btn) return;
  const s = currentResult;
  if (!s || !s.letterMarkdown) {
    btn.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
    return;
  }
  const ui = mailUiState(s);
  btn.classList.remove('hidden');
  if (hint) hint.classList.remove('hidden');
  renderSendState(btn, hint, ui);
}

// 发送状态变化后同步「结果卡片」与「取证区按钮」两处 UI
function isCurrentReport(s) {
  return !!(currentResult && s && s.outDirName && currentResult.outDirName === s.outDirName);
}

function refreshCurrentResultSendUi(s) {
  if (!isCurrentReport(s)) return;
  currentResult.mail = s.mail;
  const box = $('#result');
  if (box) {
    renderSendState(box.querySelector('#send-mail'), box.querySelector('#send-status'), mailUiState(currentResult));
  }
  syncRunSendButton();
}

// ── 结果渲染 ───────────────────────────────────────────────────
function renderResult(s) {
  const box = $('#result');
  if (!s) { box.innerHTML = '<div class="card muted">无结果</div>'; return; }
  if (s.error && !s.outDirName) {
    box.innerHTML = `<div class="card"><div class="alert warn">取证失败：${esc(s.error)}</div></div>`;
    return;
  }

  const dir = s.outDirName;
  const artUrl = (name, dl) =>
    `/api/reports/${encodeURIComponent(dir)}/artifact/${encodeURIComponent(name)}${dl ? '?download=1' : ''}`;
  const images = (s.artifacts || []).filter(a => a.kind === 'image');
  const others = (s.artifacts || []).filter(a => a.kind !== 'image');

  let html = '<div class="card">';
  html += '<div class="meta">'
    + `<div><span class="k">类型 / 模板</span> ${esc(s.type || '—')} / ${esc(s.template || '需人工裁决')}</div>`
    + (s.mainDomains && s.mainDomains.length
      ? `<div><span class="k">一级域名</span> ${esc(s.mainDomains.join('、'))}</div>` : '')
    + `<div><span class="k">主题</span> ${esc(s.subjectLine || '—')}</div>`
    + `<div><span class="k">目录</span> ${esc(dir || '—')}</div>`
    + '</div>';

  if (s.screenshotError) html += `<div class="alert warn">渲染未成功：${esc(s.screenshotError)}（需人工补截图）</div>`;
  if (s.unresolvedSlots && s.unresolvedSlots.length) html += `<div class="alert warn">未填槽位（需人工补）：${esc(s.unresolvedSlots.join('、'))}</div>`;
  if (s.failures && s.failures.length) html += `<div class="alert warn">降级阶段：${esc(s.failures.join('；'))}</div>`;
  if (s.paidQuotes && s.paidQuotes.length) html += `<div class="alert">付费原话候选：${s.paidQuotes.map(q => '「' + esc(q) + '」').join(' ')}（人工复核）</div>`;
  if (!s.letterMarkdown) html += '<div class="alert warn">未生成举报信——该类型可能需人工裁决后套用模板（见 report.json 与模板页）。</div>';
  html += '</div>';

  if (s.letterMarkdown) {
    const secs = splitSections(s.letterMarkdown);
    const ui = mailUiState(s);
    html += '<div class="card">';
    html += '<div class="toolbar">'
      + '<button class="btn primary" id="copy-body">复制正文（手动发送）</button>'
      + '<button class="btn" id="copy-all">复制整篇</button>'
      + (s.letterFile ? `<a class="btn" href="${artUrl(s.letterFile, true)}">下载举报信 .md</a>` : '')
      + '<a class="btn" href="' + artUrl('report.json', true) + '">下载 report.json</a>'
      + `<button class="btn${ui.canSend ? ' danger' : ''}" id="send-mail" ${ui.canSend ? '' : 'disabled'}>${esc(ui.label)}</button>`
      + '</div>'
      + `<div class="${ui.hintClass}" id="send-status">${esc(ui.hint)}</div>`;
    for (const sec of secs) {
      if (!sec.body.trim() && sec.title === '（前言）') continue;
      html += `<div class="sec"><h3>${esc(sec.title)}</h3><div class="preb">${esc(sec.body.trim())}</div></div>`;
    }
    html += '</div>';
  }

  if (images.length) {
    html += '<div class="card"><h3 style="margin-top:0">截图（邮件附件）</h3><div class="shots">';
    for (const a of images) {
      html += '<div class="shot">'
        + `<a href="${artUrl(a.name)}" target="_blank" rel="noopener"><img src="${artUrl(a.name)}" alt="${esc(a.name)}"></a>`
        + `<div class="cap"><span>${esc(a.name)}</span><a href="${artUrl(a.name, true)}">下载</a></div>`
        + '</div>';
    }
    html += '</div></div>';
  }

  if (others.length) {
    html += '<div class="card"><h3 style="margin-top:0">证据文件</h3><div class="files">';
    for (const a of others) {
      html += `<a href="${artUrl(a.name)}" target="_blank" rel="noopener">${esc(a.name)} · ${(a.size / 1024).toFixed(1)}KB</a>`;
    }
    html += '</div></div>';
  }

  box.innerHTML = html;

  if (s.letterMarkdown) {
    const secs = splitSections(s.letterMarkdown);
    const body = (secs.find(x => /^正文/.test(x.title)) || {}).body || s.letterMarkdown;
    const copyBody = $('#copy-body');
    const copyAll = $('#copy-all');
    if (copyBody) copyBody.addEventListener('click', () => copyText(body.trim()));
    if (copyAll) copyAll.addEventListener('click', () => copyText(s.letterMarkdown));
    bindSendButton(box, s);
  }
}

// 自动发送按钮：只绑定一次；点击后二次确认 → POST 发送 → 服务端写 send.json 防重发
function bindSendButton(root, s) {
  const btn = root ? root.querySelector('#send-mail') : $('#send-mail');
  if (!btn || btn.disabled || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => sendReport(s, btn));
}

async function sendReport(s, btn, statusEl) {
  const ui = mailUiState(s);
  const mail = s.mail || {};
  const unknownWarn = mail.state === 'unknown'
    ? '\n\n⚠ 上次发送结果未知，请先确认对方是否收到，再决定是否重发。'
    : '';
  const ok = window.confirm(
    '确认自动发送举报邮件？\n\n'
    + `收件人：${ui.to}\n`
    + `主题：${s.subjectLine || '（见举报信）'}\n`
    + `附件：${ui.attachCount} 个截图${unknownWarn}\n\n`
    + '发送后不可撤回；本报告将被标记为已发送，并禁止重复投递。',
  );
  if (!ok) return;

  const status = statusEl
    || (btn && btn.closest('.card') ? btn.closest('.card').querySelector('#send-status') : $('#send-status'));

  // 进入发送中：结果卡片与取证区按钮同步禁用
  s.mail = { ...mail, state: 'sending' };
  renderSendState(btn, status, mailUiState(s));
  if (isCurrentReport(s)) refreshCurrentResultSendUi(s);

  try {
    const r = await api(`/api/reports/${encodeURIComponent(s.outDirName)}/send`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    s.mail = { ...(s.mail || {}), state: 'sent', sentAt: r.sentAt, messageId: r.messageId };
    renderSendState(btn, status, mailUiState(s));
    if (isCurrentReport(s)) refreshCurrentResultSendUi(s);
    toast('邮件已发送');
  } catch (err) {
    s.mail = { ...(s.mail || {}), state: 'failed', sendError: err.message };
    renderSendState(btn, status, mailUiState(s));
    if (isCurrentReport(s)) refreshCurrentResultSendUi(s);
    toast('发送失败：' + err.message);
  }
}

// ── 历史报告 ───────────────────────────────────────────────────
async function loadHistory() {
  const box = $('#history');
  try {
    const { reports } = await api('/api/reports');
    if (!reports.length) { box.innerHTML = '<p class="muted">还没有报告，去「取证」跑一个。</p>'; return; }
    let html = '<h3 style="margin-top:0">共 ' + reports.length + ' 份报告</h3><div class="rlist">';
    for (const r of reports) {
      html += `<div class="ritem" data-dir="${esc(r.outDirName)}">`
        + `<div class="u">${esc(r.inputUrl || '(无 URL)')}</div>`
        + `<div class="s">${esc(r.generatedAt || '')} · ${esc(r.type || '—')}/${esc(r.template || '?')}`
        + `${r.letterFile ? '<span class="badge">已出信</span>' : '<span class="badge">无信件</span>'}`
        + ` · ${esc(r.outDirName)}</div></div>`;
    }
    html += '</div>';
    box.innerHTML = html;
    $$('.ritem', box).forEach(el => el.addEventListener('click', () => openReport(el.dataset.dir)));
  } catch (err) {
    box.innerHTML = `<p class="err">加载失败：${esc(err.message)}</p>`;
  }
}

async function openReport(dir) {
  const detail = $('#history-detail');
  detail.innerHTML = '<div class="card muted">加载中…</div>';
  try {
    const s = await api('/api/reports/' + encodeURIComponent(dir));
    await loadMailConfig();
    // 复用结果渲染：先清空 result 容器，再渲染到 history-detail
    const box = $('#result');
    const backup = box.innerHTML;
    box.innerHTML = '';
    renderResult(s);
    detail.innerHTML = '<div class="card" style="padding:0;border:none;background:none">'
      + '<button class="btn" id="back-hist">← 返回列表</button></div>' + box.innerHTML;
    box.innerHTML = backup;
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#back-hist').addEventListener('click', () => { detail.innerHTML = ''; });
    // 事件已绑定到 #result 的按钮上，这里重新绑定 detail 内的按钮
    bindDetailButtons(s);
  } catch (err) {
    detail.innerHTML = `<div class="card err">加载失败：${esc(err.message)}</div>`;
  }
}

function bindDetailButtons(s) {
  const detail = $('#history-detail');
  const copyBody = $('#copy-body', detail);
  const copyAll = $('#copy-all', detail);
  if (copyAll && !copyAll.dataset.bound) {
    copyAll.dataset.bound = '1';
    copyAll.addEventListener('click', () => {
      const first = $('.preb', detail);
      const all = $$('.preb', detail).map(p => p.textContent).join('\n\n');
      copyText(all);
    });
  }
  if (copyBody && !copyBody.dataset.bound) {
    copyBody.dataset.bound = '1';
    copyBody.addEventListener('click', () => {
      const secs = $$('.sec', detail);
      const s = secs.find(x => /^正文/.test($('h3', x) ? $('h3', x).textContent : ''));
      if (s && $('.preb', s)) copyText($('.preb', s).textContent);
    });
  }
  bindSendButton(detail, s);
}

// ── 模板 ───────────────────────────────────────────────────────
let currentTemplate = null;

async function loadTemplates() {
  const tabs = $('#template-tabs');
  const body = $('#template-body');
  const actions = $('#template-actions');
  body.textContent = '加载中…';
  try {
    const data = await api('/api/templates');
    const builtin = data.templates || {};
    const custom = data.custom || [];
    // 内置 A/B/C 在前（只读），自定义在后。key 前缀区分两类。
    const list = [
      ...Object.keys(builtin).map(k => ({ key: 'b:' + k, label: '内置 ' + k, content: builtin[k], builtin: true })),
      ...custom.map(t => ({ key: 'c:' + t.id, label: t.name, content: t.content, builtin: false, id: t.id, name: t.name })),
    ];
    if (!list.length) { tabs.innerHTML = ''; actions.innerHTML = ''; body.textContent = '未找到模板。'; return; }

    tabs.innerHTML = list.map((t, i) =>
      `<button class="subtab${i === 0 ? ' active' : ''}" data-key="${esc(t.key)}">${esc(t.label)}</button>`
    ).join('');

    const select = t => {
      currentTemplate = t;
      body.textContent = t.content || '';
      actions.innerHTML = t.builtin
        ? '<span class="muted small">内置模板为固定骨架，只读。</span>'
        : '<button class="btn" id="tpl-copy">复制内容</button>'
          + '<button class="btn danger" id="tpl-del">删除此模板</button>';
      const cp = $('#tpl-copy');
      if (cp) cp.addEventListener('click', () => copyText(t.content));
      const del = $('#tpl-del');
      if (del) del.addEventListener('click', () => deleteTemplate(t));
      $$('.subtab', tabs).forEach(x => x.classList.toggle('active', x.dataset.key === t.key));
    };

    $$('.subtab', tabs).forEach(b => b.addEventListener('click', () => {
      const t = list.find(x => x.key === b.dataset.key);
      if (t) select(t);
    }));
    select(list[0]);
  } catch (err) {
    tabs.innerHTML = ''; actions.innerHTML = '';
    body.textContent = '加载失败：' + err.message;
  }
}

async function addTemplate() {
  const status = $('#tpl-add-status');
  const name = $('#tpl-name').value.trim();
  const content = $('#tpl-content').value;
  if (!name) { status.textContent = '请填模板名称'; return; }
  if (!content.trim()) { status.textContent = '模板内容不能为空'; return; }
  const btn = $('#tpl-add-btn');
  btn.disabled = true; status.textContent = '保存中…';
  try {
    await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, content }) });
    $('#tpl-name').value = ''; $('#tpl-content').value = '';
    status.textContent = '已添加并持久化';
    toast('模板已添加');
    loadTemplates();
  } catch (err) {
    status.textContent = '失败：' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function deleteTemplate(t) {
  if (!window.confirm(`删除自定义模板「${t.name}」？此操作不可撤销。`)) return;
  try {
    await api('/api/templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
    toast('已删除');
    loadTemplates();
  } catch (err) {
    toast('删除失败：' + err.message);
  }
}

$('#tpl-add-btn').addEventListener('click', addTemplate);

// ── 启动 ───────────────────────────────────────────────────────
init();
