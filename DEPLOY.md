## Docker Compose 部署（推荐）

发版包内已带 `Dockerfile`、`docker-compose.yml`、`.dockerignore`。

```bash
# 0. 安装 Docker（Ubuntu）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 重新登录后生效；或全程用 sudo

# 1. 准备部署目录
mkdir -p /opt/soulchat-app/data && cd /opt/soulchat
unzip -q ~/soul-chat-vX.Y.Z.zip          # 解压出 soul-chat-vX.Y.Z/
cp soul-chat-vX.Y.Z/docker-compose.yml . # 模板复制出来
# 把模板里的 build: ./soul-chat-v1.1.0 改成实际版本号
nano .env                                 # 填 MASTER_KEY / MULTI_USER=true / BEHIND_HTTPS=true …

# 2. 构建并启动
docker compose up -d --build
docker compose ps                          # soulchat 应为 healthy
curl -s http://127.0.0.1:3001/api/health  # 应返回 ok

# 3. 反向代理（1Panel OpenResty / Caddy / Nginx）照旧指向 http://127.0.0.1:3001，
#    并确保透传 X-Forwarded-Proto；SSE 需要代理关闭缓冲（见 1Panel 手册）。
```

- 更新版本：解压新包 → 改 `docker-compose.yml` 里的 `build:` 和 `image:` 版本号 →
  `docker compose up -d --build`（旧容器自动替换，`./data` 里的数据不受影响）
- 回滚：把版本号改回去再 `up -d --build` 一次
- 日志：`docker compose logs -f soulchat`
- 备份：直接拷 `./data/soulchat.db`
- 从 PM2 迁移：先 `pm2 stop soulchat`，把原来的数据目录内容拷到 `./data`，
  再 `docker compose up -d --build`（反向代理目标不变，无需改动）

## PM2 部署（备选）

> 本指南面向"公开给陌生人用"场景（v1.0.0+ 多用户模式）。
> 本地自己用不需要看这个：解压 zip → `npm install` → `npm start` 即可。

## 1. 服务器准备

- 一台有公网 IP 的 VPS（SQLite 需要持久化文件系统，不适合 Vercel / Cloudflare Workers 等 Serverless）
- 系统：Ubuntu 22.04+（其他 Linux 大同小异）
- Node.js 20+（推荐用 nvm 安装）
- 一个域名，DNS 已指向服务器 IP

## 2. 部署步骤

```bash
# 1) 传包并解压（以 v1.0.0 为例）
unzip soul-chat-v1.0.0.zip && cd soul-chat-v1.0.0

# 2) 安装依赖（server 和 client 都要）
cd server && npm install --omit=dev && cd ../client && npm install && npm run build && cd ..

# 3) 配置环境变量
cp server/.env.example server/.env
# 编辑 server/.env，重点填写：
#   MULTI_USER=true
BEHIND_HTTPS=true
#   MASTER_KEY=<openssl rand -hex 32 生成，64 位 hex，严格保密>
#   SESSION_SECRET 已废弃（v1.7.1+ 不再需要）
#   PORT=3001
#   OPENROUTER_API_KEY 留空（用户各自 BYOK；填了则作为无 key 用户的 fallback）
#   如服务器在国内需代理访问 OpenRouter：HTTPS_PROXY=http://127.0.0.1:7890
#   DASHSCOPE_API_KEY=<阿里百炼 API Key>（语音功能：TTS/ASR/音色克隆/批量克隆都走它；不填则语音不可用）
#   如用第三方 DashScope 中转地址：DASHSCOPE_BASE_URL=https://xxx

# 4) 用 PM2 托管
npm i -g pm2
pm2 start server/src/index.js --name soulchat
pm2 save && pm2 startup   # 按提示执行，开机自启
```

## 3. Caddy 反向代理 + 自动 HTTPS

```bash
# 安装 Caddy（Ubuntu）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

`/etc/caddy/Caddyfile`：

```
your-domain.com {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy   # Caddy 自动申请 Let's Encrypt 证书
```

Cloudflare 用户建议：DNS 先用"灰云"（仅 DNS）验证 HTTPS 正常，再按需开橙云。
开橙云后注意：Cloudflare 代理 + Caddy 的 443 端口都正常即可；`trust proxy` 已在应用内开启。

## 4. 安全检查清单

- [ ] `MULTI_USER=true`、`BEHIND_HTTPS=true` 已开（`/api/config` 返回 `multi_user: true`）
- [ ] `MASTER_KEY` 为随机值且未提交到任何仓库（SESSION_SECRET 已废弃）
- [ ] 全站 HTTPS 可访问（http 自动跳 https）
- [ ] 注册一个账号，确认 A 用户看不到 B 用户的数据
- [ ] `server/data/` 定期备份（sqlite 文件直接拷贝即可，建议每天一次）
- [ ] 服务器防火墙只开放 80/443（Caddy 所在机器）

## 5. 日常运维

```bash
sudo systemctl status soulchat    # 看运行状态
sudo journalctl -u soulchat -f    # 看实时日志
sudo systemctl restart soulchat   # 重启（改 .env 后必须重启生效）
cp server/data/soulchat.db ~/backup/soulchat-$(date +%F).db   # 备份
```

> 生产环境用 systemd 托管（`/etc/systemd/system/soulchat.service`），PM2 已废弃。

升级：解压新版 zip → 复制旧 `server/.env` 和 `server/data/` 过去 → 重装依赖 → `pm2 restart`。
数据库迁移是自动的（ALTER TABLE ADD COLUMN），老数据不受影响。
