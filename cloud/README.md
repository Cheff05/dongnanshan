# 东南山 · 云端部署与架构说明

主人的个人长期 AI 助手。手机/电脑浏览器随时聊，记忆存在云端，本机只做**偶尔备份保险**。

## 一、架构（现状，2026-08-13）

| 部件 | 作用 | 位置 |
|---|---|---|
| 静态前端（单页应用） | 聊天界面、记忆/会话/历史/搜索 UI | `cloud/static/`（`index.html` 壳 + `app.js` + `styles.css`） |
| 云函数 `chat-stream`（HTTP/SSE） | 对话流式后端：调用大模型、直写记忆库、联网搜索、返回 token 用量 | `functions/chat-stream/` |
| NoSQL 集合（云端真相源） | `memories`（记忆）、`chats`（对话）、`sessions`（会话）、`logs`（运行日志） | CloudBase 文档数据库 |
| 云函数 `chat`（兜底） | 流式失败时的非流式兜底，旧架构，当前基本不用 | `functions/chat/`（陈旧，勿改） |

前端用 `@cloudbase/js-sdk` **匿名登录直连 NoSQL**（读写 `chats`/`memories`/`sessions`/`logs`）；对话走 `chat-stream` 的 SSE 接口。

### 数据流
```
手机/电脑浏览器
   │  读/写 记忆·会话·日志（JS-SDK 直连 NoSQL，匿名）
   ▼
chat-stream(SSE)  ──►  TokenHub/DeepSeek（额度用尽自动兜底到 DeepSeek 官方 Key）
   │  ↳ 检测 [SEARCH:关键词] → 腾讯 WSA / 百度 联网搜索（结果作独立卡片）
   │  ↳ 记忆提炼 → 后端直写 memories 集合（杜绝前端写出脏数据）
   ▼  流式返回 {token / reasoning / searchResult / done(含 usage)}
前端渲染
```

## 二、记忆策略（重要）

- **云端 NoSQL 是唯一真相源**。所有记忆、对话、会话都写在云端。
- **本机 `memory/` 仅作保险备份**，由 `tools/sync-memories.cjs` 偶尔拉取生成，不参与实时读写。
- 切换设备/重装后，云端自动同步，无需手动迁移。

## 三、本地目录结构

```
东南山/
├─ cloud/
│  ├─ static/            # 前端（部署到静态托管）
│  │  ├─ index.html      # 壳：引用下面两个文件，带 ?v= 版本号缓存破环
│  │  ├─ app.js          # 全部前端逻辑（ESM）
│  │  └─ styles.css      # 全部样式（含移动端 @media 适配）
│  └─ function/chat/     # 旧兜底函数（陈旧，勿动）
├─ functions/
│  └─ chat-stream/       # 真正的对话后端（SSE）。改完用 tcb fn deploy 部署
├─ tools/
│  └─ sync-memories.cjs  # 云端 → 本机 memory/ 备份脚本
└─ memory/               # 本机备份产出（保险用，非实时）
   ├─ memories.backup.md
   ├─ chats/<日期>.md + index.md
   └─ sessions.backup.md
```

## 四、部署

### 1. 后端函数（chat-stream）
```bash
cd 东南山
tcb fn deploy chat-stream -e YOUR_CLOUDBASE_ENV_ID
# 首次/覆盖会交互询问是否覆盖，输入 y
```
> 部署目录 `functions/chat-stream/` 的 `package.json` 仅含 `@cloudbase/node-sdk`，
> 平台按 `installDependency` 自动装依赖；本地 `node_modules` 无需上传。

环境变量：`WSA_API_KEY`（腾讯联网搜索，可选，留空则跳过 WSA 直接走百度）。

### 2. 前端静态资源
```bash
tcb hosting deploy cloud/static/index.html /index.html -e YOUR_CLOUDBASE_ENV_ID
tcb hosting deploy cloud/static/app.js      /app.js      -e YOUR_CLOUDBASE_ENV_ID
tcb hosting deploy cloud/static/styles.css   /styles.css  -e YOUR_CLOUDBASE_ENV_ID
```
**改前端后务必同步做两件事**：
1. 给 `app.js`/`styles.css` 的引用升级 `?v=` 版本号（`index.html` 里搜 `20260813g`），
   否则浏览器/CDN 可能继续用旧缓存。
2. 改完用 `Ctrl+Shift+R` 硬刷新验证；线上地址 `https://YOUR_CLOUDBASE_ENV_ID-1463153211.tcloudbaseapp.com/`。

### 3. 集合（首次）
`memories`/`chats`/`sessions`/`logs` 需存在且允许匿名读写。
`memories`/`chats` 已就绪；`sessions`/`logs` 已通过 `tcb db nosql execute` 建好。
若新建集合后前端写不进（权限问题），在 CloudBase 控制台把对应集合权限设为
「所有用户可读写」即可。

## 五、功能速览

- **会话列表**：点「会话」打开左侧抽屉，＋新建、点击切换、✎重命名、×删除。每条对话带 `sid` 归属会话；「历史」仍按日期查看全部。
- **Token 与用时**：每条 AI 回复下方显示 `⏱ 思考 Xs · 总 Ys · 输入 A + 输出 B tokens`（用量来自 `chat-stream` 的 `stream_options:include_usage`）。
- **移动端**：`@media(max-width:600px)` 适配——header 换行、模态窗近全屏、展开输入区更高、抽屉 86vw。
- **运行日志**：前端错误/初始化失败/发送失败会写入 `logs` 集合，便于远程排查（在控制台或用 `tcb db nosql execute` 查询）。
- **记忆/历史/搜索**：记忆模态窗（筛选·编辑·删除）、历史按日期、全局聊天搜索。

## 六、本机备份（偶尔）

```bash
node tools/sync-memories.cjs            # 默认环境 YOUR_CLOUDBASE_ENV_ID
node tools/sync-memories.cjs <envId>   # 指定环境
```
产出 `memory/memories.backup.md`、`memory/chats/<日期>.md` + `index.md`、`memory/sessions.backup.md`。
已配置**每周日 03:00 自动备份**的自动化任务。

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面打开后还显示旧版 | CDN/浏览器缓存 | `Ctrl+Shift+R` 硬刷新；或等几分钟 CDN 刷新；确认 `?v=` 已升级 |
| 发送后无回复且控制台报错 | 函数/网络 | 看 Console 红色报错，或查 `logs` 集合（`tcb db nosql execute` 查 `logs`） |
| 新会话刷新后丢失 | `sessions` 集合权限 | 控制台把 `sessions` 权限设为「所有用户可读写」 |
| 对话正常但不记记忆 | 记忆提炼失败 | 看回复下方的「[记忆写入失败]」提示；查 `logs` |
| 模型额度用尽 | TokenHub 402 | 自动兜底到 DeepSeek 官方 Key；或换模型 |

## 八、费用

- CloudBase 静态托管 + 函数：免费额度内（单人聊天量远达不到收费线）。
- 大模型：TokenHub/DeepSeek 约几元/百万 token，一个月几块钱封顶。
