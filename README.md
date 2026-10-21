# Fashion Studio

服装从设计到制版、打样和生产的工作台。设计台保存不可变款式版本、生成并核对正背侧三视角；交付后自动进入关联样衣项目。

- **设计台**：创意和款式衍生、版本、三视角采用及交付；模型费用明确确认，图片完整预览与原图下载。
- **样衣台**：款式资料 / 用料核价 / 打样生产，集中维护工艺尺寸、纸样、面辅料、SKU、实物样衣问题及生产批次。
- **制版台**：查资料 / 查尺寸 / 算尺寸，公共标准发布与应用、私有人体实测、标准人体号型、成衣尺寸、放码规则和确定计算工具。

三台通过同款项目引用资料，历史交付和生产基线保持原样。真实生产标准由版师维护并核对，系统不从 AI 图片推断实测数据。0.11.0 功能、迁移和限制见 [发布说明](docs/RELEASE_NOTES_0.11.0.md)。

界面支持深浅主题；黑色主题保留纯黑页面与画布，用近黑面板和细边框区分层级。UI 配色统一维护于 `client/src/theme.css`，详见 [0.11.1 主题说明](docs/RELEASE_NOTES_0.11.1.md)。

0.11.2 修复模型管理删除与同名重建：下架可恢复，删除后移出列表并释放同供应商模型 ID，历史记录保留。旧版遗留停用记录可再次删除，详见 [修复与验收清单](docs/MODEL_MANAGEMENT_FIX_TODO.md)。

0.12.0 将款式衍生整合为“款式属性 → 需求分析 → 方案预览 → 生成中 → 完成”。支持19类详情模块、整体设计规范与逐图提示词，最多规划64张；分析和生图分别确认费用，结果直接关联不可变设计版本。实施、升级与验收边界见 [0.12.0说明](docs/RELEASE_NOTES_0.12.0.md) 和 [执行清单](docs/STYLE_DERIVATION_WIZARD_TODO.md)。

0.16.0 优化五步生图提示词链路：属性自然语言化、模块专用模板、参考角色识别、整体规范注入与手稿同步，实施和验证见 [TODO 清单](docs/STYLE_PROMPT_PIPELINE_TODO.md)。

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
