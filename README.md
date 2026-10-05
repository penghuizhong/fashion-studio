# SoulChat MVP

苹果设计风格的 AI 聊天网站（MVP）。每个角色拥有独立的 `soul.md` / `user.md` / `memory.md`，
三层记忆机制保证聊得久也不幻觉、上下文永远不爆。

## 先准备两样东西

1. **Node.js 20 或更高**：去 https://nodejs.org 下载 LTS 版一路"下一步"安装。
   装完打开终端（Windows 用 PowerShell，Mac 用"终端"），输入 `node --version`，
   能显示版本号就装好了。
2. **OpenRouter API Key**：去 https://openrouter.ai 注册登录，
   进 https://openrouter.ai/keys 点 "Create Key"，复制那串 `sk-or-…`。
   建议充一点点额度（deepseek 模型很便宜，几块钱能聊很久）。

## 本地运行

```bash
# 1. 解压 soul-chat-v0.2.1.zip，进目录
cd soul-chat-v0.2.1

# 2. 配置 key（只需做一次）
cd server
cp .env.example .env
# 用记事本/文本编辑器打开 .env，把 OPENROUTER_API_KEY= 后面填上你的 key，保存

# 3. 安装依赖并启动后端（安装只需做一次）
npm install
npm start
# 看到 "SoulChat server listening on :3001" 就是成功了
```

前端已预构建在 `client/dist`，后端会自动托管。
**日常使用只需要** `cd server && npm start`，
然后浏览器打开 **http://localhost:3001**。

> macOS/Linux 本机编译 better-sqlite3 需要 python3/make/g++（Mac 装 Xcode 命令行工具即可）；
> Windows 需要装 Visual Studio Build Tools。实在编不过就告诉我。

## 玩法

1. 点左侧 **+ 新建角色**，起个名字、选个头像 emoji。
2. 点角色进聊天，直接开聊。
3. 点角色旁的 **⚙** 进设置，可编辑 soul.md（人设）、user.md（关于你）、
   memory.md（记忆），每个文件都有历史版本可回滚。
4. 每聊 5 轮，AI 自动把关键事实整理进 user.md / memory.md，
   右下角飘过"已记住 ✨"就是存好了。
5. 顶部细进度条是上下文用量，超 80% 变橙色——不用管，系统会自动压缩旧对话。

## 玩法

- 左侧按角色归类对话；每个角色可建多个对话
- 👥 群聊：侧边栏「新建群聊」选 2~8 个角色；用户发言后由导演决定谁回应（最多 3 位，
  通常 1~2 位，自动轮换），串行流式输出，后发言的角色能看到先发言者的回复；
  `@名字` 可点名某人必回
- 每个角色独立记忆：群内共同事件各按自己视角记入 memory.md
- token 统计：输入框下方显示本轮 / 累计消耗（估算值）；群聊一轮消耗约为单聊数倍，
  可通过 `CONTEXT_BUDGET` 调小上下文预算控制

## 功能（MVP）

- 左侧毛玻璃导航栏：新建角色 / 每个角色下可折叠的对话列表 / 新建对话
- 聊天：SSE 流式输出、打字机光标、消息悬停时间戳、顶部上下文用量进度条
- 每角色三文件可编辑：文本编辑 + 保存 + 历史版本查看/回滚
- 记忆系统：
  - 上下文 = 防幻觉指令 + soul.md + user.md + memory.md + 对话章节摘要 + 最近 20 轮原文，
    token 预算默认 8000，超了自动裁剪最早原文（摘要保留）
  - 旧对话每攒 20 条自动生成章节摘要
  - 每 5 条 assistant 回复自动触发记忆提取：新事实写入 user.md / memory.md
    （带日期、去重、删旧条目），前端飘「已记住 ✨」
  - 防幻觉系统指令：只依据记忆与对话事实回答，不确定的就问，绝不编造
- 纯黑 / 纯白双主题，侧边栏底部一键切换；单个角色可在设置里覆盖 temperature

## 目录结构

