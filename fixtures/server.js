// 离线测试服务器（规格书实施计划第 9 步 / 验证方案「离线」一节）。
//
// 零依赖 node:http 服务器，提供四条路由把侦察模块的四种分类全部覆盖：
//   /a        302 → /b        （跳转型：模板 B）
//   /b        200 直出内容     （直出型：模板 A）
//   /shell    200 极小 iframe 壳（iframe 壳：需人工裁决，不自动套模板）
//   /blocked  403             （被挡：换裸 UA 重试，仍失败如实记录）
//   其余路径  404             （业务路径探针落空，不产生 catch-all）
//
// 服务器会把每条请求的 User-Agent / Accept-Encoding 记录下来，供测试断言
// 「一律微信 UA」与「accept-encoding: identity」（实施计划关键决策 #1、#2）。
//
// 页面正文是一份静态资产（PAGES），测试用它反算 MD5 做逐字节断言——这正是
// 规格书第 3 步「算哈希与已知页面比对」的离线等价物。

const http = require('http');

// 直出页（B 页）：含 <title> 与「付费原话」，供侦察取标题、渲染层提付费原话。
const B_PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>名字打分</title>',
  '</head>',
  '<body>',
  '<div id="app">',
  '<p>姓名</p>',
  '<p>性别</p>',
  '<p>生辰</p>',
  '<button>立即分析</button>',
  '<p>本报告需付费后方可查看结果，结果仅供参考！</p>',
  '<p>本次姓名打分为39元付费服务，付费后可查看报告</p>',
  '</div>',
  '</body>',
  '</html>',
].join('\n');

// iframe 壳：必须 < 1024 字节，且含单个 <iframe src>（probe 的壳判定条件）。
const SHELL_PAGE = '<!doctype html><html><head><title>加载中</title></head>'
  + '<body><iframe src="/b" style="width:100%;height:100%"></iframe></body></html>';

const PAGES = { b: B_PAGE, shell: SHELL_PAGE };

/**
 * 启动测试服务器。
 * @returns {Promise<{baseUrl:string, port:number, requests:Array, close:Function}>}
 */
function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    requests.push({
      path: pathname,
      userAgent: req.headers['user-agent'] || null,
      acceptEncoding: req.headers['accept-encoding'] || null,
    });

    // 记录后统一显式 identity 输出，保证 MD5 与指纹库同语义（不透明压缩）
    res.setHeader('content-encoding', 'identity');

    if (pathname === '/a') {
      res.writeHead(302, { location: '/b' });
      res.end('');
      return;
    }
    if (pathname === '/b') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES.b);
      return;
    }
    if (pathname === '/shell') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES.shell);
      return;
    }
    if (pathname === '/blocked') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      // 预热：listen 回调后先完成一次真实往返，避免个别平台「首个连接偶发重置」
      // 造成 probe 误判 blocked。预热请求不进 requests（清空），断言不受污染。
      const warm = http.get(`${baseUrl}/b`, (res) => {
        res.resume();
        res.on('end', () => {
          requests.length = 0;
          resolve({ baseUrl, port, requests, close: () => new Promise(r => server.close(() => r())) });
        });
      });
      warm.on('error', reject);
    });
  });
}

module.exports = { startServer, PAGES, B_PAGE, SHELL_PAGE };
