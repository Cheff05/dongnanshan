# 东南山 · 项目结构说明（给你自己研究用）

> 写于 2026-08-14。目的是让你打开这个项目时，知道每个文件是干嘛的、代码怎么跑起来的、从哪开始读。

## 0. 先说清楚：代码本来就在你本地

项目根目录就是：**`项目根目录`**（你电脑桌面上的「东南山」文件夹）。

你平时在 WorkBuddy 里跟我聊，项目跑在本机，所以**源码、记忆、配置全都已经在你电脑上，不需要从云端"下载"**。本文档帮你把结构理清楚，并配套打了一个研究包 zip 在桌面，方便你拷贝/备份/发给别的设备研究。

项目里其实有两套体系：
1. **本地版**：纯 Markdown 记忆文件 + 提示词驱动的 AI 助手（老方案，看根目录 `README.md`）。
2. **云端版（`cloud/` + `functions/`）**：部署到腾讯云 CloudBase 的网页聊天 + 云函数后端，手机/电脑浏览器随时聊——**这是你当前主要用的，也是"代码"所在**。

---

## 1. 目录树（带说明）

```
东南山/
├─ cloud/                      # 云端版前端 + 部署文档
│  ├─ README.md                # 云端架构 / 部署 / 排错总文档（最重要，先看这个）
│  ├─ static/                  # 前端静态资源（部署到 CloudBase 静态托管）
│  │  ├─ index.html            # 网页壳：引入下面两个文件，带 ?v= 版本号破缓存
│  │  ├─ app.js                # 全部前端逻辑（ES 模块）：聊天 / 记忆 / 会话 / 搜索 / 模型切换
│  │  └─ styles.css            # 全部样式（含手机 @media 适配）
│  └─ function/chat/           # 旧兜底函数（已废弃，勿改）
│
├─ functions/
│  ├─ chat-stream/             # 【核心后端】对话云函数（SSE 流式）
│  │  ├─ index.js              # 全部后端逻辑：调模型 / 写记忆 / 联网搜索 / 兜底
│  │  ├─ package.json          # 仅依赖 @cloudbase/node-sdk
│  │  ├─ scf_bootstrap         # SCF 启动脚本
│  │  └─ node_modules/         # 依赖（云端部署时自动装，本地这个不用管）
│  └─ chat-full.zip            # 旧整包备份（可删，没用）
│
├─ tools/
│  └─ sync-memories.cjs        # 云端 NoSQL → 本地 memory/ 备份脚本（每周日 03:00 自动跑）
│
├─ memory/                     # 本地备份产出（保险用，非实时）
│  ├─ memories.backup.md       # 云端「记忆库」快照（可读 Markdown）
│  ├─ chats/                   # 云端对话按日期的 Markdown 备份 + index.md
│  ├─ json/                    # 原始 JSON：memories.json / chats.json / sessions.json（便于迁移/脚本处理）
│  ├─ profile.md / memory.md / summary.md  # 本地版记忆三件套（AI 必读，云平台不用）
│
├─ chats/                      # 本地版对话原始记录（按日期归档）
├─ prompts/                    # 本地版 AI 人格 / 记忆规则设定
├─ backups/  db_export/        # 历史操作的备份（可忽略）
├─ cloudbaserc.json            # CloudBase CLI 配置
├─ README.md                   # 项目总览（本地版视角）
└─ STRUCTURE.md               # 本文件
```

---

## 2. 一次对话是怎么跑起来的（数据流）

```
手机 / 电脑浏览器
   │  读 / 写 记忆 · 会话 · 日志（JS-SDK 匿名直连 NoSQL）
   ▼
cloud/static/app.js  （构造消息 + 调用下方接口）
   │  POST 对话内容到 chat-stream
   ▼
functions/chat-stream/index.js  （SSE 流式后端）
   │  ↳ 调用大模型：默认 glm-5.1（走 TokenHub 免费额度）
   │  ↳ 额度耗尽 / 限流（402 / 429 / 200错误体）→ 自动兜底到你的 DeepSeek 官方 Key
   │  ↳ 检测回复里的 [SEARCH:关键词] → 腾讯 WSA / 百度 联网搜索（结果作独立卡片）
   │  ↳ 记忆提炼 → 后端直写 memories 集合（不让前端写脏数据）
   ▼
流式返回 { token / reasoning / searchResult / done(含 token 用量) }
   │
前端渲染 + 把对话写入 chats 集合
```

**记忆的唯一真相源在云端 NoSQL**（`memories` / `chats` / `sessions` / `logs`）。本机 `memory/` 只是偶尔拉下来备份的快照，不参与实时读写。

> 各集合的**字段结构、谁读谁写、Storage 图片桶、本地备份脚本**的详细说明，见仓库根目录 [`DATABASE.md`](./DATABASE.md)。这是搞清楚「云端数据库到底存了什么」的必读文档；尤其注意：本地 Markdown 记忆与云端 NoSQL 是**两套互不相干**的数据，本地只是云端备份快照。

