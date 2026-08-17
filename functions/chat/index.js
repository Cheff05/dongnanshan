const SYS_PREFIX = `你是"东南山"——主人的长期 AI 助手。

你的交流方式：
- 像朋友一样自然聊天，不用书面套话，不生硬。回复要充分展开，根据话题需要可以写几段、几百字，不要刻意压缩成短句。遇到对方有情绪（抱怨、兴奋、低落、纠结、迷茫）时，先接住情绪、共情、回应他的感受，再给观点或建议——不要跳过感受直接讲道理，也不要假客气地迎合。
- 记住他提过的姓名、喜好、经历，聊到相关话题时主动呼应："你以前不是说过……"
- 不确定的事情诚实说"这个我不确定"，不编造。
- 对他的话保持兴趣——适时反问或追问，把对话往深处推，不要只是"嗯""好的""有意思"。
- 可以自然地加入语气词和 emoji，让对话有温度，但不刻意卖萌。
- 长内容注意排版：涉及对比、优缺点、选项、参数异同、步骤清单时，用 Markdown 表格（表头行 + | --- | 分隔行 + 数据行）或列表（- 项 / 1. 项）组织，不要堆成一大段；不同观点或方面各起一段，必要时用 ### 小标题分段。日常闲聊和情绪回应仍用自然口语，不必硬套格式。

你的身份和立场：
- 主人在广州市上大学，准备升大四。他喜欢你直接给结论，反感迎合和假客气。
- 他对历史、政治、国际关系、社会问题、科技有讨论兴趣——陪他分析、碰撞观点，不怕说出不同看法。
- 他希望被注意到观点理念，希望重大经历被认真对待。你是长期认识他的人，不是陌生客服。

特殊能力（重要）：
- 如果你认为回答需要实时信息、或你不确定/不知道的专业细节，**必须先给出完整、有温度的回复**，然后再在回复的【最后一行】追加 [SEARCH:关键词]（例如 [SEARCH:美元兑人民币汇率]）。这只是给后端系统的检索信号，不是给用户看的，不要在正文中解释它，也**不要只输出搜索标签而没有正文**。
- 如果信息你很确定（常识或你已掌握），就不要加。
- 常用参考源：PRTS Wiki、维基百科、百度百科。
- 示例：[SEARCH:明日方舟 水陈万重山 皮肤] `

const MAX_OUTPUT_TOKENS = 4096  // 输出篇幅上限（token）。调大=答得更长更细；调小=更省。约 1k token≈500 中文字
const BAIDU_KEY = process.env.BAIDU_API_KEY || ''  // 百度智能/联网搜索 key（qianfan.baidubce.com），从 console.bce.baidu.com 创建
const WSA_KEY = process.env.WSA_API_KEY || ''  // 腾讯联网搜索 API KEY，从 console.cloud.tencent.com/wsapi 创建

