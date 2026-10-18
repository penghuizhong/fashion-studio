# Fashion Studio

AI 服装设计工作台（桌面端优先）。核心是**设计台**：传一张趋势图 → AI 提取款式 DNA（版型/面料/颜色/细节…）→ 存为款式卡 → 一键生图 / 换色 / 改细节 / 出细节图 / 换场景 / 批量生产。

款式卡是活的：有灵魂（DNA）、有记忆（审美评价）、每次变更可生图验证。

## 技术

- 前端：React + Vite（`client/`）
- 后端：Node.js + Express + better-sqlite3（`server/`）
- 数据：单文件 SQLite（`$DATA_DIR/fashion-studio.db`），图片落 `$DATA_DIR/uploads/studio/`

## 本地运行

```bash
cd server && npm install && npm start   # 默认 :3100
cd client && npm install && npm run dev
```

## 部署

push 到 `main` 即通过 GitHub Actions 自动部署到腾讯云 VPS（`work.oihey.cn`）。详见 `DEPLOY.md`，备份见 `docs/BACKUP.md`。

**铁律：push 前必须用户明确说"推"。**
