# Web 界面 + 免费云托管（Render）

本目录既能当命令行用，也能当一个受口令保护的网页用。网页版把整条流水线
（侦察 → DNS → whois → 备案 → 地形/指纹 → 渲染截图 → 生成举报信）包成 HTTP 接口，
进度实时推给浏览器，结果可在线查看 / 复制 / 下载。

> 发送纪律：默认只生成材料；结果页由用户自行选择「复制正文手动发送」或
> 「自动发送邮件」（需先配置 SMTP）。自动发送必须二次确认，成功后写入报告目录
> 的 `send.json`，同一报告禁止重复投递（规格书 5.2）。

---

## 1. 本机跑 Web 界面

```powershell
cd D:\foodback\report-tool
npm install                       # 已装可跳过
$env:APP_PASSWORD = "你的口令"
npm start                         # 默认 http://localhost:10000
```

浏览器打开 `http://localhost:10000`，输入口令登录即可。

- 未设 `APP_PASSWORD` 时，启动日志会打印一个**临时随机口令**（重启会变，仅方便本地调试）。
- 端口用环境变量 `PORT` 改；Windows 本机渲染默认走 Edge。
- 需要 Node.js 20+（nodemailer 10 的安全修复版本要求）。

### 1.1 自动发送邮件（可选）

不配置 SMTP 时，结果页只提供「复制正文（手动发送）」；配置后额外出现「自动发送邮件」按钮。
取证完成后，取证区的操作行也会出现同一个「自动发送邮件」按钮——它发送的就是本次刚完成的报告。
发送前浏览器会二次确认收件人、主题与附件数量，服务端还有一层防重复投递锁。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `SMTP_HOST` | 是 | SMTP 服务器地址 |
| `SMTP_PORT` | 否 | 默认 `465` |
| `SMTP_SECURE` | 否 | 默认 465 端口为 `true`；用 587 STARTTLS 时设为 `false` |
| `SMTP_USER` / `SMTP_PASS` | 视服务商 | 需要认证时填写；只填用户不填口令视为未配置 |
| `MAIL_FROM` | 是 | 发件人；未设置时回退为 `SMTP_USER` |
| `MAIL_TO` | 否 | 默认 `moment@tencent.com` |
| `MAIL_REPLY_TO` | 否 | 回复地址 |
| `MAIL_MAX_ATTACH_MB` | 否 | 附件总大小上限，默认 `20` |

发送行为：

- 正文取举报信里「## 正文」段，取证底档不会进邮件；
- 附件为报告目录里的首屏 / 整页截图，**没有截图拒绝发送**；
- 成功后写 `send.json` 与 `email-body.txt`，该报告按钮变为「已发送」并禁用；
- 失败写 `send-attempt.json`（状态 / 错误），可人工确认后重试；
- 发送锁 `send.lock` 防止并发重复投递，进程异常退出超过 5 分钟自动失效。

```powershell
$env:SMTP_HOST = "smtp.example.com"
$env:SMTP_PORT = "465"
$env:SMTP_USER = "report@example.com"
$env:SMTP_PASS = "你的SMTP授权码"
$env:MAIL_FROM = "report@example.com"
npm start
```

---

## 2. 部署到 Render（免费 Docker）

### 2.1 为什么是 Render
流水线里的**渲染截图需要真浏览器**（Playwright + Chromium）。免费静态平台
（GitHub Pages / Cloudflare Pages / Vercel 静态部分）跑不了浏览器；纯 Serverless
也有体积与超时限制。Render 的**免费 Docker Web 服务**能跑完整容器，因此功能最全。

### 2.2 把代码推到 GitHub

`D:\foodback` 不是 git 仓库，`report-tool` 里还混着 `reports/`（含你的取证记录，**不要**上传）。
最省事的做法是**只把 report-tool 推成一个独立仓库**：

```powershell
cd D:\foodback\report-tool
git init
git add .
git commit -m "wechat violation report tool (web)"
# 在 GitHub 新建一个空仓库，然后：
git branch -M main
git remote add origin https://github.com/<你>/<仓库名>.git
git push -u origin main
```