---

## 3. 关键文件 · 重点看哪里

### `functions/chat-stream/index.js`（后端核心）
- **顶部（1–45 行）**：
  - `SYS_PREFIX`：AI 的人设 + 记忆规则 + 网暴背景。**这是固定 token 的最大头（~1.5–2k），是你的"脑子本身"，不该砍。**
  - `MODEL_KEYS`：每个模型名 → 对应的 API key（TokenHub 共享 key / 你的 DeepSeek 官方 key）。
  - `DEFAULT_MODEL = 'glm-5.1'`：默认模型。
  - `DEEPSEEK` / `DEEPSEEK_KEY`：兜底的官方端点与你的自有 key。
- **中段（~150–240 行）**：接管一次对话请求 → 构造 `messages` → 调模型 → **兜底逻辑**（401/402/429 + 识别「200 但 body 带错误」异常 → 回退自有 DeepSeek key；发图模型兜底时降级纯文字）。
- 后面还有：记忆提炼、联网搜索 `[SEARCH:]` 检测、token 用量回传。

### `cloud/static/app.js`（前端核心）
- `buildContext(msg)`：**记忆召回的核心**。含 3 条通道：
  1. `priority` 点名通道——你点名的人/事强制全量召回（不受容量限制）；
  2. `KEY_ENTITIES` 轻量钉——落落/苏苏/鸢凉/大土豆/片片/林/QQ/靖康事变/网暴事变/特蕾西娅/莫斯提马，每个实体只钉 **1 条**最具信息量的记忆（截断 150 字）作联想锚点；
  3. 核心层 + 近期层 + `MIN_CTX=40` 地板兜底。
- `kw(text)`：中文 n-gram 关键词提取（对中文字符跑 2/3 字滑窗）。
- 模型面板、`?v=` 版本戳、`⏱ 思考 Xs·总 Ys·输入A+输出B tokens` 显示。

---

## 4. 敏感配置提醒（重要）

`functions/chat-stream/index.js` 顶部**硬编码了你自己的 API key**（TokenHub 共享 key、DeepSeek 自有 key、百度 key）。这些本来就是你账户的，**不要把整个文件夹发给不信任的人**。

想换模型 / 换 key：直接改 `index.js` 顶部的 `MODEL_KEYS` / `DEEPSEEK_KEY`，然后按下方命令重新部署即可。

---

## 5. 怎么改、怎么部署

```bash
# 部署前端（改完记得 index.html 里 ?v= 升版本号，否则浏览器用旧缓存）
tcb hosting deploy cloud/static/index.html /index.html -e YOUR_CLOUDBASE_ENV_ID
tcb hosting deploy cloud/static/app.js     /app.js     -e YOUR_CLOUDBASE_ENV_ID
tcb hosting deploy cloud/static/styles.css  /styles.css -e YOUR_CLOUDBASE_ENV_ID

# 部署后端函数
cd 东南山
tcb fn deploy chat-stream -e YOUR_CLOUDBASE_ENV_ID   # 提示覆盖时输入 y

# 把云端记忆拉到本地（看最新数据）
node tools/sync-memories.cjs
```

线上地址：`https://YOUR_CLOUDBASE_ENV_ID-1463153211.tcloudbaseapp.com/`
改完前端后浏览器 `Ctrl+Shift+R` 硬刷新。

---

## 6. 建议的阅读顺序

1. `cloud/README.md` —— 先看整体架构与排错表。
2. `functions/chat-stream/index.js` —— 看「一次对话」在后端怎么发生（调模型、兜底、写记忆）。
3. `cloud/static/app.js` —— 看前端「记忆召回」怎么工作（buildContext）。
4. `memory/memories.backup.md` —— 看看 AI 都记了你哪些事（落落、苏苏、网暴事变…）。
5. 本文件（STRUCTURE.md）—— 随时回查目录含义。

---

## 7. 版本历史速查

