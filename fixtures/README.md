# fixtures · 离线测试集

实施计划第 9 步的产物。零依赖（只用 Node 自带 `node:http` / `node:assert`），
不联网、不启动 Playwright，可在任何机器上重复运行。

## 运行

```bash
npm test
# 或
node fixtures/run.js
```

退出码 0 = 全部通过，1 = 有失败（失败堆栈会打印）。

## 测试服务器路由

`fixtures/server.js` 用随机端口起一个本地 HTTP 服务，把侦察模块的四种分类全覆盖：

| 路由 | 响应 | 期望分类 | 期望模板 |
|---|---|---|---|
| `/a` | `302 → /b` | `redirect` | `B` |
| `/b` | `200` 直出内容 | `direct` | `A` |
| `/shell` | `200` 极小 iframe 壳 | `iframe-shell` | 无（需人工裁决） |
| `/blocked` | `403` | `blocked` | 无 |
| 其余 | `404` | —— | —— |

服务器会记录每条请求的 `User-Agent` / `Accept-Encoding`，用于断言
「一律微信 UA」与「显式 `identity`」两条纪律。

## 覆盖的断言

1. 注册域提取、Location 归一化、脱敏（`stripQuery` / `redactUrl`）
2. 四种 fixture 分类与模板选择
3. 落地页 MD5 逐字节断言（`identity` 语义，与指纹库可比）
4. 付费原话提取
5. 模板骨架回归（固定句逐字在位，三套模板）
6. 脱敏拦截（正文出现参数名即报错）
7. terrain 关联按 7.4 强度排序
8. 备案本地自述扫描
9. 信件组装端到端（模板 B：骨架 / 槽位 / 主题行 / 底档 DNS 行）

> 渲染取证（Playwright）按计划第 6 步在普通终端人工执行，不纳入本离线集。