// ===== 记忆库：后端直写（与 chat-stream 一致，杜绝前端把 note 对象存成脏数据）=====
let memDb = null
try {
  const cloudbase = require('@cloudbase/node-sdk')
  const app = cloudbase.init({ env: process.env.TCB_ENV || 'YOUR_CLOUDBASE_ENV_ID' })
  memDb = app.database().collection('memories')
} catch (e) { console.error('MEMDB_INIT_FAIL', e.message) }
function bjDate(){ return bjNow().slice(0,10).replace(/\//g,'-') }
async function applyMemoryBackend(note) {
  if (!memDb) return { status: 'failed', info: '' }
  if (!note || !note.action || note.action === 'none') return { status: 'none', info: '' }
  let match = (note.match || '').toString()
  let content = note.content
  if (typeof content !== 'string') content = content == null ? '' : JSON.stringify(content)
  if (!content || content.length > 500) return { status: 'skipped', info: '' }
  try {
    if (note.action === 'add') {
      await memDb.add({ content, date: bjDate(), ts: Date.now() })
      return { status: 'added', info: content.slice(0, 40) }
    }
    const all = (await memDb.orderBy('ts', 'desc').limit(200).get()).data || []
    const q = match.trim()
    let target = null
    if (q) target = all.find(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return c && (c.includes(q) || q.includes(c.slice(0, 12)))
    })
    if (!target) {
      await memDb.add({ content, date: bjDate(), ts: Date.now() })
      return { status: 'added', info: content.slice(0, 40) }
    }
    if (note.action === 'delete') {
      await memDb.doc(target._id).remove()
      return { status: 'deleted', info: (typeof target.content === 'string' ? target.content : '').slice(0, 40) }
    }
    if (note.action === 'update') {
      await memDb.doc(target._id).update({ content })
      return { status: 'updated', info: content.slice(0, 40) }
    }
  } catch (e) { console.error('MEM_BACKEND_ERR', e.message) }
  return { status: 'failed', info: '' }
}

function bjNow() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

// 模型-Key映射（前端选模型 → 后端自动配key）
const MODEL_KEYS = {
  'glm-5-turbo':     'process.env.TOKENHUB_API_KEY',
  'deepseek-v4-flash-official': 'process.env.DEEPSEEK_API_KEY',
  'glm-5v-turbo':     'process.env.TOKENHUB_API_KEY',
  'kimi-k3':          'process.env.TOKENHUB_API_KEY',
  'glm-5.3':          'process.env.TOKENHUB_API_KEY',
}
const DEFAULT_MODEL = 'deepseek-v4-flash-official'
const API_URL = process.env.ALT_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions'
const DEEPSEEK_KEY = 'process.env.DEEPSEEK_API_KEY'  // 你自己的 DeepSeek 官方 key（TokenHub 额度用尽时兜底）
// 思考模式适配：{前缀: {efforts档位, max档位}}，档位0=关 1=轻 2=深 3=Max
const THINKING_MAP = {
  'deepseek-v4-flash': { efforts: ['','low','high'], max: 'max' },
  'deepseek':          { efforts: ['','low'], max: null },
  'hy3':               { efforts: ['','',''], max: null },
  'hunyuan-role':      { efforts: [], max: null },
  'hy-mt2':            { efforts: [], max: null },
  'hy-role':           { efforts: [], max: null },
  'glm-5-turbo':      { efforts: [], max: null },
  'glm-5.2':           { efforts: ['','low','high'], max: 'max' },
  'glm-5.1':           { efforts: ['','low','high'], max: 'max' },
  'glm-5.3':           { efforts: ['','low','high'], max: 'max' },
  'glm-5v':            { efforts: [], max: null },
  'glm':               { efforts: ['','low'], max: null },
  'kimi-k3':           { efforts: ['max','max','max'], max: 'max' },  // kimi-k3 仅支持 reasoning_effort="max"
  'kimi-k2.7':         { efforts: ['','low','high'], max: null },
  'kimi':              { efforts: ['','low'], max: null },
  'qwen3.5-plus':      { efforts: ['','low','high'], max: null },
  'qwen3.5':           { efforts: ['','low','high'], max: null },
  'qwen':              { efforts: ['','low'], max: null },
  'minimax-m3':        { efforts: ['','low','high'], max: null },
  'minimax':           { efforts: ['','low'], max: null },
  'mimo':              { efforts: [], max: null },
}

async function ds(messages, ext = {}) {
  let model = ext.model || DEFAULT_MODEL
  const apiModel = model.replace('-official', '')  // 去后缀：deepseek-v4-flash-official → deepseek-v4-flash
  const body = { model: apiModel, messages: JSON.parse(JSON.stringify(messages)), temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS }
  // 思考模式：查模型映射
  const supports = ext.deepMax || ext.deep
  // deep=-1 强制禁用思考（提炼专用）
  if (ext.deep === -1) {
    body.thinking = { type: 'disabled' }
  } else if (supports) {
    const prefix = Object.keys(THINKING_MAP).find(k => model.startsWith(k))
    const cfg = THINKING_MAP[prefix] || { efforts: [], max: null }
    const effort = ext.deepMax ? cfg.max : (cfg.efforts[ext.deep] !== undefined ? cfg.efforts[ext.deep] : null)
    if (effort !== null || ext.deepMax) {
      body.thinking = { type: 'enabled' }
      if (effort) body.reasoning_effort = effort
    }
  }
  // 图片模式：换 vision 模型
  if (ext.image) { model = 'glm-5v-turbo'; body.model = model; body.messages[body.messages.length-1].content = [
    { type: 'text', text: messages[messages.length-1].content || '请描述这张图片' },
    { type: 'image_url', image_url: { url: ext.image } }
  ]}
  const key = MODEL_KEYS[model] || process.env.ALT_API_KEY || ''
  const url = model.endsWith('-official') ? 'https://api.deepseek.com/v1/chat/completions' : API_URL
  console.log('DS_DEBUG', model, apiModel, url.slice(0,55), key.slice(-10))
  let r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  // TokenHub 额度用尽(401/402) → 自动兜底到你的 DeepSeek 官方 key
  if ((r.status===401||r.status===402) && !model.endsWith('-official')) {
    console.error('FALLBACK_TO_DEEPSEEK', r.status, model)
    r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({ ...body, model: 'deepseek-v4-flash' }),
      signal: AbortSignal.timeout(60000),
    })
  }
  if (!r.ok) throw new Error('API ' + r.status)
  const j = await r.json()
  const m = j.choices[0].message
  return { content: m.content, reasoning: ((m.reasoning_content || '').slice(0, 80)) || '' }
}

