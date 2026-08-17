#!/usr/bin/env node
/**
 * 东南山 · 云端记忆本地备份（保险用）
 * 拉取 CloudBase NoSQL 的 memories / chats / sessions 集合 → 本地 memory/ 下
 * - 可读 markdown（memories.backup.md / chats/<日期>.md / sessions.backup.md）
 * - 原始 JSON（json/*.json），便于迁移/恢复/脚本二次处理
 * 用法：node tools/sync-memories.cjs [envId]
 * 依赖：已通过 `tcb login` 登录的 CLI 会话（本机已具备）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 脱敏占位：部署时请传真实环境 id，或把下面默认值改成你的 envId
const ENV = process.argv[2] || 'YOUR_CLOUDBASE_ENV_ID';
const OUT = path.resolve(__dirname, '..', 'memory');
const OUT_CHATS = path.join(OUT, 'chats');
const OUT_JSON = path.join(OUT, 'json');

// 本机 tcb CLI 是 node 脚本，Windows 下用 node 显式拉起以避开 PATH/shebang 问题
const NODE = 'C:\\Users\\Elysia\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node.exe';
const TCB = 'C:\\Users\\Elysia\\.workbuddy\\binaries\\node\\cli-connector-packages\\tcb';
function runTcb(args) {
  try { return execFileSync('bash', [TCB, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return ''; }
}
function tcbQuery(table, command) {
  const args = ['db', 'nosql', 'execute', '-c', JSON.stringify([{ TableName: table, CommandType: 'QUERY', Command: command }]), '--json', '-e', ENV];
  const out = runTcb(args) || '';
  const s = out.indexOf('{');
  const e = out.lastIndexOf('}');
  if (s < 0 || e < 0) return { data: [] };
  try { return JSON.parse(out.slice(s, e + 1)); } catch (_) { return { data: [] }; }
}
function queryAll(table, pageSize = 500) {
  let docs = [], skip = 0;
  while (true) {
    const res = tcbQuery(table, `{ "find": "${table}", "filter": {}, "skip": ${skip}, "limit": ${pageSize} }`);
    const raw = (res.data && res.data.results) || [];
    const batch = Array.isArray(raw) ? raw.flat(Infinity) : [];
    docs = docs.concat(batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
    if (skip > 20000) break;
  }
  return docs;
}
function esc(t) { return String(t == null ? '' : t).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function writeJson(name, docs, collection) {
  const payload = {
    collection,
    envId: ENV,
    backedUpAt: new Date().toISOString(),
    count: docs.length,
    docs
  };
  fs.writeFileSync(path.join(OUT_JSON, name + '.json'), JSON.stringify(payload, null, 2));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_CHATS, { recursive: true });
  fs.mkdirSync(OUT_JSON, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const mem = queryAll('memories');
  let m = `# 记忆库（云端备份 @ ${stamp}）\n\n共 ${mem.length} 条\n\n`;
  for (const x of mem.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    m += `- [${x.date || '?'}] ${esc(x.content || '')}\n`;
  }
  fs.writeFileSync(path.join(OUT, 'memories.backup.md'), m);
  writeJson('memories', mem, 'memories');

  const chats = queryAll('chats');
  const byDate = {};
  for (const c of chats) { const d = c.date || 'unknown'; (byDate[d] = byDate[d] || []).push(c); }
  let index = `# 对话记录索引（云端备份 @ ${stamp}）\n\n共 ${chats.length} 条，覆盖 ${Object.keys(byDate).length} 天\n\n`;
  for (const d of Object.keys(byDate).sort().reverse()) {
    const list = byDate[d].slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let f = `# 对话记录 ${d}\n\n`;
    for (const c of list) {
      const who = c.who === 'ai' ? '东南山' : '你';
      f += `## ${c.time || ''} · ${who}\n${esc(c.text || '')}\n\n`;
    }
    fs.writeFileSync(path.join(OUT_CHATS, d + '.md'), f);
    index += `- ${d}（${list.length} 条）→ chats/${d}.md\n`;
  }
  fs.writeFileSync(path.join(OUT_CHATS, 'index.md'), index);
  writeJson('chats', chats, 'chats');

  const sess = queryAll('sessions');
  let sm = `# 会话列表（云端备份 @ ${stamp}）\n\n共 ${sess.length} 个\n\n`;
  for (const s of sess.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    sm += `- ${esc(s.title || '会话')}（${s.date || ''} · sid=${s.sid}）\n`;
  }
  fs.writeFileSync(path.join(OUT, 'sessions.backup.md'), sm);
  writeJson('sessions', sess, 'sessions');

  console.log(`备份完成：memories ${mem.length} 条 / chats ${chats.length} 条（${Object.keys(byDate).length} 天）/ sessions ${sess.length} 个`);
  console.log(`Markdown：${OUT}`);
  console.log(`JSON：${OUT_JSON}`);
}
main();