`.gitignore` 已排除 `node_modules/` 与 `reports/`；`.dockerignore` 同理，且不把测试集打进镜像。

### 2.3 在 Render 建服务

1. 登录 Render → **New → Blueprint**，选中上面的仓库（会读取仓库里的 `render.yaml`）。
2. 首次会提示填 `APP_PASSWORD`（`sync: false` 的环境变量），填你的口令。
3. 点部署。首次构建要下载 Playwright 基镜像（约 1.5 GB），**需要几分钟**，属正常。
4. 构建完成后拿到形如 `https://<名字>.onrender.com` 的地址，打开即用。

也可以不用蓝图，手动 **New → Web Service → Docker**：
- Root Directory：仓库根（有 `Dockerfile` 的那层）
- Health Check Path：`/healthz`
- 环境变量：`APP_PASSWORD`（必填）、`PORT=10000`、`BROWSER_CHANNEL`（留空，用自带 Chromium）

### 2.4 免费版的两个现实限制

| 限制 | 影响 | 对策 |
|---|---|---|
| 闲置 15 分钟休眠 | 休眠后第一次访问冷启动约 30–60 秒 | 等一会儿刷新；或升级付费常驻 |
| 磁盘是临时的 | 重新部署 / 重启后 `reports/` 清空 | 跑完立刻**下载**举报信与截图；或挂 Render Disk（付费）持久化 |
| 内存 512 MB | 单个页面截图通常够用，别并发多个大页面 | 服务端已限制**同一时刻只跑一个任务**（并发会返回 409） |

---

## 3. 接口一览（都需登录 Cookie）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{password}` → 下发会话 Cookie |
| POST | `/api/logout` | 退出 |
| GET | `/api/session` | 是否已登录 |
| GET | `/api/mail` | 邮件发送配置（是否可用 / 收件人，不含口令） |
| GET | `/api/templates` | 返回内置模板 A/B/C 原文与自定义模板列表 |
| POST | `/api/templates` | `{name, content}` → 新增自定义模板（持久化到 `data/templates.json`） |
| DELETE | `/api/templates/:id` | 删除自定义模板 |
| GET | `/api/reports` | 历史报告列表 |
| GET | `/api/reports/:dir` | 单份报告详情（含举报信 markdown、report.json、附件清单、发送状态） |
| GET | `/api/reports/:dir/artifact/:name` | 取附件；加 `?download=1` 触发下载 |
| POST | `/api/reports/:dir/send` | 自动发送举报邮件（需 SMTP；成功后写 `send.json`，重复调用返回 409） |
| POST | `/api/run` | `{url, render, terrain, beianRemote}` → `{jobId}` |
| GET | `/api/job/:id` | 任务状态与结果 |
| GET | `/api/job/:id/events` | 进度 SSE 流 |
| GET | `/healthz` | 健康检查（Render 用） |

---

## 4. 安全须知

- 本工具会**按你给的 URL 去抓取任意站点**（含 whois / 备案查询）。**务必设口令并保持私有**，
  否则等于对外开了一个抓取代理。
- 口令通过 `APP_PASSWORD` 注入，不写进仓库；会话用 HttpOnly + SameSite=Lax Cookie。
- SMTP 口令只从环境变量读取，不落盘、不写进 report.json、不回传前端。
- 自动发送是**不可撤回**操作：发送前会二次确认，成功后同一报告禁止重发。
- 免费平台上建议只做自用；不要公开分享链接。

---

## 5. 命令行仍可用

Web 版是 `cli.js` 的封装，二者共享同一套模块与同一份 `reports/` 目录：

```powershell
node cli.js "<URL>"            # 全流程
node cli.js "<URL>" --no-render
node cli.js letter <report.json>
node cli.js probe "<URL>"
npm test                       # 离线测试集（不联网）
```

> 命令行不发送邮件；自动发送只在 Web 结果页提供（需配置 SMTP）。