| 版本 | 时间 | 改了什么 |
|---|---|---|
| v20260813k | 08-13 | 关键人物「钉死常驻」通道，根治"想不起苏苏/落落" |
| v20260814a | 08-14 | 接入 glm-5.1 与 deepseek-v4-pro-202606，删 glm-5-turbo |
| v20260814b | 08-14 | glm-5.1 设为默认模型（走 TokenHub 免费额度） |
| v20260814c | 08-14 | token 电老虎修复：钉死从"每实体5条"改为"每实体1条≤150字" |
| v20260814d | 08-14 | 兜底加固：402/429/200错误体全兜；发图兜底降级纯文字 |
| v20260814e | 08-14 | 发送框支持直接粘贴图片 + 多选 + 上限9张 + 预览缩略图（前端多图 UI） |
| v20260814f | 08-14 | 删 deepseek-v4-pro（额度用光），保留 deepseek-v4-pro-202606；修复发图后端上传链路：node-sdk v3 存储方法直接挂 app 上（app.uploadFile/getTempFileURL），无 app.storage() |
| v20260814g | 08-14 | 新增模型 kimi-k3 / glm-5.3（TokenHub，共用现有 key）。kimi-k3 适配：禁传 thinking、reasoning_effort 锁 max、输出用 max_completion_tokens、不传 temperature；发图时 kimi 只收 Base64 dataURI（直接透传、不走 Storage 上传），其它模型仍走 glm-5v-turbo(URL)。遗留 chat 兜底函数同步加 key+思考映射 |
| v20260814h | 08-14 | 修 kimi-k3 发图 400：① 前端 kimi 模型下 webp/gif 用 canvas 自动转 png；② 后端对 kimi 的 webp/gif 兜底拦截给友好提示（不再裸 400，因 TokenHub kimi 服务端对 webp/gif 会 panic）；③ **关键**：kimi 带图时拒收 reasoning_effort(max)→400，改为仅纯文字启用 max 思考、带图不传；④ 后端非 200 时透传上游真实错误体便于诊断 |
| v20260814i | 08-14 | 修 CORS 双值拦截：函数原自设 `Access-Control-Allow-Origin: *`，与 CloudBase Web 函数平台注入的具体 origin 冲突→浏览器报 "contains multiple values" 并拦掉整条 fetch。改为删除函数侧 Origin 头，仅保留平台注入的单值；前端版本戳 h→i 强制刷新缓存（解决旧 g 版发送按钮 inline onclick 引用未定义 sendBtn 的报错） |
| v20260814j | 08-14 | 修思考过程折叠交互 bug：原用 style.maxHeight 字符串比较且展开后 overflow 仍 hidden 不可滚动；改为 CSS class `.reasoning-box` + `data-folded` 标志，折叠 44px、展开 `max-height:55vh;overflow-y:auto` 可滚动；折叠态流式新 token 不覆盖标题 |
| v20260814k | 08-14 | **修 glm-5.3/kimi-k3 频发"请求超时"**：根因①后端主 fetch `AbortSignal.timeout(45000)` 早于两模型首 token（kimi/glm 在 TokenHub 上 TTFT 天然 ~27-70s，叠加 Web 函数冷启动+searchChats+完整记忆上下文常破 45s）→ 被掐断→回传 timeout→前端显示"请求超时"。② kimi-k3 原强制 `reasoning_effort:'max'` 会令其先深度思考 100s+ 才出首 token，且 kimi 在【不传 reasoning_effort】时默认也重度思考→更易超时。修复：平台函数超时 120→300s；后端主 fetch 超时按模型 120s/280s(kimi)；kimi 思考深度跟随 deep 档位且**永不用 max**（deep0→low/deep1→medium/deep2→high，全部显式传值避免默认重思考）；前端慢模型等待时显示实时计时"⏳ 思考中… Ns（模型较慢，请稍候）"。实测 kimi/glm 默认档 + 4000字记忆上下文均 22s/49s 内出首 token，无超时 |
| v20260817a | 08-17 | **用户报"kimi 思考好久不生成 + 其他模型也有问题"→ 实测排查**：① 删 `deepseek-v4-pro-202606`（额度用光，用户要求）。② 直连 TokenHub 实测：kimi-k3 正常（HTTP200，短 prompt 首 token ~2s、完整后端 prompt ~11s，是推理模型天然长思考，非故障）；glm-5.1(默认)/glm-5.3 自带 3-16s 思考期（即使未开思考也会先 reasoning 再出正文）→ 即"其他模型也慢"的真因；`deepseek-v4-flash`(TokenHub) 已 402(免费额度耗尽) 但后端自动兜底到官方 DeepSeek(实测存活可用)；官方 DeepSeek 兜底链路实测存活。③ 修前端：默认模型按钮标签由误导性的 "deepseek-v4-flash" 改回真实默认 "glm-5.1"；思考阶段自动 scrollDown 保持思考框在视野内，避免"像卡死"；版本戳 k→a。已重部署后端+前端并端到端验证(kimi 3.4s / glm-5.1 9s 均正常出回复) |
| v20260817b | 08-17 | **修手机端三处 bug**：① 输入框展开后占位提示硬折行 + 占满屏幕 → 移动端 placeholder 缩短为"说点什么…"并限制展开高度 32-48vh，保留聊天区域可见。② 流式回复已逐步显示后，末尾又完整打字输出一次 → 根因是流式成功路径仍调用 `typewriter`；改为仅兜底路径调用 typewriter，流式完成直接定格最终内容。③ 手机切后台导致 SSE 断开/卡死 → 引入 `AbortController` + `visibilitychange` 监听：切后台超过 4s 自动 abort 当前请求，删除已显示的用户消息并给出"重试"按钮，避免返回前台后连接挂起 |

> 环境 ID：`YOUR_CLOUDBASE_ENV_ID`
