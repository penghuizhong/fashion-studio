# 部署（fashion-studio）

## 自动部署（GitHub Actions）

push 到 `main` 分支即自动部署：

1. GitHub 仓库 `penghuizhong/fashion-studio` 的 Actions 跑 `deploy.yml`
2. 通过 SSH（Secret `VPS_SSH_KEY`）连腾讯云 VPS（43.130.1.94:28989）
3. 首次自动 `git clone` 到 `/opt/fashion-studio`，之后 `git fetch + reset --hard`
4. server `npm ci --omit=dev`，client `npm ci && npm run build`
5. `systemctl restart fashion-studio`，健康检查 `curl 127.0.0.1:3100/api/config`

## 服务器现状

- 服务：`fashion-studio.service`，`WorkingDirectory=/opt/fashion-studio`，`PORT=3100`，`DATA_DIR=/opt/fashion-studio/data`
- 反代：`work.oihey.cn` → `127.0.0.1:3100`（OpenResty）
- 数据库：`/opt/fashion-studio/data/fashion-studio.db`（单文件，备份见 `docs/BACKUP.md`）

## 手动操作

```bash
# 看日志
journalctl -u fashion-studio -f
# 重启
systemctl restart fashion-studio
# 健康检查
curl -s http://127.0.0.1:3100/api/config
```

## 铁律

- 发版 = push 到 main；**push 前必须用户明确说"推"**
- 先在本地自检（回归 + build）再推
