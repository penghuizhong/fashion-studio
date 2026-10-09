markdown
# SoulChat 部署指南（systemd 直接部署）

v1.23.0 起废弃 Docker，改用 systemd 直接跑 Node。单实例 + SQLite，不需要容器。

## 1. 服务器准备

- Ubuntu/Debian，Node 22+（`node --version` 确认）
- 目录规划：
  - 代码：`/opt/soulchat-app`（git clone）
  - 数据：`/opt/soulchat-app/data`（SQLite，gitignore，升级不丢）

## 2. 首次部署

```bash
git clone https://github.com/penghuizhong/soulchat.git /opt/soulchat-app
cd /opt/soulchat-app
cd server && npm ci --omit=dev && cd ..
cd client && npm ci && npm run build && cd ..
chmod 600 server/.env
mkdir -p /opt/soulchat-app/data
server/.env 关键项：
env
MULTI_USER=true
MASTER_KEY=<openssl rand -hex 32 生成，64 位 hex，严格保密>
PORT=3001
DATA_DIR=/opt/soulchat-app/data
3. systemd 服务
/etc/systemd/system/soulchat.service：
ini
[Unit]
Description=SoulChat AI chat server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/soulchat-app
ExecStart=/usr/bin/node ./server/src/index.js
Environment=PORT=3001
Environment=DATA_DIR=/opt/soulchat-app/data
Environment=NODE_ENV=production
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
bash
systemctl daemon-reload
systemctl enable --now soulchat
curl -s http://127.0.0.1:3001/api/config
4. 反向代理（1Panel + OpenResty）
反代目标：http://127.0.0.1:3001
必须加：proxy_buffering off;（否则 SSE 被缓冲）
HTTPS 走 1Panel 申请 Let's Encrypt
5. 日常运维
bash
systemctl restart soulchat
systemctl status soulchat
journalctl -u soulchat -f
6. 更新版本
CI push 到 main 后自动：拉代码 → 装依赖 → 构建 → systemctl restart soulchat。
7. 注意事项
不要用 PM2：v7 fork 包装器与 server/src/index.js 的 process.argv[1] 自检冲突，进程假活
备份：定期拷走 /opt/soulchat-app/data 整个目录
