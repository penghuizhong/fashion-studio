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
