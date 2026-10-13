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

async function init() {
  try {
    const s = await api('/api/session');
    if (s.authed) { showApp(); loadHistory(); } else showLogin();
  } catch { showLogin(); }
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    showApp(); loadHistory();
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
        renderResult(job.result);
        setRunState('done');
        loadHistory();
      } else if (job.status === 'cancelled') {
        $('#run-status').textContent = '已取消取证';
        setRunState('idle');
      } else {
        $('#run-status').textContent = '失败：' + (job.error || '未知错误');
        renderResult(job.result || { error: job.error });
        setRunState('idle');
      }
    } catch (err) {
      $('#run-status').textContent = '读取结果失败：' + err.message;
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

// 表单回车 = 开始取证（仅 idle 时）
$('#run-form').addEventListener('submit', e => {
  e.preventDefault();
  if (runState === 'idle') startRun();
});

// 改动 URL 时，若处「完成」态则回到「开始取证」
$('#url').addEventListener('input', () => { if (runState === 'done') setRunState('idle'); });

setRunState('idle');

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
    html += '<div class="card">';
    html += '<div class="toolbar">'
      + '<button class="btn primary" id="copy-body">复制正文</button>'
      + '<button class="btn" id="copy-all">复制整篇</button>'
      + (s.letterFile ? `<a class="btn" href="${artUrl(s.letterFile, true)}">下载举报信 .md</a>` : '')
      + '<a class="btn" href="' + artUrl('report.json', true) + '">下载 report.json</a>'
      + '</div>';
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
    bindDetailButtons();
  } catch (err) {
    detail.innerHTML = `<div class="card err">加载失败：${esc(err.message)}</div>`;
  }
}

function bindDetailButtons() {
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
}

// ── 模板 ───────────────────────────────────────────────────────
let templatesCache = null;
async function loadTemplates() {
  const tabs = $('#template-tabs');
  const body = $('#template-body');
  try {
    if (!templatesCache) templatesCache = (await api('/api/templates')).templates || {};
    const keys = Object.keys(templatesCache);
    if (!keys.length) { body.textContent = '未找到模板文件。'; return; }
    tabs.innerHTML = keys.map((k, i) => `<button class="subtab${i === 0 ? ' active' : ''}" data-k="${esc(k)}">模板 ${esc(k)}</button>`).join('');
    const show = k => { body.textContent = templatesCache[k] || ''; };
    $$('.subtab', tabs).forEach(b => b.addEventListener('click', () => {
      $$('.subtab', tabs).forEach(x => x.classList.toggle('active', x === b));
      show(b.dataset.k);
    }));
    show(keys[0]);
  } catch (err) {
    body.textContent = '加载失败：' + err.message;
  }
}

// ── 启动 ───────────────────────────────────────────────────────
init();
