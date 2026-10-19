# Fashion Studio 0.4.0 — 创意衍生调用与任务修复

## 行为变化

发散页显式选择文本模型，不再提前依赖图片模型。筛选后进入渲染设置，选择图片模型/尺寸，获取服务端报价后确认。任务异步执行，每张独立反馈，可从历史恢复和重试明确失败项。

`models.id` 确定供应商、协议与价格；不会用另一供应商的 Key 弥补配置错误。平台模式按积分策略计费；个人 BYOK 文本调用使用完整个人地址与 Key，不扣平台积分。图片模型仍使用后台配置的图片供应商和平台积分，暂不提供个人图片 Key 路由。

## 文件与接口

- `exploreModels.js`：可用模型、供应商和平台/BYOK 连接解析；安全可公开模型信息。
- `exploreJobs.js`：服务端报价、单张任务、并发上限、额度预留/释放、幂等、租约恢复及快照。
- `explore.js`：发散校验、结构化锁定、批次/历史/收卡与管理员核对 API。
- `dnaRenderProfiles.js`、`image.js`：西装词汇、图片 URL 规范化、任务延后结算与原图/缩略图写入。
- `db.js`、`dnaPresets.js`、`auth.js`：新增表/列和发散规则编辑，不覆盖既有预设；字段定义增加安全校验。
- `ExploreModal.jsx`、`ExploreRecoveryPanel.jsx`、`api.js`：四步交互、报价、历史恢复、管理员核对和安全错误。
- `studio.js`：多用户图片/缩略图访问控制；单用户本地流程保持可用。
- `check-explore.js`、`client/tests/explore.spec.js`、`validate.yml`：接口/账本专项、真实浏览器路径与 CI。

新接口：

- `GET /api/studio/explore-models`
- `POST /api/studio/explore` 增加 `expand_model_id`、`locked_fields`、`request_key`
- `POST /api/studio/explore/:id/quote`：`indexes`、`render_model_id`、`render_size`，可选 `source_job_id` 重试失败项
- `POST /api/studio/explore/:id/render`：`quote_id`、`request_key`、`confirm:true`、`async:true`
- `GET /api/studio/explore/:id/jobs`
- `POST /api/studio/explore/:id/adopt` 增加可选 `job_id`，确保收取所查看的生成记录
- 管理员 `GET /api/admin/explore-recovery`，以及 `POST /api/admin/explore-{items|expansions|legacy}/:id/resolve`

旧同步渲染请求仍需显式索引；已完成批次的旧请求只复用结果。新的多次渲染使用独立报价与请求键。

## 积分与恢复政策

- 管理统计按实际结算记录消费，额度预留/退款不增加消费或赠送；用户余额和原始账本仍如实记录预留变化。
- 图片按服务端报价预留，保存原图和缩略图后结算。明确失败或保存失败释放预留；保存失败仍可能产生上游成本，由平台承担。
- 发散预留最多两次调用的额度，成功按实际 token 用量结算并退回余额；格式修复计入用量，整个发散失败则退款，上游成本由平台承担。
- 网络超时/进程中断可能已被供应商消费，标记“待确认”，不自动退回后重发。后台“模型管理 → 创意任务费用核对”可核对并填写依据后退款。
- 旧版卡在 rendering 的批次必须人工核对，恢复操作不会推测或自动改写旧账本。
- 租约：图片任务 10 分钟、30 秒心跳；发散最长调用预留 5 分钟。定时检查及历史读取会处理过期任务。未发送图片释放额度，已发送未知项保留核对。
- 图片有限并发通过 SQLite 状态检查，适用于共享此 SQLite 数据库的服务进程；不是跨独立数据库的分布式队列。

## 数据库与升级

新增 `points_ledger.accounting_delta`（统计结算值，旧流水回退原 delta，不改历史余额）、`dna_presets.expand_prompt`、`exploration_batches.snapshot_json/adopted_json`，以及 `explore_expansions/explore_quotes/explore_jobs/explore_items`。迁移幂等，已有管理员识图/字段配置保留。新增代码不删除旧批次和旧表。

部署前备份整个 DATA_DIR（SQLite 应使用一致性备份），停止旧版服务再启动新版本，避免旧进程继续运行无任务记录的渲染请求。保留新表/列，回滚时不要删表或丢弃待核对账目；优先修复后向前升级。必须回滚时停止新任务、处理预留和待确认项，再部署旧版本，必要时使用备份恢复到经过核对的一致时间点。

## 验证

在 Node.js 24.19.0、npm 11.9.0、Linux 和系统 Chromium 环境验证：

```sh
npm --prefix server run check
CHECK_MODE=multi npm --prefix server run check
npm --prefix server run check:explore
npm --prefix client run test:e2e
```

浏览器测试命令包括生产构建；其他机器先运行 `cd client && npx playwright install --with-deps chromium`。可以用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定现有 Chromium。

最终自检结果（2026-10-19）：

| 检查 | 结果 |
| --- | --- |
| 冻结 lockfile 重新安装 | server/client 均通过 |
| 单用户回归 | 62/62 通过 |
| 多用户回归 | 64/64 通过 |
| 创意专项集成（实际适配器路径 + 模拟上游） | 32/32 通过 |
| Chromium 实际 UI 流程 | 3/3 通过 |
| 前端生产构建 | 通过，61 个模块 |
| Git 空白检查、JS 语法、版本与 lockfile 一致性 | 通过 |

多用户旧回归仍打印摘要/记忆后台请求失败或缺少 Key 的警告，测试断言全部完成并通过；这些警告不代表真实 AI 已验证。浏览器验证覆盖模型选择、6 选 2、服务端报价、刷新恢复、收卡、锁定字段、安全错误及历史字段隔离。CI 配置已添加，远端尚未执行。

## 实际边界

自动测试使用隔离数据库、mock 或模拟的供应商 HTTP 响应，不访问生产、不消耗真实供应商额度。自然语言要求通过提示词传递；可机器验证的强约束需使用锁定字段，不能保证模型理解所有自然语言或最终图片视觉效果。真实模型质量、账户价格和供应商账单仍需上线前联调。当前未推送、未合并、未部署，也未在远端实际运行新 CI。