```
soul-chat-vX.Y.Z/
├── README.md
├── CHANGELOG.md
├── server/                 # 后端 Node 20 + Express + better-sqlite3
│   ├── src/
│   │   ├── index.js        # 入口（读 .env、托管前端）
│   │   ├── app.js          # 全部 API 路由（含 SSE 聊天流）
│   │   ├── config.js       # 环境变量
│   │   ├── db.js           # SQLite（characters/conversations/messages/file_versions/conversation_summaries）
│   │   ├── llm.js          # OpenRouter 调用 + MOCK_LLM 假流
│   │   └── memory.js       # token 估算 / 上下文组装 / 摘要 / 记忆提取 / 默认模板
│   ├── scripts/check.js    # 后端接口检查（16 项，MOCK 模式）
│   ├── package.json
│   └── .env.example
└── client/                 # 前端 React 18 + Vite 5（手写 CSS，无 UI 库）
    ├── src/
    │   ├── App.jsx
    │   ├── api.js          # API 封装 + SSE 解析
    │   ├── styles.css
    │   └── components/     # Sidebar / ChatView / SettingsView
    ├── dist/               # 已构建好的前端（后端直接托管）
    └── package.json
```

## 环境变量（server/.env）

| 变量 | 说明 | 默认值 |
|---|---|---|
| OPENROUTER_API_KEY | OpenRouter Key（真机必填） | 空 |
| OPENROUTER_BASE_URL | 接口地址，一般不用改 | https://openrouter.ai/api/v1 |
| CHAT_MODEL | 聊天模型（OpenRouter 模型名） | deepseek/deepseek-chat |
| EXTRACT_MODEL | 记忆提取/摘要模型（可用更便宜的） | deepseek/deepseek-chat |
| CONTEXT_BUDGET | 单次请求上下文 token 预算 | 8000 |
| EXTRACT_EVERY_N | 每 N 条 assistant 消息触发记忆提取 | 5 |
| PORT | 后端端口 | 3001 |
| MOCK_LLM | true=假数据流测试，不需要 key | false |
| DATA_DIR | 数据库目录 | ./data |

## 测试

```bash
cd server
MOCK_LLM=true npm run check
# 通过 16/16
```

检查覆盖：建角色（含默认 soul 模板）→ 三文件读写+版本历史+版本回滚 →
对话 CRUD → SSE 发消息（context/token/done 事件）→ 5 轮触发记忆提取
（memory_updated + 文件更新）→ token 估算单测 → 摘要逻辑单测 →
改标题/级联删除 → 不存在的对话发消息。

前端：`cd client && npm run build` 一次通过。

## 常见问题

- **没配 key 能打开吗？** 能。页面照常打开，左下角显示"○ 未配置 key"；
  发消息会提示去侧边栏底部「API 设置」填写。配好 key 重启后端即可。
- **Key 有几种配法？** 两种，优先级：① 侧边栏底部「API 设置」里填的**个人配置**
 （只存你自己浏览器 localStorage）> ② 服务器 `.env` 里的 `OPENROUTER_API_KEY`
 （所有人共用）。自己用填 `.env` 最省事；给多人用建议走 BYOK（见下）。
- **想先不花钱试试？** `.env` 里写 `MOCK_LLM=true` 后重启，
  发消息会收到固定假回复，记忆提取/版本历史全流程照样能跑。
- **数据存在哪？** `server/data/soulchat.db` 一个文件，备份拷走它就行。
- **换电脑？** 拷走整个 `soul-chat` 目录（含 data）即可。
- **报错 `LLM 请求失败 HTTP 403: This model is not available in your region`？**
  你在大陆，Node 的请求没走你的 VPN/代理（Node 的 fetch 默认不读系统代理设置），
  OpenRouter 按 IP 区域把模型拦了。两种解法：
  1. 把 VPN 切到 **TUN 模式**（系统级，所有进程流量都走 VPN），重启后端再试；
  2. 让后端走你的代理工具：在 `.env` 里加一行
     `HTTPS_PROXY=http://127.0.0.1:7890`（端口换成你的代理工具的 HTTP 端口，
     Clash Verge 默认 7890），重启后端。看到启动日志里打印
     `[llm] 已启用 HTTP 代理` 就说明生效了。