async function searchAndAnswer(query) {
  try {
    const r = await fetch('https://qianfan.baidubce.com/v2/ai_search/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BAIDU_KEY },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        search_source: 'baidu_search_v1',
        resource_type_filter: [{ type: 'web', top_k: 8 }],
        model: 'ernie-4.5-turbo-32k',
        temperature: 1e-10,
        search_mode: 'auto',
        enable_deep_search: false,
        max_completion_tokens: 2048,
        stream: false
      }),
      signal: AbortSignal.timeout(25000)
    })
    if (!r.ok) { console.error('BAIDU_SMART_HTTP', r.status); return '' }
    const j = await r.json()
    const t = (j.result || j.choices?.[0]?.message?.content || '').trim()
    if (!t) console.error('BAIDU_SMART_EMPTY', JSON.stringify(j).slice(0,200))
    return t
  } catch (e) { console.error('BAIDU_SMART_ERR', e.message); return '' }
}

async function searchWeb(query) {
  try {
    const r = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BAIDU_KEY },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        edition: 'standard',
        search_source: 'baidu_search_v2'
      }),
      signal: AbortSignal.timeout(12000)
    })
    if (!r.ok) { console.error('BAIDU_RAW_HTTP', r.status); return '' }
    const j = await r.json()
    return (j.references || []).slice(0, 5).map((x, i) => `[${i+1}] ${x.title}\n${(x.content||'').slice(0, 300)}\n${x.url}`).join('\n\n')
  } catch (e) { console.error('BAIDU_RAW_ERR', e.message); return '' }
}

// 腾讯 WSA 联网搜索（SearchPro API KEY 方式）
async function searchWSA(query) {
  if (!WSA_KEY) return ''
  try {
    const r = await fetch('https://api.wsa.cloud.tencent.com/SearchPro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + WSA_KEY },
      body: JSON.stringify({ Query: query, Mode: 0 }),
      signal: AbortSignal.timeout(9000)
    })
    if (!r.ok) return ''
    const j = await r.json()
    const pages = j?.Response?.Pages || []
    if (!pages.length) return ''
    const items = pages.map(p => { try { return JSON.parse(p) } catch (_) { return null } }).filter(Boolean)
    return items.slice(0, 6).map((x, i) => `[${i+1}] ${x.title}\n${(x.passage || '').slice(0, 400)}\n${x.url}`).join('\n\n')
  } catch (_) { return '' }
}

