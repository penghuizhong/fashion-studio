# Fashion Studio

服装从设计到制版、打样和生产的工作台。设计台保存不可变款式版本、生成并核对正背侧三视角；交付后自动进入关联样衣项目。

- **设计台**：创意和款式衍生、版本、三视角采用及交付；模型费用明确确认，图片完整预览与原图下载。
- **样衣台**：款式资料 / 用料核价 / 打样生产，集中维护工艺尺寸、纸样、面辅料、SKU、实物样衣问题及生产批次。
- **制版台**：查资料 / 查尺寸 / 算尺寸，公共标准发布与应用、私有人体实测、标准人体号型、成衣尺寸、放码规则和确定计算工具。

三台通过同款项目引用资料，历史交付和生产基线保持原样。真实生产标准由版师维护并核对，系统不从 AI 图片推断实测数据。0.11.0 功能、迁移和限制见 [发布说明](docs/RELEASE_NOTES_0.11.0.md)。

## 技术

- 前端：React + Vite（`client/`）
- 后端：Node.js + Express + better-sqlite3（`server/`）
- 数据：单文件 SQLite（`$DATA_DIR/fashion-studio.db`），图片落 `$DATA_DIR/uploads/studio/`，纸样等附件落 `$DATA_DIR/uploads/product-files/`

## 本地运行

```bash
cd server && npm install && npm start   # 默认 :3100
cd client && npm install && npm run dev
```

## 部署

push 到 `main` 即通过 GitHub Actions 自动部署到腾讯云 VPS（`work.oihey.cn`）。详见 `DEPLOY.md`，备份见 `docs/BACKUP.md`。

**铁律：push 前必须用户明确说"推"。**