- **`npm install` 提示 better-sqlite3 的 install-scripts 未批准？**
  npm 新版安全策略：依赖包的安装脚本默认不自动执行，而 better-sqlite3 的
  原生模块靠这个脚本下载/编译。不处理的话 `npm start` 会报找不到 bindings。
  在 `server` 目录执行（**一劳永逸**：批准是按包名记在你本机 npm 配置里的，
  这台电脑做一次，以后所有版本都不用再管）：
  ```
  npm install-scripts approve better-sqlite3
  npm rebuild better-sqlite3
  ```
  验证：`node -e "require('better-sqlite3'); console.log('ok')"` 打印 `ok` 即可。
  另注意：better-sqlite3 v11 只给 Node 18/20/22 提供预编译包，推荐用 **Node 22 LTS**；
  Node 24 会回退到源码编译（需装编译工具），不推荐。

## 部署到公网给陌生人用（v1.0.0 多用户模式）

v1.0.0 新增多用户模式：注册/登录、数据按用户隔离、Key 后端加密托管。
完整步骤见 **[DEPLOY.md](./DEPLOY.md)**（Caddy + PM2 + 自动 HTTPS）。

`.env` 关键配置：

```env
MULTI_USER=true
MASTER_KEY=<openssl rand -hex 32 生成，64 位 hex，严格保密>
# SESSION_SECRET 已废弃（v1.7.1+ 不再需要）
# OPENROUTER_API_KEY 留空（用户各自 BYOK；填了则作为没配 key 用户的 fallback）
```

用户在网页上注册登录后，去侧边栏底部 🔌 **API 设置**填写自己的 Key，
Key 经 AES-256-GCM 加密存在服务器，浏览器只持会话 cookie（HttpOnly），
localStorage 不再存 key 明文。

## 单用户本地使用（BYOK，自带 Key）

不设 `MULTI_USER` 即为单用户模式（默认），行为与 v0.x 一致：

1. 每个人打开网页 → 点侧边栏底部的 🔌 **API 设置** → 填写：
   - **API 地址**：默认 `https://openrouter.ai/api/v1`，兼容 OpenAI 格式的接口都可填；
   - **API Key**：`sk-or-v1-…`，在 openrouter.ai 的 Keys 页面创建；
   - **模型**：点「拉取模型」用 Key 动态获取可用模型列表后选择，也可手动输入；
   - **后台模型**（可选）：群聊导演/记忆提取/摘要用，留空用服务器默认的便宜模型；
   → 点「保存」；
2. 配置只存在各人浏览器的 localStorage，每次请求经请求头
   （`X-Api-Base-Url` / `X-OpenRouter-Key` / `X-Chat-Model` / `X-Worker-Model`）透传给后端，
   后端只透传、不存储、不记日志。

模型优先级：API 设置里的用户全局模型 > 服务器 `.env` 默认。

安全提醒（必读）：

- **必须配 HTTPS**（Let's Encrypt 有免费证书）。没有 HTTPS，Key 和聊天内容在网络上是明文传输。
- Key 只认两种来源：请求头个人 Key > 服务器 `.env`。如果 `.env` 里配了 Key，
  所有没填个人 Key 的访客会共用它、烧你的钱——公网部署请留空。
- 不要把 Key 发给任何人、不要截图外传；怀疑泄露去 OpenRouter 后台吊销重建。
- MVP 没有登录、没有限流：知道网址的人都能用。只分享给信任的人；
  公开给陌生人用需要再加登录 + 限流（完整版事项）。

## 完整版再做的事（MVP 未包含）

- 记忆提取改为后台异步（现在是 SSE 结束前同步做，真模型会有几秒延迟）
- 记忆冲突人工确认 UI（现在是新事实覆盖旧）
- 流式 Markdown 渲染（代码块、粗体）
- 对话搜索、角色搜索框（UI 已有，搜索逻辑未接）
- 记忆条目的逐条编辑/删除（现在是全文编辑）
- 多用户/登录、数据云同步
- Docker 一键部署、移动端适配