async function streamChat(event, context) {
  const body = JSON.parse(event.body || '{}')
  const msg = (body.message || '').trim()
  if (!msg) return { statusCode: 400, body: 'empty' }
  const ctx = body.context || ''
  const deep = parseInt(body.deep) || 0
  const image = body.image || ''
  const reqModel = body.model || ''
  const useModel = MODEL_KEYS[reqModel] ? reqModel : DEFAULT_MODEL
  const top = deep === 3 ? { deepMax: true } : (deep ? { deep } : {})

  context.callbackWaitsForEmptyEventLoop = false
  const res = context.res
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const model = useModel
    const apiModel = model.replace('-official', '')
    const history = Array.isArray(body.history) ? body.history.slice(-20) : []
    const body2 = { model: apiModel, messages: [
      { role: 'system', content: (image ? '请描述这张图片' : SYS_PREFIX + '\n\n当前时间：' + bjNow()) + (ctx ? '\n\n===== 当前记忆 =====\n' + ctx : '') },
      ...history,
      { role: 'user', content: msg || '请描述这张图片' }
    ], temperature: 0.7, stream: true, max_tokens: MAX_OUTPUT_TOKENS }
    if (image) {
      body2.model = 'glm-5v-turbo'
      body2.messages[body2.messages.length-1].content = [
        { type: 'text', text: msg || '请描述这张图片' },
        { type: 'image_url', image_url: { url: image } }
      ]
    }
    const apiModel2 = body2.model
    const key = MODEL_KEYS[apiModel2] || process.env.ALT_API_KEY || ''
    const url = apiModel2.endsWith('-official') ? 'https://api.deepseek.com/v1/chat/completions' : process.env.ALT_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions'

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body2),
      signal: AbortSignal.timeout(60000)
    })
    if (!r.ok) { res.write(`data: ${JSON.stringify({error:'API '+r.status})}\n\n`); res.end(); return }

    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const d = line.slice(6).trim()
          if (d === '[DONE]') continue
          try {
            const j = JSON.parse(d)
            const token = j.choices?.[0]?.delta?.content || ''
            if (token) { full += token; res.write(`data: ${JSON.stringify({token})}\n\n`) }
          } catch(_){}
        }
      }
    }
    // Extract note async
    let note = null
    try {
      const raw = (await ds([
        { role: 'system', content: '当前时间：'+bjNow()+'。只输出一行纯JSON：{"should_save":true|false,"content":"记忆文本"}。闲聊无新信息则should_save=false。' },
        { role: 'user', content: '已有:\n'+ctx+'\n本轮:\n用户:'+msg+'\n助手:'+full },
      ], { temperature:0, deep:-1 })).content
      const clean = raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim()
      const j = JSON.parse(clean)
      if (j.should_save && j.content && j.content.length < 500) note = j.content
    } catch(_){}
    res.write(`data: ${JSON.stringify({done:true, model:useModel, note})}\n\n`)
    res.end()
  } catch(e) {
    res.write(`data: ${JSON.stringify({error:e.message})}\n\n`)
    res.end()
  }
}

