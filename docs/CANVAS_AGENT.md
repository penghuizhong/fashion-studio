# 万能画板 Pi Agent

本地功能分支：`feat/canvas-pi-agent`。基线 main：`52506a0a5f46f48af489eb30301ef9a5bc2ef5ab`。

## 启用和使用

1. Node >=22.19.0（开发验证 Node 24），执行 `npm ci --prefix server`、`npm ci --prefix client`。
2. `server/.env` 设置 `AGENT_ENABLED=true`，重启服务；默认 false。
3. 模型管理中，为实际兼容 **OpenAI Chat Completions 原生 tools + vision** 的聊天模型勾选「视觉识图」「原生工具调用」。复用现有供应商、模型、价格、BYOK 和鉴权。勾选是管理员能力声明，并不代表供应商已经通过真实验收。不兼容的供应商会失败，不降级成提示词假工具调用。
4. 画板放入模特图和服装图，多选后指定角色，切换「多步 Agent」。输入换装/三视角要求，选择图片模型、尺寸、质量和图片总上限。
5. 查看并确认规划费用上限。Agent 使用实际图片、发现/加载技能并给出步骤计划；此阶段禁止图片派发。
6. 检查计划，再查看并确认后续费用；结果由旧生图任务逐张生成、保存并确定性落位。Agent 可读取实际产物像素继续分析，并仅排列本任务产物。
7. 缺图追问时，补充当前需求和实际附件，报价确认后续跑同一任务；旧历史原图像素不自动沿用。图片数量不足会保留待执行调用，用户可增加总上限（最高4）后确认继续。
8. 成功后可保存 Agent 工作流。保存技能快照、输入槽位、工具参数及数据依赖；选用后重新绑定输入图，沿用已保存技能快照（当前禁用规则仍生效），重新规划和确认。更换过外部参考导致无法建立完整槽位的历史任务，会拒绝保存工作流。它是 **Agent 引导工作流**，不承诺不同模型决策确定性；旧版单步确定性工作流仍独立保留。

## 架构与状态

`agent/jobs.js` 编排队列独立于 `canvasJobs.js` 图片队列：全局1个 Agent 编排、2个图片任务，不会占用图片槽位等待图片子任务。普通单步请求在 Agent 正执行期间被拒绝；暂停且预留已释放的任务可稍后继续。

- `canvas_agent_quotes`：首次与续跑的冻结报价；确认时复核所有权、文件指纹、模型配置、凭据摘要、价格和报价期限。
- `canvas_agent_runs`：完整 Pi transcript（包含本轮视觉附件）、预算、累计分析结算、停止标志及租约。
- `canvas_agent_steps`：每次模型请求和工具意图；工具 ID 在 assistant checkpoint 时持久化，派发前写状态。
- `canvas_agent_events`：有序事件，支持游标读取；项目 SSE 提供当前状态，轮询兜底。
- `canvas_agent_workflows`：仅当前用户可见的技能/输入槽位/工具依赖图。
- 首次生图不能遗漏用户本轮任何原始参考图；后续视角可显式选择成功产物与原图作为实际附件。

图片任务继续使用 `canvas_runs`、原账务、供应商适配、图片资产及 delivered 确认。

状态：`queued → running → needs_confirmation / needs_input / succeeded / failed / cancelled / uncertain`。规划及图片额度确认均在服务端事务中预留；UI 不能通过切换模式扩大额度。

模型请求硬上限16轮、工具执行上限24次、输入原图最多4张、图片产物总上限4张；每轮输出最多1600 tokens，文字 UTF8 字节加低精度图片额度控制上下文上限。最多4个并行声明的工具调用，但逐个串行执行。供应商响应上限2MB，SSE帧、文字和工具参数均另有限制。无自动网络重试。

模型适配是实际 Pi `Agent` + 自定义 `streamFn`，发送原生 `tools/tool_calls/tool_call_id`；解析 SSE 的文本及函数参数分片，也接收供应商返回的完整 JSON。工具结果中的图片作为真实图像附件进入下一轮，不只发送图片 URL 文本。

## 费用与恢复

