# 枢衡殿 · 数据库与存储说明（DATABASE.md）

> 这份文档专门把云端版用到的 **CloudBase NoSQL 数据库** 和 **云存储 Storage** 讲清楚：
> 存了什么、字段是什么、谁读谁写、和本地记忆到底什么关系、图片放哪。
> 代码层面参见 `functions/chat-stream/index.js`（后端直写）与 `cloud/static/app.js`（前端直连）。

---

## 0. 先厘清：有两套「记忆」，别混

这是最容易误解的点。本项目其实有两套独立的记忆体系：

| 体系 | 介质 | 谁在用 | 实时性 | 接不接 API/数据库 |
|---|---|---|---|---|
| **本地版记忆** | `memory/*.md` + `prompts/*`（纯 Markdown 文件） | WorkBuddy 本机对话 | 文件即真相，AI 按 prompts 规则维护 | **不接任何 API、不接数据库** |
| **云端版记忆** | CloudBase NoSQL 4 集合 + Storage | 手机/电脑网页聊天（`cloud/`） | 实时读写，数据库是唯一真相源 | 接 CloudBase |

⚠️ **两者不是同一份数据。**
- 云端 NoSQL 是实时真相源（网页聊天时立刻读写）。
- 本地 `memory/` 只是云端 NoSQL 的**单向备份快照**（靠 `tools/sync-memories.cjs` 拉下来），不参与实时读写。
- 所谓「本地 ↔ 云端双向同步」目前**只实现了云端 → 本地备份**；本地改了不会自动回写云端。要回写需手动处理。

---

## 1. NoSQL 数据库（集合清单）

- 所在：CloudBase 环境的 NoSQL 数据库。
- 两个客户端：
  - **前端** `cloud/static/app.js` 用 `@cloudbase/js-sdk` **匿名登录直连**（网页里直接读写）。
  - **后端** `functions/chat-stream/index.js` / `functions/chat/index.js` 用 `@cloudbase/node-sdk` 在服务端直连。

共 4 个集合：

### 1.1 `memories` —— 记忆库（核心真相表）

> 这就是「AI 记得你什么」的那张表。

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 系统自动生成 |
| `content` | string | 记忆文本，单条 ≤ 500 字 |
| `date` | string | 北京日期 `YYYY-MM-DD` |
| `ts` | number | 毫秒时间戳，用于排序/匹配 |

- **写入方**：
  - 后端 `chat-stream` 的 `applyMemoryBackend()`：AI 对话结束时提炼记忆 → `add` / `update` / `delete`（彻底杜绝前端把 note 对象存成脏数据）。
  - 前端 `app.js` 记忆面板：用户手动 `add` / `update` / `remove`。
  - 旧兜底函数 `chat/index.js`（仅兜底路径）。
- **读取方**：前端 `buildContext()` 召回记忆（按 `ts` 倒序取 500 条）；后端 `applyMemoryBackend` 匹配更新目标。

### 1.2 `chats` —— 对话消息

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 系统自动生成 |
| `who` | string | `'ai'` 或 `'user'` |
| `text` | string | 消息内容 |
| `time` | string | 时分串（如 `14:12`） |
| `date` | string | 北京日期 `YYYY-MM-DD` |
| `ts` | number | 毫秒时间戳 |
| `sid` | string | 所属会话 id（可选，无则全局消息） |

- **写入方**：前端每次发消息时 `db.collection('chats').add(...)`。
- **读取方**：按日期加载、按会话加载、关键词搜索、删除单条。
- **用途**：网页聊天历史，可翻看、可搜索。

### 1.3 `sessions` —— 会话列表

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 系统自动生成 |
| `sid` | string | 会话唯一 id |
| `title` | string | 会话标题（可改名） |
| `createdAt` | number | 创建时间戳 |
| `updatedAt` | number | 更新时间戳 |
| `date` | string | 北京日期 |

- **写入方**：前端新建会话时 `add`。
- **读取/改/删**：前端会话面板（改名、删除会话及其消息）。
- **用途**：多会话切换管理。

### 1.4 `logs` —— 前端日志

| 字段 | 类型 | 含义 |
|---|---|---|
| `_id` | string | 系统自动生成 |
| `level` | string | 日志级别（如 `info` / `error`） |
| `msg` | string | 日志内容（截断 500 字） |
| `extra` | string | 附加信息 JSON（截断 500 字） |
| `ua` | string | 浏览器 UA（截断 200 字） |
| `v` | string | 前端版本戳（如 `v20260817j`） |
| `t` | number | 时间戳 |

- **写入方**：前端 `reportLog()` 报错/行为埋点。
- **用途**：调试用，匿名、不含个人信息。

---

## 2. Storage（云存储桶）

- **用途**：发图时存图片。
  - 前端把图片转成 Base64 dataURI 传给后端；
  - 后端 `uploadImageB64()` 调 `app.uploadFile()` 上传到云存储；
  - 再调 `app.getTempFileURL()` 拿**公网临时 URL** 喂给视觉模型（`glm-5v-turbo` 只收公网 URL，不收内嵌 dataURI）。
- **路径规则**：`chat-images/<Date.now()>-<随机6位>.<png|jpg|webp|...>`
- **接口注意**：node-sdk v3 下存储方法直接挂在 `app` 上（`app.uploadFile` / `app.getTempFileURL`），**没有 `app.storage()` 封装**（曾误用 `app.storage()` 导致上传永远失败）。
- **清理**：当前代码未实现自动清理。临时 URL 会过期，但文件常驻桶内，需手动或计划任务定期清理，避免无限膨胀。

---

## 3. 本地备份脚本 `tools/sync-memories.cjs`

- **作用**：把云端 `memories` / `chats` / `sessions` 三个集合拉到本地 `memory/` 做快照（Markdown + 原始 JSON）。
- **用法**：`node tools/sync-memories.cjs [envId]`（需本机已 `tcb login`）。
- **产出**：
  - `memory/memories.backup.md` + `memory/json/memories.json`
  - `memory/chats/<日期>.md` + `memory/chats/index.md` + `memory/json/chats.json`
  - `memory/sessions.backup.md` + `memory/json/sessions.json`
- **性质**：保险 / 迁移 / 二次处理用，**不参与实时读写**。
- ⚠️ 该脚本里的 envId 默认值是占位 `YOUR_CLOUDBASE_ENV_ID`，部署时请传真实环境 id 或改默认值。

---

## 4. 数据流向（一次网页对话）

```
浏览器 app.js（匿名直连 NoSQL）
   │  add 消息 → chats 集合
   │  add 日志 → logs 集合
   │  读记忆   → memories 集合（buildContext 召回）
   │  读/写会话 → sessions 集合
   ▼  POST 对话到 chat-stream
functions/chat-stream/index.js（node-sdk 服务端直连）
   │  调大模型（glm-5.1 默认，兜底 DeepSeek）
   │  发图时 app.uploadFile → Storage 桶 → getTempFileURL 拿公网 URL
   │  对话结束提炼记忆 → memories 集合（add/update/delete）
   ▼  SSE 流式返回
前端渲染 + 把 AI 回复写入 chats 集合

       ──（异步/手动）──
tools/sync-memories.cjs：云端 3 集合 → 本地 memory/ 快照（备份，非实时）
```

**一句话总结**：网页聊天时，数据库（NoSQL 4 集合）是实时真相，Storage 桶存图片；本地 `memory/` 只是一份可随时拉取的备份，和本机 WorkBuddy 用的纯 Markdown 记忆是两套互不相干的东西。
