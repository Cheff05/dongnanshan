const http = require('http')
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
- 常用参考源：维基百科、百度百科。
- 示例：[SEARCH:明日方舟 水陈万重山 皮肤]`

const MAX_OUTPUT_TOKENS = 4096  // 输出篇幅上限（token）。调大=答得更长更细；调小=更省。约 1k token≈500 中文字
const MODEL_KEYS = {
  'deepseek-v4-flash':'process.env.TOKENHUB_API_KEY',
  'deepseek-v4-flash-official':'process.env.DEEPSEEK_API_KEY',
  'glm-5.1':          'process.env.TOKENHUB_API_KEY',
  'glm-5v-turbo':     'process.env.TOKENHUB_API_KEY',
  'kimi-k3':          'process.env.TOKENHUB_API_KEY',
  'glm-5.3':          'process.env.TOKENHUB_API_KEY',
}
const DEFAULT_MODEL = 'glm-5.1'
const TOKENHUB = 'https://tokenhub.tencentmaas.com/v1/chat/completions'
const DEEPSEEK = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_KEY = 'process.env.DEEPSEEK_API_KEY'  // 你自己的 DeepSeek 官方 key（TokenHub 额度用尽时兜底）
const BAIDU_KEY = process.env.BAIDU_API_KEY || ''  // 百度智能/联网搜索 key（qianfan.baidubce.com），从 console.bce.baidu.com 创建
const WSA_KEY = process.env.WSA_API_KEY || ''  // 腾讯联网搜索 API KEY，从 console.cloud.tencent.com/wsapi 创建

function bjNow(){return new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}
function bjDate(){return bjNow().slice(0,10).replace(/\//g,'-')}

// ===== 记忆库：后端直写，彻底杜绝前端把 note 对象存成脏数据 =====
// 注意：cloudbase / app 必须声明在 try 外层（模块级作用域），否则块内 const 在 diag / storage 初始化处不可见（曾导致 "app is not defined"）
const cloudbase = require('@cloudbase/node-sdk')
let app = null, memDb = null, chatDb = null, _db = null
try {
  app = cloudbase.init({ env: process.env.TCB_ENV || 'YOUR_CLOUDBASE_ENV_ID' })
  _db = app.database()
  memDb = _db.collection('memories')
  chatDb = _db.collection('chats')
} catch (e) { console.error('MEMDB_INIT_FAIL', e.message) }

// 把前端传来的 base64/dataURI 图片上传到 CloudBase Storage，返回公网 tempFileURL。
// 原因：TokenHub 视觉模型(glm-5v-turbo)只接受公网图片 URL，不接受 data URI 内嵌。
// 注意：node-sdk v3 的存储方法直接挂在 app 上（app.uploadFile / app.getTempFileURL），
// 没有 app.storage() 封装（曾误用 stDb=app.storage() 导致 stDb=null，上传永远失败）。
async function uploadImageB64(b64){
  if(!app) return null
  try{
    const m = (b64||'').match(/^data:([^;]+);base64,(.*)$/)
    const ext = m ? (m[1].split('/')[1]||'png').replace(/[^a-z0-9]/gi,'') : 'png'
    const raw = m ? m[2] : b64
    const buf = Buffer.from(raw, 'base64')
    const cloudPath = 'chat-images/'+Date.now()+'-'+Math.random().toString(36).slice(2,8)+'.'+ext
    const up = await app.uploadFile({ cloudPath, fileContent: buf })
    const fileID = up && up.fileID
    if(!fileID) return null
    const urlRes = await app.getTempFileURL({ fileList: [fileID] })
    const item = urlRes && urlRes.fileList && urlRes.fileList[0]
    return (item && item.tempFileURL) || null
  }catch(e){ console.error('UPLOAD_IMG_FAIL', e.message); return null }
}

// 后端执行记忆增删改：note={action,match,content} → 直接写库，返回 {status,info}
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
    if (!target) { // 找不到匹配→兜底新增，不丢信息
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

// ===== 历史对话检索（让 AI 能回忆过往对话，弥补记忆偶尔缺失）=====
function escRe(s){ return (s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&') }
// 后端关键词提取：CJK 滑窗 2/3 字 n-gram + 英文/数字 3+，过滤常见停用词（避免"我们/之前"等命中一切对话）
const KW_STOP=new Set(['我们','之前','聊过','你们','他们','这个','那个','什么','怎么','现在','时候','知道','觉得','因为','所以','可以','已经','一下','关于','如果','但是','就是','这样','那样','不是','没有','一个','这种','那种','自己','真的','还是','选择','记得','帮我','想问']);
function extractKeywords(text){
  const t = (text||'').toLowerCase().replace(/[\s\p{P}]/gu,'')
  const grams = []
  for (const run of (t.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (const n of [2,3]) for (let i=0;i+n<=run.length;i++) grams.push(run.slice(i,i+n))
  }
  const en = t.match(/[a-z0-9]{3,}/g) || []
  return [...new Set([...grams,...en])].filter(w=>!KW_STOP.has(w))
}
async function searchChats(msg){
  if(!chatDb) return ''
  const kws = extractKeywords(msg).slice(0,10)
  if(kws.length===0) return ''
  try{
    // 拉取全部聊天（当前 801 条，上限取 2000 留余量），在 JS 侧按关键词过滤：不依赖数据库正则，规避 node-sdk RegExp 静默返回空的坑，且不会漏掉较旧的历史
    const rows = (await chatDb.orderBy('ts','desc').limit(2000).get()).data || []
    // 只取用户本人的历史发言（who==='user'）：避免把东南山自己过去的胡话（如"查不到苏苏/落落"）当历史参考喂回去，形成自我中毒闭环
    const hit = rows.filter(r => r.who==='user' && kws.some(k=>(r.text||'').includes(k)))
    if(hit.length){
      console.log('[chat-search] keyword='+JSON.stringify(kws.slice(0,3))+' userHits='+hit.length)
      return hit.slice(0,12).map(r=>`[${r.date||''} ${r.time||''}] 你: ${(r.text||'').slice(0,160)}`).join('\n')
    }
    return ''
  }catch(e){ console.error('CHAT_SEARCH_ERR', e.message); return '' }
}

// ===== 搜索：腾讯 WSA 联网搜索(首选) → 百度(次之) =====
async function searchWSA(query){
  if(!WSA_KEY)return ''
  try{
    const r=await fetch('https://api.wsa.cloud.tencent.com/SearchPro',{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Bearer '+WSA_KEY},body:JSON.stringify({Query:query,Mode:0}),signal:AbortSignal.timeout(9000)})
    if(!r.ok)return ''
    const j=await r.json()
    const pages=j?.Response?.Pages||[]
    if(!pages.length)return ''
    const items=pages.map(p=>{try{return JSON.parse(p)}catch(_){return null}}).filter(Boolean)
    return items.slice(0,6).map((x,i)=>`[${i+1}] ${x.title}\n${(x.passage||'').slice(0,400)}\n${x.url}`).join('\n\n')
  }catch(_){return ''}
}
async function searchAndAnswer(query){
  try{
    const r=await fetch('https://qianfan.baidubce.com/v2/ai_search/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+BAIDU_KEY},body:JSON.stringify({messages:[{role:'user',content:query}],search_source:'baidu_search_v1',resource_type_filter:[{type:'web',top_k:8}],model:'ernie-4.5-turbo-32k',temperature:1e-10,search_mode:'auto',enable_deep_search:false,max_completion_tokens:2048,stream:false}),signal:AbortSignal.timeout(25000)})
    if(!r.ok){console.error('BAIDU_SMART_HTTP',r.status);return ''}
    const j=await r.json()
    const t=(j.result||j.choices?.[0]?.message?.content||'').trim()
    if(!t)console.error('BAIDU_SMART_EMPTY',JSON.stringify(j).slice(0,200))
    return t
  }catch(e){console.error('BAIDU_SMART_ERR',e.message);return ''}
}
async function searchWeb(query){
  try{
    const r=await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+BAIDU_KEY},body:JSON.stringify({messages:[{role:'user',content:query}],edition:'standard',search_source:'baidu_search_v2'}),signal:AbortSignal.timeout(12000)})
    if(!r.ok){console.error('BAIDU_RAW_HTTP',r.status);return ''}
    const j=await r.json()
    return (j.references||[]).slice(0,5).map((x,i)=>`[${i+1}] ${x.title}\n${(x.content||'').slice(0,300)}\n${x.url}`).join('\n\n')
  }catch(e){console.error('BAIDU_RAW_ERR',e.message);return ''}
}
const server = http.createServer(async (req, res) => {
  // 注意：不要自己设 Access-Control-Allow-Origin。CloudBase Web 函数平台已自动注入
  // 具体 origin（如 https://cheff-...tcloudbaseapp.com），函数再设 '*' 会导致响应头出现
  // 两个值，浏览器报 "contains multiple values" 并拦截整条 fetch。仅保留 methods/headers。
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    let body = ''
    req.on('data', c => body += c)
    await new Promise(r => req.on('end', r))
    const b = JSON.parse(body || '{}')
    const msg = (b.message || '').trim()
    const ctx = b.context || ''
    const deep = parseInt(b.deep) || 0
    const reqModel = b.model || ''
    const useModel = MODEL_KEYS[reqModel] ? reqModel : DEFAULT_MODEL
    const isImage = Array.isArray(b.images) && b.images.length > 0
    let imageUrls = []          // 公网 URL（glm-5v-turbo 用，只收 URL）
    let imageDataUris = []      // Base64 dataURI（kimi-k3 用，只收 Base64、不收公网 URL）
    if (isImage) {
      if (useModel === 'kimi-k3') {
        // kimi-k3 只接受 Base64，不支持公网 URL → 直接透传 dataURI，不上传 Storage
        // 但 kimi 服务端对 webp/gif 会 panic(400)；前端已尽量转 png，此处兜底拦截给友好提示
        const bad = (b.images||[]).filter(u => /^data:image\/(webp|gif)/i.test(u||''))
        if (bad.length) { res.write(`data:${JSON.stringify({error:'kimi-k3 暂不支持 webp/gif 图片，请改用 png/jpg，或切换到其他模型发送'})}\n\n`); return res.end() }
        imageDataUris = b.images
      } else {
        // 其它模型：上传到 Storage 拿公网 URL（glm-5v-turbo 只接受 URL）
        for (const b64 of b.images) {
          const u = await uploadImageB64(b64)
          if (u) imageUrls.push(u)
        }
      }
    }
    const imgList = imageUrls.length ? imageUrls : imageDataUris
    const hasImg = imageUrls.length > 0 || imageDataUris.length > 0
    const effModel = hasImg ? (useModel === 'kimi-k3' ? 'kimi-k3' : 'glm-5v-turbo') : useModel
    const apiModel = effModel.replace('-official', '')
    const key = MODEL_KEYS[effModel] || ''
    const apiUrl = effModel.endsWith('-official') ? DEEPSEEK : TOKENHUB

    // 多轮上下文：system + 历史(最近20条) + 当前用户消息
    const history = Array.isArray(b.history) ? b.history.slice(-20) : []
    const userContent = hasImg
      ? [{type:'text',text:msg||'请描述这张图片'}, ...imgList.map(u=>({type:'image_url',image_url:{url:u}}))]
      : msg
    // 历史对话检索：让 AI 能回忆过往对话（弥补记忆偶尔缺失）
    let chatCtx = ''
    try { chatCtx = await searchChats(msg) } catch(_) {}
    // 系统提示保持静态（不含时间），时间移到 user 消息末尾 → DeepSeek prompt cache 前缀稳定、命中率提升
    const sysContent = SYS_PREFIX + (ctx ? '\n\n记忆:\n'+ctx : '') + (chatCtx ? '\n\n以下是与用户当前话题相关的【历史对话片段】，请据此直接回答关于过往对话的问题，不要说你无法查看历史：\n'+chatCtx : '')
    let userContent2 = userContent
    if (hasImg) {
      userContent2 = [{type:'text',text:(msg||'请描述这张图片')+'\n[当前时间: '+bjNow()+']'}, ...imgList.map(u=>({type:'image_url',image_url:{url:u}}))]
    } else {
      userContent2 = msg + '\n[当前时间: '+bjNow()+']'
    }
    const msgs = [{role:'system',content:sysContent}, ...history, {role:'user',content:userContent2}]
    const apiBody = { model: apiModel, messages: msgs, temperature: 0.7, stream: true, max_tokens: MAX_OUTPUT_TOKENS, stream_options: { include_usage: true } }
    if (deep) apiBody.thinking = { type: 'enabled' }
    if (deep === 2) apiBody.reasoning_effort = 'high'

    // kimi-k3 适配：文档明确禁传 thinking；reasoning_effort 仅支持 "max"；
    // 输出 token 参数用 max_completion_tokens（非 max_tokens）；temperature 固定，不显式传。
    if (apiModel === 'kimi-k3') {
      delete apiBody.thinking
      delete apiBody.temperature
      delete apiBody.max_tokens
      apiBody.max_completion_tokens = MAX_OUTPUT_TOKENS
      // 思考深度跟随 deep 档位（与 glm 一致）；绝不用 'max'——max 会让 kimi 先深度思考 100s+ 才出首 token，极易超时。
      // 关键：必须显式传值。kimi 在【不传 reasoning_effort】时会默认进入重度思考（≈max），反而更易超时。
      // kimi 带图时不传 reasoning_effort（否则 400）。
      if (!hasImg) {
        if (deep === 2) apiBody.reasoning_effort = 'high'
        else if (deep === 1) apiBody.reasoning_effort = 'medium'
        else apiBody.reasoning_effort = 'low'
      }
    }

    let r
    try {
      // kimi-k3 的 reasoning 思考时长非确定（medium/high 有时 7s 有时 100s+），故给它更长的超时余量（平台上限 300s）；
      // 其它模型本来快，用 120s 即可（卡死更快触发兜底）。
      const FETCH_TIMEOUT = apiModel === 'kimi-k3' ? 280000 : 120000
      r = await fetch(apiUrl, {
        method: 'POST',
        headers: {'Content-Type':'application/json','Authorization':'Bearer '+key},
        body: JSON.stringify(apiBody),
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })
    } catch (fetchErr) {
      // 主模型请求超时/网络异常（如视觉链路卡死）→ 自动兜底到 DeepSeek 官方 key（纯文字）
      console.error('PRIMARY_FETCH_FAIL', fetchErr && fetchErr.message)
      r = await fallbackFetch()
    }
    // ===== 模型兜底：TokenHub 额度耗尽/限流 → 自动用你的 DeepSeek 官方 key =====
    // 覆盖 401(未授权) / 402(额度用尽) / 429(限流)；并识别 200 但 body 带错误体的异常响应
    // 发图模型触发兜底时不支持图片，降级为纯文字对话，保证"半夜也能聊"
    async function fallbackFetch() {
      let fbMessages = apiBody.messages
      if (isImage) {
        fbMessages = apiBody.messages.map(m => m.role === 'user'
          ? { role:'user', content: (msg || '请描述这张图片') + '\n[图片识别暂时不可用，已转为文字对话]' }
          : m)
      }
      // 兜底模型用 deepseek-v4-flash，重建干净请求体，避免把 kimi 专属参数(max_completion_tokens 等)带过去
      const fbBody = { model: 'deepseek-v4-flash', messages: fbMessages, temperature: 0.7, stream: true, max_tokens: MAX_OUTPUT_TOKENS, stream_options: { include_usage: true } }
      return fetch(DEEPSEEK, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+DEEPSEEK_KEY},
        body: JSON.stringify(fbBody),
        signal: AbortSignal.timeout(60000)
      })
    }

    // 主模型返回 200 但正文为空（usage 却显示消耗了输出 token）时的兜底重试
    async function retryWithDeepseek(messages) {
      try {
        console.log('RETRY_EMPTY_CONTENT')
        const retryBody = { model: 'deepseek-v4-flash', messages, temperature: 0.7, stream: true, max_tokens: MAX_OUTPUT_TOKENS, stream_options: { include_usage: true } }
        const rr = await fetch(DEEPSEEK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
          body: JSON.stringify(retryBody),
          signal: AbortSignal.timeout(60000)
        })
        if (!rr.ok) return { full: null, usage: null }
        const rreader = rr.body.getReader()
        const rdecoder = new TextDecoder()
        let rbuf = '', rfull = '', rusage = null
        while (true) {
          const { done, value } = await rreader.read()
          if (done) break
          rbuf += rdecoder.decode(value, { stream: true })
          const lines = rbuf.split('\n'); rbuf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const rd = line.slice(6).trim()
            if (rd === '[DONE]') continue
            try {
              const rj = JSON.parse(rd)
              const rtoken = rj.choices?.[0]?.delta?.content || ''
              if (rtoken) { rfull += rtoken; res.write(`data:${JSON.stringify({token: rtoken})}\n\n`) }
              if (rj.usage) rusage = rj.usage
            } catch(_) {}
          }
        }
        return { full: rfull, usage: rusage }
      } catch (e) { console.error('RETRY_EMPTY_CONTENT_FAIL', e.message); return { full: null, usage: null } }
    }

    let shouldFallback = false
    if (!effModel.endsWith('-official')) {
      if (r.status === 401 || r.status === 402 || r.status === 429) {
        shouldFallback = true
      } else if (r.status === 200) {
        // 轻量探测：只读首块，1.5s 超时，避免拖垮正常 SSE 流
        try {
          const cr = r.clone(); const cref = cr.body.getReader()
          const probe = await Promise.race([
            cref.read().then(x => new TextDecoder().decode(x.value || new Uint8Array())),
            new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 1500))
          ])
          if (/error/i.test(probe) && /额度|quota|limit|expired|用尽|余额|balance/i.test(probe)) {
            shouldFallback = true
            console.error('FALLBACK_200_ERROR', probe.slice(0, 200))
          }
        } catch (_) {}
      }
    }
    if (shouldFallback) {
      console.error('FALLBACK_TO_DEEPSEEK', r.status)
      r = await fallbackFetch()
    }
    if (!r.ok) { let _up=''; try{const _eb=await r.text();_up=(_eb||'').replace(/\s+/g,' ').slice(0,300)}catch(_){} res.write(`data:${JSON.stringify({error:'API '+r.status+(_up?(': '+_up):'')})}\n\n`); return res.end() }

    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', full = '', reasoning = '', answering = false, lastUsage = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const d = line.slice(6).trim()
        if (d === '[DONE]') continue
        try {
          const j = JSON.parse(d)
          const rtoken = j.choices?.[0]?.delta?.reasoning_content || ''
          const token = j.choices?.[0]?.delta?.content || ''
          if (rtoken) { reasoning += rtoken; res.write(`data:${JSON.stringify({reasoning:rtoken})}\n\n`) }
          if (token) {
            if (!answering) { answering = true; res.write(`data:${JSON.stringify({startAnswer:true})}\n\n`) }
            full += token; res.write(`data:${JSON.stringify({token})}\n\n`)
          }
          if (j.usage) lastUsage = j.usage
        } catch(_){}
      }
    }

    // 保护：主模型返回 200 且 usage 显示有输出 token，但实际正文为空 → 用 DeepSeek 兜底重试一次
    if (!full && lastUsage && lastUsage.completion_tokens > 0) {
      console.log('EMPTY_CONTENT_DETECTED', useModel, lastUsage)
      const retry = await retryWithDeepseek(apiBody.messages)
      if (retry.full) { full = retry.full; if (retry.usage) lastUsage = retry.usage }
    }

    // ===== 搜索：检测模型输出的 [SEARCH:关键词]（结果作为独立卡片返回，不混入正文）=====
    const sm = full.match(/\[SEARCH:(.+?)\]/i)
    if (sm) {
      const sq = sm[1].trim()
      let cleanReply = full.replace(sm[0], '').trim()
      res.write(`data:${JSON.stringify({searching:true, query:sq})}\n\n`)
      let searchResult = '', searchSrc = ''
      // 首选：腾讯 WSA 联网搜索（免费额度优先）
      const wsa = await searchWSA(sq)
      if (wsa) { searchSrc = '腾讯联网搜索'; searchResult = wsa }
      // 次选：百度智能搜索（一次调用直接拿到整合答案）
      if (!searchResult) { searchResult = await searchAndAnswer(sq); if (searchResult) searchSrc = '百度智能搜索' }
      // 兜底：百度 raw 搜索片段
      if (!searchResult) { const sr = await searchWeb(sq); if (sr) { searchSrc = '百度搜索'; searchResult = sr } }
      // 兜底：模型只输出搜索标签、没给正文时，直接用搜索结果作为助手回复，避免空泡
      if (!cleanReply && searchResult) {
        cleanReply = searchResult
        searchResult = '' // 不再额外发独立搜索卡片，避免同内容重复出现
      }
      // 把搜索结果作为独立事件下发，不拼入 full，让前端渲染成独立卡片
      if (searchResult) {
        res.write(`data:${JSON.stringify({searchResult, searchSrc, searchQuery:sq})}\n\n`)
      }
      full = cleanReply  // 正文保持干净，去掉 [SEARCH] 标签
    }

    // ===== 记忆提炼（轻量 · 带纠正能力 · 跳过极短闲聊省 token）=====
    let note = null
    const memMsg = (msg || '').replace(/^\[图片\]$/, '').trim()
    // 降频：仅含记忆信号词或较长有实质内容才提炼，纯闲聊短句跳过 → 省一倍模型调用
    const MEM_SIG = /记住|我叫|我喜欢|我讨厌|纠正|以前说过|我的|我是|我做过|我打算|计划|忘掉|删掉|不要记|观点|看法|认为|经历|去过|买了|定了|打算/.test(memMsg)
    if (memMsg.length >= 4 && (MEM_SIG || memMsg.length >= 30)) {
      try {
        const memR = await fetch(DEEPSEEK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [
              { role: 'system', content: '你是记忆管理器。对比"已有记忆"与"本轮对话"，输出一行纯JSON（不要任何markdown包裹）：{"action":"add"|"update"|"delete"|"none","match":"要修改/删除的旧记忆关键片段(仅update/delete填,用于检索旧记忆)","content":"记忆文本(含准确日期),仅add/update填"}。规则：用户纠正了之前错误信息→action=update且match填旧错误记忆片段；用户说"忘掉/删掉/不要记"某记忆→delete且match填该记忆片段；本轮出现新事实(姓名/喜好/经历/观点/计划)→add；纯闲聊或无变化→none。' },
              { role: 'user', content: '已有记忆:\n' + (ctx || '(无)') + '\n\n本轮:\n用户:' + msg + '\n助手:' + full }
            ],
            temperature: 0, stream: false
          }),
          signal: AbortSignal.timeout(15000)
        })
        if (memR.ok) {
          const mj = await memR.json()
          const raw = (mj.choices?.[0]?.message?.content) || ''
          const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
          const m = JSON.parse(clean)
          if (['add', 'update', 'delete', 'none'].includes(m.action)) {
            if (m.content && typeof m.content !== 'string') m.content = JSON.stringify(m.content)
            if (m.match && typeof m.match !== 'string') m.match = String(m.match)
            note = m
          }
        }
      } catch (_) {}
    }

    // 后端直写记忆库（杜绝前端版本差异把 note 对象存成脏数据）
    let memResult = { status: 'none', info: '' }
    if (note && note.action && note.action !== 'none') {
      memResult = await applyMemoryBackend(note)
    }
    res.write(`data:${JSON.stringify({done:true,model:useModel,full,reasoning,note,noteStatus:memResult.status,noteInfo:String(memResult.info||''),usage:lastUsage})}\n\n`)
    res.end()
  } catch(e) { res.write(`data:${JSON.stringify({error:e.message})}\n\n`); res.end() }
})

server.listen(9000, () => console.log('chat-stream ready'))