首次规划预留最多4轮的保守费用上限，按实际 token 结算；未报告有效 usage 时使用单轮已确认上限。执行确认按剩余最多轮次及剩余图片数报价。报价是上限，可能明显高于实际。BYOK 沿用原计量方式，积分为0不等于第三方供应商免费；token、轮次和图片数仍受限制。

每轮模型完成即事务结算。图片额度在父任务和旧子任务之间事务转移，随后由原图片任务结算；不会双重预留。父任务展示的 settled 是分析费用，图片费用在对应子任务中。

- 未派发：可恢复并执行。
- 已有图片子任务：接回原子任务，绝不创建第二个收费任务。
- 已有工具输出：重建缺失的 toolResult，继续 Pi transcript。
- 已派发模型但没有确定响应：`uncertain`，仅保留该轮预算；不自动重发。
- 已结算模型但尚未 checkpoint 响应：停止并释放剩余额度，不自动重问模型。
- 图片未知：由旧图片任务保留其额度，父任务释放其他额度并等待核对。
- 停止：取消未派发的后续动作；已发请求仍保存和结算。未知任务需先核对图片子任务，再核对父任务。管理员界面提供「核对后退款」「确认消耗」，必须记录账单依据。

排版仅对本任务产物发出受控命令；稳定命令 ID 和 shape meta 防重复应用。保存遵循现有串行 CAS；服务端验证持久快照后才确认交付。用户删除已交付图片，不会在刷新或恢复时重新插入。

`AGENT_ENABLED=false` 后不认领新的 Agent 队列任务，旧单步功能仍可用，已有Agent记录仍可查看和停止。租约过期后会进行安全恢复判定，停止的未派发任务释放预留，不自动认领执行。临时个人 Key 仅在内存：重启后需重新提交配置；不会在数据库保存 Key。正在执行的任务可能在本次进程内继续完成，因此回退前应先停止任务并核对所有运行中/uncertain 记录。

## Skills

固定目录 `server/src/agent/skills/<name>/SKILL.md`，YAML frontmatter：name 与目录同名，1–64个小写字母/数字/连字符；description 非空且最多1024字符。支持 license、compatibility、字符串 metadata。拒绝重复字段、非法 YAML、路径逃逸、符号链接逃逸和超过32KB的文件。可用 `AGENT_DISABLED_SKILLS` 禁用内置技能；新报价会冻结启停状态、正文和 SHA256。

内置6个技能：garment-analysis、virtual-tryon、multi-view、design-consistency、fashion-layout、product-photo。当前仅加载内置 SKILL.md，不开放第三方上传、脚本执行或任意 references 路径读取。Skill 是参考内容；工具能力由服务端白名单和参数校验决定，不能通过 SKILL.md 扩权。

工具：list_skills、load_skill、get_canvas_selection、inspect_images、propose_plan、generate_image、arrange_images、request_clarification。识图通过 Pi 主模型读取实际像素，消耗模型调用预算；没有另外冒充免费的分析 API。抠图、遮罩编辑、视频等未实现能力不开放。

多视角背部没有参考时必须标明推测；一致性检查输出模型观察，不能视为真实服装隐藏结构或像素级身份一致的保证。首版不自动返工。

## 验证与发布

```sh
npm --prefix server run check:agent
npm --prefix server run check:canvas
npm --prefix client run build
cd client
npm exec -- playwright test
```

`check:agent` 使用真实 npm Pi 内核及可控原生协议上游；不是替换 Agent 的模拟实现。真实付费供应商验收须单独完成：原图换装保真、同一人物正背侧、附件顺序、SSE工具调用兼容、usage和账单、停止/超时核对。自动化测试不证明真实模型输出质量。

发布前按现有 DEPLOY.md 备份实际 DATA_DIR 中的数据库和图片，包含 WAL；迁移为新增表，不删除旧表。关闭开关可退回单步模式，保留所有新任务表以便核账，不直接删除或清空 pending/uncertain 数据。当前未推送、未部署。

依赖精确锁定 `@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`、`typebox@1.3.27`、`yaml@2.8.2`。Pi 使用 MIT，保留上游版权及许可证（副本见 `docs/licenses/PI-MIT.txt`）；其许可不替代 tldraw 自身许可。官方来源：https://github.com/earendil-works/pi/tree/main/packages/agent 。
