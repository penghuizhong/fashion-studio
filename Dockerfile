# SoulChat 生产镜像
# 构建上下文为版本目录（如 soul-chat-v1.1.1/），内含 server/ 与 client/dist
FROM node:22-slim

# better-sqlite3 原生模块编译兜底（Node 22 一般直接下载预编译包，用不上）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 还原发版包的目录结构：server/ 与 client/ 同级。
# 后端按 src/../../client/dist 定位前端，结构不对会导致前端 404（Cannot GET /）。
WORKDIR /app
COPY server ./server
COPY client/dist ./client/dist

WORKDIR /app/server
RUN npm install --omit=dev

ENV PORT=3001 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
