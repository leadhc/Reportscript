# 微信违规链接举报工具 —— Web 版镜像
#
# 基镜像用 Playwright 官方镜像：已内置 Chromium 与全部系统依赖，
# 省去在容器里 apt 安装浏览器依赖的麻烦。tag 必须与 package.json 的 playwright 版本一致。
#
# 若该 tag 不存在，可换成同版本其它基础镜像（如 -noble）或 v1.64.0。
FROM mcr.microsoft.com/playwright:v1.64.0-jammy

# 镜像里已带浏览器，禁止 npm 再下载一遍
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    PORT=10000

WORKDIR /app

# 仅安装依赖（本项目除 playwright 外零依赖）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码（.dockerignore 已排除 node_modules / reports）
COPY . .

EXPOSE 10000

# 默认只取证与出信；自动发送需配置 SMTP 环境变量（可选）
CMD ["node", "server.js"]