exports.main = async (event = {}, context) => {
  // HTTP 流式（仅 query 参数 stream=1 时启用）
  if (event.queryStringParameters?.stream === '1' && context.res) {
    const b = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {})
    event.message = b.message; event.context = b.context; event.deep = b.deep; event.image = b.image; event.model = b.model
    return streamChat(event, context)
  }
  const t0 = Date.now()
  console.log('REQ', JSON.stringify({ msg: (event.message||event.body?.message||'').slice(0, 50), model: event.model||event.body?.model||'', deep: event.deep||event.body?.deep||0, img: !!(event.image||event.body?.image) }).slice(0, 200))
  try {
    let b = event
    if (typeof event.body === 'string') { try { b = JSON.parse(event.body) } catch (_) { b = event } }
    else if (event.body) b = event.body
    const msg = (b.message || '').trim()
    if (!msg) return { code: 1, message: '空' }
    if (!DEFAULT_MODEL) return { code: 1, message: '无模型' }

    const ctx = b.context || ''
    const deep = parseInt(b.deep) || 0  // 0=关 1=轻 2=深 3=max
    const image = b.image || ''
    const reqModel = b.model || ''
    const useModel = MODEL_KEYS[reqModel] ? reqModel : DEFAULT_MODEL

    const top = deep === 3 ? { deepMax: true } : (deep ? { deep } : {})
    const history = Array.isArray(b.history) ? b.history.slice(-20) : []
    let { content: reply, reasoning } = await ds([
      { role: 'system', content: (image ? '请详细描述这张图片中的视觉特征：外观、颜色、花纹、构图、风格等。' : SYS_PREFIX + '\n\n当前时间：' + bjNow()) + (ctx ? '\n\n===== 当前记忆 =====\n' + ctx : '') },
      ...history,
      { role: 'user', content: msg || '请描述这张图片' },
    ], { ...top, image, model: useModel })
    console.log('DS1', (Date.now()-t0)+'ms', useModel)

    // 搜索：腾讯 WSA 联网搜索(首选) → 百度(次之)（结果结构化返回，不混入正文）
    let searchResult = '', searchSrc = '', searchQuery = ''
    const sm = reply.match(/\[SEARCH:(.+?)\]/i)
    if (sm) {
      searchQuery = sm[1].trim()
      let cleanReply = reply.replace(sm[0], '').trim()
      // 首选：腾讯 WSA 联网搜索
      const wsa = await searchWSA(searchQuery)
      if (wsa) { searchSrc = '腾讯联网搜索'; searchResult = wsa; console.log('SRCH wsa', (Date.now()-t0)+'ms') }
      // 次选：百度智能搜索
      if (!searchResult) {
        searchResult = await searchAndAnswer(searchQuery)
        if (searchResult) { searchSrc = '百度智能搜索'; console.log('SRCH baidu-smart', (Date.now()-t0)+'ms') }
      }
      // 兜底：百度 raw 搜索片段
      if (!searchResult) {
        const sr = await searchWeb(searchQuery)
        if (sr) { searchSrc = '百度搜索'; searchResult = sr; console.log('SRCH baidu-raw', (Date.now()-t0)+'ms') }
      }
      // 兜底：模型只输出搜索标签、没给正文时，直接用搜索结果作为助手回复，避免空泡
      if (!cleanReply && searchResult) {
        cleanReply = searchResult
        searchResult = ''; searchSrc = ''; searchQuery = '' // 不额外显示搜索卡片，避免同内容重复
      }
      reply = cleanReply  // 正文保持干净
    }

    let note = null, noteStatus = 'skipped'
    try {
      const raw = (await ds([
        { role: 'system', content: '你是记忆管理器。对比"已有记忆"与"本轮对话"，输出一行纯JSON（不要任何markdown包裹）：{"action":"add"|"update"|"delete"|"none","match":"要修改/删除的旧记忆关键片段(仅update/delete填)","content":"记忆文本(含准确日期),仅add/update填"}。规则：用户纠正了之前错误信息→update且match填旧错误记忆片段；用户说"忘掉/删掉"某记忆→delete且match填该片段；本轮有新事实→add；纯闲聊或无变化→none。' },
        { role: 'user', content: '已有记忆:\n' + (ctx || '(无)') + '\n\n本轮:\n用户:' + msg + '\n助手:' + reply },
      ], { temperature: 0, deep:-1 })).content
      // 清洗 markdown 代码块包裹
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const j = JSON.parse(clean)
      if (['add','update','delete','none'].includes(j.action)) {
        if (j.content && typeof j.content !== 'string') j.content = JSON.stringify(j.content)
        if (j.match && typeof j.match !== 'string') j.match = String(j.match)
        note = j; noteStatus = 'extracted';
      }
    } catch (_) { noteStatus = 'failed'; }
    console.log('DONE', (Date.now()-t0)+'ms', noteStatus)
    let noteInfo = ''
    if (note && note.action && note.action !== 'none') {
      try { const mr = await applyMemoryBackend(note); noteStatus = mr.status; noteInfo = String(mr.info || '') } catch (_) {}
    }
    return { code: 0, data: { reply, note, noteStatus, noteInfo, searchResult, searchSrc, searchQuery, reasoning: deep ? reasoning : '', model: useModel } }
  } catch (e) { return { code: 1, message: e.message, stack: (e.stack||'').slice(0, 300) } }
}
