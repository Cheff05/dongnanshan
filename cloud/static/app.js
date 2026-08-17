const VERSION='20260817f';
console.log('[枢衡殿] UI v'+VERSION);
import cloudbase from 'https://esm.sh/@cloudbase/js-sdk@3.7.1';
const ENV='YOUR_CLOUDBASE_ENV_ID';
const chatEl=document.getElementById('chat'),input=document.getElementById('input');
const sendBtn=document.getElementById('send'),deepToggle=document.getElementById('deepToggle');
const btnHist=document.getElementById('btnHist'),btnMem=document.getElementById('btnMem');
const histPanel=document.getElementById('histPanel'),memPanel=document.getElementById('memPanel');
const imgBtn=document.getElementById('imgBtn'),imgInput=document.getElementById('imgInput');
let app,db,ready=false,memoryText='',currentDate='',pendingImages=[];
let _model='glm-5.1',_speechOn=false;
// 全局兜底：避免任何单次渲染异常直接把整页打挂成"连接失败"
window.addEventListener('error',e=>{try{const m=(e&&(e.message||e.filename))||'runtime error';console.error('[枢衡殿] runtime error:',m);reportLog('error',m,{stack:(e&&e.error&&e.error.stack)||''});}catch(_){}});
window.addEventListener('unhandledrejection',e=>{try{const m=String((e&&(e.reason&&e.reason.message))||e.reason||'unhandled');console.error('[枢衡殿] unhandled:',m);reportLog('error',m);}catch(_){}});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModals();closeSess();}});
let _history=[];  // 当前会话的滚动对话历史（仅文本），发给后端做多轮上下文
let currentSid=null; // 当前会话 sid（null=未分组的默认视图）

// 日志上报：直写 logs 集合，便于远程排查（匿名写入，类比 chats）
async function reportLog(level,msg,extra){
  if(!db)return;
  try{
    await db.collection('logs').add({level:String(level||'info'),msg:String(msg||'').slice(0,500),extra:extra?JSON.stringify(extra).slice(0,500):'',ua:navigator.userAgent.slice(0,200),v:VERSION,t:Date.now()});
  }catch(_){}
}

function bjDate(){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/\//g,'-')}
function bjTime(){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}

function addEl(cls,text){const d=document.createElement('div');d.className=cls;if(text)d.textContent=text;chatEl.appendChild(d);return d}
function scrollDown(){chatEl.scrollTop=chatEl.scrollHeight}

// 打字机效果
async function typewriter(el,text){
  el.innerHTML='';let i=0;const chars=[...text];
  function tick(){
    if(i>=chars.length)return;
    el.innerHTML=md(chars.slice(0,i+1).join(''));
    scrollDown();i++;
    if(i%4===0){setTimeout(tick,8)}else{requestAnimationFrame(tick)}
  }
  tick();
  await new Promise(r=>{const fin=setInterval(()=>{if(i>=chars.length){clearInterval(fin);r()}},50)});
}

// HTML escape helper
function escapeHtml(t){const s=(t===undefined||t===null)?'':String(t);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

// Markdown render（支持：代码块/行内代码/加粗/标题/链接/表格/有序无序列表/段落换行）
function md(t){
  if(t===undefined||t===null||t==='')return '';
  const src=escapeHtml(String(t)).replace(/\r\n/g,'\n');
  const lines=src.split('\n');
  const out=[];
  let para=[], listType=null, listBuf=[];
  const inline=s=>(s==null?'':String(s))
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$1" target="_blank" rel="noopener">$2</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const splitRow=r=>r.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(c=>c.trim());
  const flushPara=()=>{ if(para.length){ out.push('<p>'+para.join('<br>')+'</p>'); para=[]; } };
  const flushList=()=>{ if(listBuf.length){ out.push('<'+listType+'>'+listBuf.map(x=>'<li>'+inline(x)+'</li>').join('')+'</'+listType+'>'); listBuf=[]; listType=null; } };
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(/^```/.test(line)){ flushPara(); flushList(); const buf=[]; i++; while(i<lines.length&&!/^```/.test(lines[i])){ buf.push(lines[i]); i++; } i++; out.push('<pre><code>'+buf.join('\n')+'</code></pre>'); continue; }
    // 表格：当前行含 | 且下一行是 | --- | 分隔行
    if(line.includes('|')&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])&&lines[i+1].includes('-')){
      flushPara(); flushList();
      const head=splitRow(line); i+=2;
      const rows=[];
      while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()!==''){ rows.push(splitRow(lines[i])); i++; }
      let tbl='<table><thead><tr>'+head.map(h=>'<th>'+inline(h)+'</th>').join('')+'</tr></thead><tbody>';
      for(const r of rows) tbl+='<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>';
      tbl+='</tbody></table>'; out.push(tbl); continue;
    }
    const h=line.match(/^#{1,4}\s+(.*)$/);
    if(h){ flushPara(); flushList(); const lv=h[1].length; out.push('<h'+lv+'>'+inline(h[2])+'</h'+lv+'>'); i++; continue; }
    const ul=line.match(/^\s*[-*]\s+(.*)$/);
    if(ul){ flushPara(); if(listType!=='ul'){ flushList(); listType='ul'; } listBuf.push(ul[1]); i++; continue; }
    const ol=line.match(/^\s*\d+\.\s+(.*)$/);
    if(ol){ flushPara(); if(listType!=='ol'){ flushList(); listType='ol'; } listBuf.push(ol[1]); i++; continue; }
    if(line.trim()===''){ flushPara(); flushList(); i++; continue; }
    flushList(); para.push(inline(line)); i++;
  }
  flushPara(); flushList();
  return out.join('');
}

// Panel toggle
window.togglePanel=function(id){
  const p=document.getElementById(id);
  p.style.display=p.style.display==='block'?'none':'block';
};

// Speech
window.toggleSpeech=function(){
  const btn=document.getElementById('btnSpeech');
  _speechOn=btn.classList.contains('on');
  btn.textContent=_speechOn?'🔊':'🔇';
};
function speak(text){
  if(!_speechOn)return;
  const safe=text==null?'':String(text);
  const u=new SpeechSynthesisUtterance(safe.replace(/\[SEARCH:.+?\]/gi,'').replace(/[*_`#\[\]]/g,''));
  u.lang='zh-CN';u.rate=1.05;
  speechSynthesis.speak(u);
}

// 输入框自适应高度 + 展开大输入区
function autoGrow(){
  input.style.height='auto';
  const max=input.classList.contains('expanded')?window.innerHeight*0.74:160;
  input.style.height=Math.min(input.scrollHeight,max)+'px';
}
input.addEventListener('input',autoGrow);
function fitMobilePlaceholder(){input.placeholder=window.innerWidth<=600?'说点什么…':'说点什么…（Enter 发送，Shift+Enter 换行）';}
fitMobilePlaceholder();window.addEventListener('resize',fitMobilePlaceholder);
window.toggleExpand=function(){
  const big=input.classList.toggle('expanded');
  const b=document.getElementById('expandBtn');
  b.textContent=big?'⤡':'⤢';
  b.classList.toggle('on',big);
  autoGrow();
  if(big)input.focus();
};

// Set deep thinking
window.setDeep=function(lv){
  document.getElementById('deepPanel').style.display='none';
  deepToggle.dataset.level=lv;
  const colors=['var(--muted)','#e8a838','var(--accent)','#e23c3c'];
  const labels=['','轻','深','M'];
  deepToggle.style.color=colors[lv];
  deepToggle.classList.toggle('on',lv>0);
  deepToggle.textContent='⚡'+(labels[lv]||'');
};

// Set model
window.setModel=function(m){
  document.getElementById('modelPanel').style.display='none';
  document.getElementById('btnModel').textContent=m+' ▾';
  _model=m;
  const dp=document.getElementById('deepPanel');
  if(m.startsWith('deepseek')||m.startsWith('glm-5.2')){
    dp.innerHTML='<div class="item" style="color:var(--muted)" onclick="setDeep(0)">关闭思考</div><div class="item" style="color:#e8a838" onclick="setDeep(1)">🟡 轻量</div><div class="item" style="color:var(--accent)" onclick="setDeep(2)">🟢 深度</div><div class="item" style="color:#e23c3c" onclick="setDeep(3)">🔴 Max</div>';
  }else{
    dp.innerHTML='<div class="item" style="color:var(--muted)" onclick="setDeep(0)">关闭思考</div><div class="item" style="color:var(--accent)" onclick="setDeep(1)">🟢 开启</div>';
  }
};
document.getElementById('btnModel').textContent='glm-5.1 ▾';

// Quick re-send with different model
function quickRetry(msg){input.value=msg;input.focus();sendBtn.click()}

// Error display
function showError(el,code,msg,stack,lastMsg){
  el.className='err-box';
  let html='';
  if(code===1){
    if(msg.includes('402')) html='<strong>额度用完了</strong> — 切换模型重试';
    else if(msg.includes('401')) html='<strong>Key 失效</strong> — 检查 API 配置';
    else if(msg.includes('timeout')||msg.includes('Abort')) html='<strong>请求超时</strong> — 网络或模型响应慢';
    else html='<strong>错误：</strong>'+msg;
  }else{
    html='<strong>请求失败：</strong>'+msg;
  }
  if(stack)html+='<div style="font-size:10px;opacity:.6;margin-top:4px">'+stack+'</div>';
  html+='<div class="quick-row">';
  html+='<button onclick="this.closest(\'.err-box\').remove()">关闭</button>';
  html+='<button onclick="input.value=\''+(lastMsg||'').replace(/'/g,"\\'")+'\';sendBtn.click()">🔄 重试</button>';
  html+='<button onclick="document.getElementById(\'modelPanel\').style.display=\'block\'">📋 换模型</button>';
  html+='</div>';
  el.innerHTML=html;
}

// Chat loading with pagination
async function loadDay(date){
  currentDate=date;
  btnHist.textContent=date===bjDate()?'历史':date;
  chatEl.innerHTML='<div class="hint">加载中…</div>';
  const res=await db.collection('chats').where({date}).orderBy('ts','asc').limit(500).get();
  chatEl.innerHTML='';
  const allData = res.data || [];
  if(allData.length){
    let lastTime='';
    for(const r of allData){
      if(r.time!==lastTime){addEl('divider',r.time);lastTime=r.time}
      const el=addEl('msg '+r.who);
      el.innerHTML=r.who==='ai'?md(r.text||''):(r.text||'');
    }
    scrollDown();
    // 如果满 500 条，加「加载更多」按钮
    if(allData.length>=500){
      const more=document.createElement('div');
      more.style.cssText='text-align:center;color:var(--accent);font-size:13px;padding:10px;cursor:pointer;margin-top:8px';
      more.textContent='↓ 加载更早的消息';
      let offset=500;
      more.onclick=async()=>{
        more.textContent='加载中…';
        const r2=await db.collection('chats').where({date}).orderBy('ts','asc').skip(offset).limit(500).get();
        const newData=r2.data||[];
        if(newData.length){
          let lastTime2='';
          const frag=document.createDocumentFragment();
          for(const r of newData){
            if(r.time!==lastTime2){const d=document.createElement('div');d.className='divider';d.textContent=r.time;frag.appendChild(d);lastTime2=r.time}
            const el=document.createElement('div');el.className='msg '+r.who;el.innerHTML=r.who==='ai'?md(r.text):r.text;
            frag.appendChild(el);
          }
          more.before(frag);
          offset+=newData.length;
          if(newData.length<500)more.remove();
          else more.textContent='↓ 加载更早的消息';
        }else{more.textContent='已到最早记录';more.style.color='var(--muted)';more.style.cursor='default'}
      };
      chatEl.appendChild(more);
    }
  }else{addEl('hint','当天没有对话')}
}

async function loadDates(){
  const res=await db.collection('chats').orderBy('ts','desc').limit(2000).get();
  const dates=[...new Set((res.data||[]).map(r=>r.date))].sort().reverse();
  const box=document.getElementById('histBody');
  box.innerHTML='';
  if(!dates.length){box.innerHTML='<div class="mem-empty">暂无记录</div>';return}
  for(const d of dates){
    const el=document.createElement('div');
    el.className='hist-date';el.innerHTML='<span>'+d+'</span><span>›</span>';
    el.onclick=()=>{closeModals();loadDay(d)};
    box.appendChild(el);
  }
}

async function saveChat(who,text,time,sid){
  try{
    const res=await db.collection('chats').add({who,text,time,date:bjDate(),ts:Date.now(),...(sid?{sid}:{})});
    return res.id||'';
  }catch(e){
    const b=JSON.parse(localStorage.getItem('chat_backup')||'[]');
    b.push({who,text,time,date:bjDate(),ts:Date.now()});
    localStorage.setItem('chat_backup',JSON.stringify(b.slice(-500)));
    return'local-'+Date.now();
  }
}

  function mc(c){if(c===undefined||c===null||c==='')return'';return typeof c==='string'?c:JSON.stringify(c);}
  async function loadMemories(){
    const res=await db.collection('memories').orderBy('ts','desc').limit(500).get();
    window._allMemories=(res.data||[]).map(m=>({...m,content:mc(m.content)}));
    memoryText=buildContext(''); // 初始：核心+近期
  }

  // 智能记忆筛选 v2：分层上限已调高 + 匹配阈值放宽 + 最低上下文地板（目标单次≤10k token）
  const CORE_KEYS=['靖康','国光','枢衡殿','衣冠南渡','莫斯提马','特蕾西娅','落落','大土豆','S酱','网暴','光复','鹰派','鸽派','蟑螂','绍兴议和','万重山'];
  // 关键人物/事件：轻量钉常驻（B方案）。落落/苏苏等用户极重视的人，曾因"核心层按时间排序+容量25"被挤掉，导致"想不起重要的人"。v20260814c 起改为每实体只钉 1 条最具信息量的记忆（截断 PIN_ONE_CAP 字），固定输入从~8k降到~1k，既保留自主联想锚点，又不再当电老虎。
  const KEY_ENTITIES=['落落','苏苏','鸢凉','大土豆','片片','林','QQ','靖康事变','网暴事变','特蕾西娅','莫斯提马'];
  const PIN_ONE_CAP=150; // 每实体钉死锚点的最大字数，控制固定输入体量
  const LAYER_CAP={0:25,1:35,2:45}; // 核心≤25, 近期≤35, 检索≤45（总上限105，约5~6k token）
  const MIN_CTX=40;                 // 放宽阈值：召回不足40条时，用最近记忆补齐到40，防模型"失忆"
  // 中文友好的关键词提取：CJK 滑窗 2/3 字 n-gram + 英文/数字 3+，过滤常见停用词（解决按空格切词 & 整句当一个 token 的问题）
  const KW_STOP=new Set(['我们','之前','聊过','你们','他们','这个','那个','什么','怎么','现在','时候','知道','觉得','因为','所以','可以','已经','一下','关于','如果','但是','就是','这样','那样','不是','没有','一个','这种','那种','自己','真的','还是','选择','记得','帮我','想问']);
  function kw(text){
    const t=(text||'').toLowerCase().replace(/[\s\p{P}]/gu,'');
    const grams=[];
    for(const run of (t.match(/[\u4e00-\u9fff]+/g)||[])){
      for(const n of [2,3]) for(let i=0;i+n<=run.length;i++) grams.push(run.slice(i,i+n));
    }
    const en=(t.match(/[a-z0-9]{3,}/g)||[]);
    return [...new Set([...grams,...en])].filter(w=>!KW_STOP.has(w));
  }
  function buildContext(userMsg){
    const all=(window._allMemories||[]).map(m=>({...m,content:mc(m.content)}));
    const seen=new Set(); const layers=[[],[],[]]; const priority=[]; const pinnedMap=new Map();
    const now=Date.now(), recentWin=7*86400000;
    const userWords=kw(userMsg); // 中文按 CJK 片段提取，而非按空格切词
    // 关键人物/事件轻量钉（B方案）：每实体只取 1 条最具信息量的记忆作联想锚点，截断到 PIN_ONE_CAP 字；不再各取5条，避免固定输入膨胀
    for(const ent of KEY_ENTITIES){
      let best=null;
      for(const m of all){
        if(m.content.includes(ent)){
          const cand = m.content.length>PIN_ONE_CAP ? {...m, content:m.content.slice(0,PIN_ONE_CAP)} : m;
          if(!best || cand.content.length>best.content.length) best=cand;
        }
      }
      if(best){
        const key=(best.content||'').slice(0,40);
        if(!pinnedMap.has(key)) pinnedMap.set(key,best);
      }
    }
    for(const m of all){
      const sid=(m.content||'').slice(0,30);
      if(seen.has(sid))continue; // 去重
      if(pinnedMap.has((m.content||'').slice(0,40)))continue; // 已钉死，跳过后层
      // 用户关键词命中 → 强制召回，不受任何层容量限制（解决"点名的人/事被核心层挤掉"的坑）
      if(userWords.length && userWords.some(w=>m.content.includes(w))){
        if(priority.length>=30) { seen.add(sid); continue; } // 防极端膨胀
        seen.add(sid); priority.push(m); continue;
      }
      let layer=-1;
      if(CORE_KEYS.some(k=>m.content.includes(k)))layer=0;
      else if((now-m.ts)<recentWin)layer=1;
      if(layer<0)continue;                                // 完全不命中 → 先不注入
      if(layers[layer].length>=LAYER_CAP[layer])continue; // 该层已满，截断
      seen.add(sid);layers[layer].push(m);
    }
    // 合并：钉死常驻 → 用户点名 → 核心 → 近期，去重
    const result=[]; const added=new Set();
    for(const m of pinnedMap.values()){
      const key=(m.content||'').slice(0,40);
      if(!added.has(key)){added.add(key);result.push(m);}
    }
    for(const m of priority){
      const key=(m.content||'').slice(0,40);
      if(!added.has(key)){added.add(key);result.push(m);}
    }
    for(const layer of layers){
      for(const m of layer){
        const key=(m.content||'').slice(0,40);
        if(!added.has(key)){added.add(key);result.push(m);}
      }
    }
    // 放宽匹配阈值：若召回偏少（如全新话题无关键词命中），用最近记忆补齐到 MIN_CTX，保证最低上下文
    if(result.length<MIN_CTX){
      for(const m of all){
        const key=(m.content||'').slice(0,40);
        if(added.has(key))continue;
        added.add(key);result.push(m);
        if(result.length>=MIN_CTX)break;
      }
    }
    return result.map(r=>r.content).reverse().join('\n\n');
  }

  async function saveMemory(content){
    if(content&&typeof content!=='string')content=JSON.stringify(content);
    if(!content||content.length>500)return;
    const obj={content,date:bjDate(),ts:Date.now()};
    try{const res=await db.collection('memories').add(obj);obj._id=(res&&(res._id||res.id))||undefined;}catch(_){}
    window._allMemories.unshift(obj);
    addEl('note','已记住：'+content);scrollDown();
  }
  // 记忆已由后端直写库；前端只做展示提示 + 刷新本地列表（不再写库，杜绝任何前端版本写出脏数据）
  // noteStatus: added/updated/deleted/failed/none/skipped；noteInfo: 后端截断后的提示文本
  async function applyMemoryDisplay(note, status, info){
    if(!note && !info) return;
    const labels = { added:'已记住：', updated:'已更正记忆：', deleted:'已删除记忆：', failed:'[记忆写入失败]' };
    if(status && labels[status]){
      addEl('note', labels[status] + String(info||'').slice(0,40));
      scrollDown();
    }
    await loadMemories(); // 刷新本地记忆列表，确保面板/上下文/检索一致
  }

function renderMemPanel(){
  const filter=(document.getElementById('memFilter').value||'').trim();
  const kws=filter?kw(filter):[]; // 复用 AI 召回同款 n-gram 中文分词，保证"记忆查询"与"对话搜索"关键词行为一致
  // 关键词匹配：多关键词 OR（命中任一即召回），按命中数量排序（命中越多的越靠前）；中文走 n-gram，支持"苏苏""摄影"等片段命中
  let items=(window._allMemories||[]).map(r=>({r,c:mc(r.content)}));
  if(kws.length){
    items=items.map(x=>{
      const cl=x.c.toLowerCase(); let score=0;
      for(const k of kws){ if(cl.includes(k)) score++; }
      return {...x,score};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  } else if(filter){
    // 全是停用词等导致 kw 为空时，退化为不区分大小写的整串包含，保证仍可用
    const fl=filter.toLowerCase();
    items=items.filter(x=>x.c.toLowerCase().includes(fl));
  }
  const body=document.getElementById('memBody'),cnt=document.getElementById('memCount');
  cnt.textContent=items.length+' 条记忆';
  if(!items.length){body.innerHTML='<div class="mem-empty">'+(filter?'没有匹配的记忆':'还没有记住的内容')+'</div>';return}
  const re = kws.length ? new RegExp('('+kws.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi') : null;
  body.innerHTML=items.map(x=>{
    const safe=x.c.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const hl = re ? safe.replace(re,m=>'<mark>'+m+'</mark>') : safe;
    const r=x.r;
    return '<div class="mem-item" data-id="'+r._id+'">'
      +'<div class="mem-top"><span class="mem-date">'+r.date+'</span>'
      +'<span class="mem-acts"><span class="mem-edit" data-id="'+r._id+'">✎</span><span class="mem-del" data-id="'+r._id+'">×</span></span></div>'
      +'<div class="mem-txt" id="txt_'+r._id+'">'+hl+'</div></div>';
  }).join('');
  body.querySelectorAll('.mem-del').forEach(b=>b.onclick=async()=>{
    await db.collection('memories').doc(b.dataset.id).remove();await loadMemories();renderMemPanel();
  });
  body.querySelectorAll('.mem-edit').forEach(b=>b.onclick=()=>{
    const id=b.dataset.id;const txtEl=document.getElementById('txt_'+id);
    const cur=mc((window._allMemories.find(x=>x._id===id)||{}).content);
    txtEl.innerHTML='<textarea class="mem-ta">'+cur.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</textarea>'
      +'<div class="mem-edit-acts"><button class="mem-sv" data-id="'+id+'">保存</button><button class="mem-cn" data-id="'+id+'">取消</button></div>';
    txtEl.querySelector('.mem-sv').onclick=async()=>{await db.collection('memories').doc(id).update({content:txtEl.querySelector('textarea').value});await loadMemories();renderMemPanel();};
    txtEl.querySelector('.mem-cn').onclick=()=>renderMemPanel();
  });
}

window.openHist=async function(){
  showModal('histPanel');
  await loadDates();
};
window.openMem=async function(){
  showModal('memPanel');
  document.getElementById('memFilter').value='';
  const res=await db.collection('memories').orderBy('ts','desc').limit(500).get();
  window._allMemories=(res.data||[]).map(m=>({...m,content:mc(m.content)}));
  renderMemPanel();
};
window.closeModals=function(){
  document.getElementById('uiMask').style.display='none';
  document.getElementById('histPanel').style.display='none';
  document.getElementById('memPanel').style.display='none';
  const sd=document.getElementById('sessDrawer');if(sd)sd.style.display='none';
};
function showModal(id){
  document.getElementById('uiMask').style.display='block';
  document.getElementById('histPanel').style.display='none';
  document.getElementById('memPanel').style.display='none';
  document.getElementById(id).style.display='flex';
}

// ===== 会话列表（sessions 集合，加法式，不破坏按日期历史）=====
window.openSess=async function(){
  document.getElementById('uiMask').style.display='block';
  document.getElementById('sessDrawer').style.display='flex';
  await renderSessions();
};
window.closeSess=function(){
  const sd=document.getElementById('sessDrawer');
  if(sd)sd.style.display='none';
  if(document.getElementById('histPanel').style.display!=='flex'&&document.getElementById('memPanel').style.display!=='flex')document.getElementById('uiMask').style.display='none';
};
window.newSession=async function(){
  try{
    const sid='s'+Date.now();
    await db.collection('sessions').add({sid,title:'新会话',createdAt:Date.now(),updatedAt:Date.now(),date:bjDate()});
    currentSid=sid;
    chatEl.innerHTML='<div class="hint">新会话已开始</div>';
    _history=[];
    await renderSessions();
    reportLog('session_new','',{sid});
  }catch(e){
    chatEl.innerHTML='<div class="hint">新会话已开始</div>';_history=[];
  }
};
async function renderSessions(){
  const box=document.getElementById('sessBody');
  if(!box)return;
  try{
    const res=await db.collection('sessions').orderBy('updatedAt','desc').limit(100).get();
    const list=(res.data||[]);
    if(!list.length){box.innerHTML='<div class="mem-empty">还没有会话，点上方「＋ 新会话」</div>';return}
    box.innerHTML='';
    for(const s of list){
      const el=document.createElement('div');
      el.className='sess-item'+(s.sid===currentSid?' on':'');
      const acts=document.createElement('div');acts.className='sess-acts';
      acts.innerHTML='<span class="sess-ren" title="重命名">✎</span><span class="sess-del" title="删除">×</span>';
      acts.querySelector('.sess-ren').onclick=(ev)=>{ev.stopPropagation();const t=prompt('会话标题',s.title||'');if(t){db.collection('sessions').doc(s._id).update({title:t});renderSessions();}};
      acts.querySelector('.sess-del').onclick=(ev)=>{ev.stopPropagation();if(confirm('删除该会话及其消息？')){db.collection('sessions').doc(s._id).remove();db.collection('chats').where({sid:s.sid}).remove();if(currentSid===s.sid)currentSid=null;renderSessions();}};
      el.appendChild(acts);
      el.insertAdjacentHTML('afterbegin','<div class="sess-title">'+escapeHtml(s.title||'会话')+'</div><div class="sess-sub">'+(s.date||'')+'</div>');
      el.onclick=()=>switchSession(s.sid);
      box.appendChild(el);
    }
  }catch(e){box.innerHTML='<div class="mem-empty">加载失败</div>'}
}
async function switchSession(sid){
  currentSid=sid;_history=[];
  chatEl.innerHTML='<div class="hint">加载中…</div>';
  try{
    const res=await db.collection('chats').where({sid}).orderBy('ts','asc').limit(500).get();
    chatEl.innerHTML='';
    const allData=res.data||[];
    if(allData.length){let lastTime='';for(const r of allData){if(r.time!==lastTime){addEl('divider',r.time);lastTime=r.time}const el=addEl('msg '+r.who);el.innerHTML=r.who==='ai'?md(r.text||''):(r.text||'');}scrollDown();}
    else addEl('hint','还没有消息');
  }catch(e){addEl('hint','加载失败')}
  closeSess();
}

document.addEventListener('click',e=>{
  if(!document.getElementById('deepPanel').contains(e.target)&&e.target!==deepToggle)document.getElementById('deepPanel').style.display='none';
  if(!document.getElementById('modelPanel').contains(e.target)&&e.target!==document.getElementById('btnModel'))document.getElementById('modelPanel').style.display='none';
});

// Keyboard adaptation
if(window.visualViewport)window.visualViewport.addEventListener('resize',()=>{
  const h=window.innerHeight-window.visualViewport.height;
  document.querySelector('footer').style.paddingBottom=(h>0?h:0)+'px';
  if(h>0)setTimeout(()=>input.scrollIntoView({block:'nearest'}),100);
});

// Init
(async function(){
  try{
    app=cloudbase.init({env:ENV});
    await app.auth().signInAnonymously();
    db=app.database();
    await loadMemories();
    await loadDay(bjDate());
    ready=true;
  }catch(e){
    console.error('[枢衡殿] init error:',e);
    const em=e.message||'';
    try{reportLog('init_error',em,{stack:(e.stack||String(e)).split('\n').slice(0,5).join('\n')});}catch(_){}
    const stack=(e.stack||String(e)).split('\n').slice(0,5).join('\n');
    if(em.includes('network')||em.includes('fetch'))chatEl.innerHTML='<div class="hint">网络连接失败，刷新重试</div>';
    else if(em.includes('auth'))chatEl.innerHTML='<div class="hint">登录失败，检查匿名登录是否开启</div>';
    else chatEl.innerHTML='<div class="hint" style="white-space:pre-wrap;font-size:11px;text-align:left">连接失败：'+escapeHtml(em)+'\n\n'+escapeHtml(stack)+'</div>';
  }
})();

// Send message
async function sendMsg(){
  if(!ready||currentDate!==bjDate()){await loadDay(bjDate());_history=[]}
  const msg=input.value.trim();if(!msg)return;
  input.value='';input.classList.remove('expanded');input.style.height='auto';
  const eb=document.getElementById('expandBtn');eb.textContent='⤢';eb.classList.remove('on');
  sendBtn.disabled=true;
  const time=bjTime();
  addEl('divider',time);
  const msgEl=addEl('msg user',msg||'[图片]');
  const undoBtn=document.createElement('span');
  undoBtn.className='undo';undoBtn.textContent='×';undoBtn.title='撤回';
  msgEl.appendChild(undoBtn);
  const nImg=pendingImages.length;
  for(const src of pendingImages){
    const img=document.createElement('img');
    img.className='msg-img';img.src=src;
    chatEl.appendChild(img);
  }
  const chatId=await saveChat('user',msg,time,currentSid||undefined);
  undoBtn.onclick=async()=>{
    try{await db.collection('chats').doc(chatId).remove()}catch(_){}
    msgEl.remove();
    if(nImg){const imgs=chatEl.querySelectorAll('.msg-img');for(let k=0;k<nImg;k++){const last=imgs[imgs.length-1-k];if(last)last.remove();}}
  };
  const waitEl=addEl('msg ai');waitEl.textContent='…';
  let _waitTimer=null,_abortCtrl=null,_streamOk=false,_streamFinished=false,_lastTokenAt=0,_lastHiddenAt=0,_bgAbort=false;
  try{
      let d=null;
      const t0=performance.now();let tFirst=null;let meta=null;
      // 慢模型（kimi/glm-5.3）首 token 可能 30s+，显示实时计时避免"像卡死"
      const _slowModel=(_model==='kimi-k3'||_model==='glm-5.3');
      _waitTimer=setInterval(()=>{ if(!tFirst){ const s=Math.floor((performance.now()-t0)/1000); waitEl.textContent='⏳ 思考中… '+s+'s'+(_slowModel?'（模型较慢，请稍候）':''); } },1000);
      const payload={message:msg,context:buildContext(msg),history:_history.slice(-20),images:pendingImages.length?pendingImages:undefined,deep:(parseInt(deepToggle.dataset.level)||0),model:_model||undefined};
      _abortCtrl=new AbortController();
      function onVisibility(){
        // 仅真·移动端（手机/平板 UA）启用后台 abort；桌面浏览器（含触屏笔记本，pointer:coarse 会误判）切标签不会冻结 fetch，绝不误杀活连接
        const _isMobile=/Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS|Harmony/i.test(navigator.userAgent);
        if(!_isMobile) return;
        if(document.hidden){
          _lastHiddenAt=Date.now();
        }else if(_abortCtrl && !_streamFinished && sendBtn.disabled && _lastHiddenAt){
          const gone=Date.now()-_lastHiddenAt;
          if(gone>4000){ _bgAbort=true; try{_abortCtrl.abort();}catch(_){} }
        }
      }
      document.addEventListener('visibilitychange',onVisibility);
      try{
        const resp=await fetch('https://YOUR_CLOUDBASE_API_HOST/chat-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:_abortCtrl.signal});
        if(resp.ok){
          _streamOk=true;
          const reader=resp.body.getReader();
          const decoder=new TextDecoder();let buf='',full='';
          waitEl.textContent='';
          let reasoning='',reasoningBox=null,reasoningFolded=false;
          while(true){
            const{value,done}=await reader.read();if(done)break;
            _lastTokenAt=Date.now();
            buf+=decoder.decode(value,{stream:true});
            const lines=buf.split('\n');buf=lines.pop();
            for(const line of lines){
              if(!line.startsWith('data:'))continue;
              const raw=line.slice(5).trim();
              try{const j=JSON.parse(raw);
                if(j.reasoning){
                  reasoning+=j.reasoning;
                  if(!reasoningBox){
                    reasoningBox=document.createElement('div');
                    reasoningBox.className='reasoning-box';
                    reasoningBox.dataset.folded='0';
                    reasoningBox.title='点击展开/折叠思考过程';
                    chatEl.insertBefore(reasoningBox,waitEl.nextSibling);
                  }
                  if(!reasoningFolded){
                    reasoningBox.innerHTML='<span class="r-emoji">🧠</span><span class="r-body">'+escapeHtml(reasoning)+'</span>';
                  }
                  scrollDown(); // 长思考阶段保持思考框在视野内，避免"像卡死"
                }
                if(j.startAnswer&&reasoningBox){
                  reasoningFolded=true;
                  reasoningBox.dataset.folded='1';
                  reasoningBox.innerHTML='<span class="r-emoji">🧠</span><span class="r-hint">思考过程（点击展开）</span>';
                  reasoningBox.onclick=function(){
                    const folded=this.dataset.folded==='1';
                    if(folded){
                      this.dataset.folded='0';
                      this.innerHTML='<span class="r-emoji">🧠</span><span class="r-body">'+escapeHtml(reasoning)+'</span>';
                    }else{
                      this.dataset.folded='1';
                      this.innerHTML='<span class="r-emoji">🧠</span><span class="r-hint">思考过程（点击展开）</span>';
                    }
                  };
                }
                if(j.token){if(!tFirst){tFirst=performance.now();if(_waitTimer)clearInterval(_waitTimer);}full+=j.token;waitEl.innerHTML=md(full);scrollDown()}
                if(j.searching){waitEl.innerHTML=md(full+'\n\n_🔍 搜索中…_');scrollDown()}
                if(j.searchResult){
                  // 搜索结果作为独立卡片渲染，不混入正文
                  const replyClean=String(full).replace(/\[SEARCH:.+?\]/gi,'').trim();
                  waitEl.innerHTML=md(replyClean);
                  const card=document.createElement('div');card.className='search-card';
                  card.innerHTML='<div class="search-card-hd">'+(j.searchSrc||'搜索')+' · '+escapeHtml(j.searchQuery||'')+'</div><div class="search-card-body">'+md(j.searchResult||'')+'</div>';
                  chatEl.insertBefore(card,waitEl.nextSibling);
                  scrollDown();
                }
                if(j.done){_streamFinished=true;meta={think:tFirst?((tFirst-t0)/1000):0,total:((performance.now()-t0)/1000),usage:j.usage||null};d={code:0,data:{reply:(j.full||full||''),model:j.model,note:j.note||null,noteStatus:j.noteStatus||'extracted',reasoning:'',noteInfo:j.noteInfo||'',usage:j.usage||null}}}
                if(j.error){_streamFinished=true;d={code:1,message:j.error}}
              }catch(e){}
            }
          }
        }else{
          // HTTP 错误（如 401/402/429），把上游错误体透出来
          const txt=await resp.text().catch(()=>'');
          d={code:1,message:`HTTP ${resp.status}: ${txt.slice(0,200)}`};
        }
      }catch(err){
        if(_bgAbort) throw {bgAbort:true};
        // 网络/解析错误，交给兜底函数
        d=null;
      }
      if(_waitTimer)clearInterval(_waitTimer);
      document.removeEventListener('visibilitychange',onVisibility);
      // 流式失败或未完成的兜底
      if(!_streamFinished || !d){
        const r=await app.callFunction({name:'chat',data:payload});
        d=(r&&r.result)||{};
        _streamOk=false;
      }
    pendingImages=[];renderImgPreview();
    if(d.code===0){
      const reply=(d.data&&d.data.reply)||'';
      const suffix=d.data&&d.data.noteStatus==='failed'?'\n\n[提炼失败]':'';
      if(!reply){
        waitEl.innerHTML='<em style="opacity:.7">[模型未返回有效内容，已尝试兜底重试。如仍空白请重发或换模型。]</em>';
      }else if(_streamOk && _streamFinished){
        // 流式已经成功渲染过，直接定格最终内容，避免重新打字造成"完整输出一次"的重复感
        waitEl.innerHTML=md(reply+suffix);
      }else{
        await typewriter(waitEl,reply+suffix);
      }
      if(meta){
        const m=document.createElement('div');m.className='meta';
        let s='⏱ 思考 '+meta.think.toFixed(1)+'s · 总 '+meta.total.toFixed(1)+'s';
        if(meta.usage&&meta.usage.completion_tokens!=null)s+=' · 输入 '+(meta.usage.prompt_tokens||0)+' + 输出 '+(meta.usage.completion_tokens||0)+' tokens';
        m.textContent=s;chatEl.insertBefore(m,waitEl.nextSibling);
      }
      if(d.data&&d.data.model){
        const tag=document.createElement('div');tag.className='model-tag';tag.textContent=d.data.model;
        chatEl.insertBefore(tag,waitEl.nextSibling);
      }
      if(d.data&&d.data.reasoning){
        const thinkEl=document.createElement('div');
        thinkEl.className='think';thinkEl.textContent='🧠 '+d.data.reasoning;
        chatEl.insertBefore(thinkEl,waitEl.nextSibling);
      }
      // fallback 路径：结构化搜索结果显示为独立卡片
      if(d.data&&d.data.searchResult && (!waitEl.nextSibling || !waitEl.nextSibling.classList.contains('search-card'))){
        const card=document.createElement('div');card.className='search-card';
        card.innerHTML='<div class="search-card-hd">'+(d.data.searchSrc||'搜索')+' · '+escapeHtml(d.data.searchQuery||'')+'</div><div class="search-card-body">'+md(d.data.searchResult||'')+'</div>';
        chatEl.insertBefore(card,waitEl.nextSibling);
      }
      _history.push({role:'user',content:msg||'[图片]'});
      _history.push({role:'assistant',content:reply});
      if(_history.length>40)_history=_history.slice(-40);
      await saveChat('ai',reply,time,currentSid||undefined);
      if(d.data&&d.data.note)await applyMemoryDisplay(d.data.note, d.data.noteStatus, d.data.noteInfo);
      speak(reply);
    }else{
      showError(waitEl,d.code,d.message||'未知',d.stack||'',msg);
    }
  }catch(e){
    if(_waitTimer)clearInterval(_waitTimer);
    try{document.removeEventListener('visibilitychange',onVisibility);}catch(_){}
    if(e && e.bgAbort){
      try{undoBtn.click();}catch(_){}
      waitEl.className='err-box';
      waitEl.innerHTML='页面切换到后台过久，连接已断开。<button onclick="const el=this.closest(\'.err-box\');if(el)el.remove();input.value=\''+msg.replace(/'/g,"\\'")+'\';sendBtn.click()">重试</button>';
    }else{
      console.error('[枢衡殿] sendMsg error:',e);
      try{reportLog('send_error',e&&e.message||'unknown',{stack:(e&&e.stack||String(e)).split('\n').slice(0,5).join('\n')});}catch(_){}
      showError(waitEl,0,e.message||'请求失败',(e.stack||String(e)).split('\n').slice(0,5).join('\n'),msg);
    }
  }
  sendBtn.disabled=false;input.focus();scrollDown();
}

// 图片：支持粘贴 + 多选 + 上限9
function addImageFile(file){
  if(!file||!file.type||!file.type.startsWith('image/'))return false;
  if(pendingImages.length>=9){showToast('最多 9 张图片');return false;}
  const reader=new FileReader();
  reader.onload=()=>{
    const dataUrl=reader.result;
    const mime=(dataUrl.match(/^data:([^;]+);/)||[])[1]||file.type||'';
    // kimi-k3 服务端对 webp/gif 会 panic 导致 400；选 kimi 时自动转 png（png 所有视觉模型都支持）
    if((mime==='image/webp'||mime==='image/gif') && _model==='kimi-k3'){
      const img=new Image();
      img.onload=()=>{ try{
        const c=document.createElement('canvas');
        c.width=img.naturalWidth||img.width||1; c.height=img.naturalHeight||img.height||1;
        c.getContext('2d').drawImage(img,0,0);
        pendingImages.push(c.toDataURL('image/png'));
      }catch(_){ pendingImages.push(dataUrl); } renderImgPreview(); };
      img.onerror=()=>{pendingImages.push(dataUrl);renderImgPreview();};
      img.src=dataUrl;
    }else{
      pendingImages.push(dataUrl);
      renderImgPreview();
    }
  };
  reader.readAsDataURL(file);
  return true;
}
imgInput.multiple=true;
imgInput.onchange=(e)=>{
  const files=Array.from(e.target.files||[]);
  for(const f of files)addImageFile(f);
  e.target.value='';
};
// 直接 Ctrl+V 粘贴剪贴板里的截图（支持一次多张，累加，上限9）
input.addEventListener('paste',(e)=>{
  const dt=e.clipboardData||window.clipboardData;
  const items=dt?dt.items:null;
  if(!items)return;
  const blobs=[];
  for(const it of items){if(it.type&&it.type.startsWith('image/')){const b=it.getAsFile&&it.getAsFile();if(b)blobs.push(b);}}
  if(!blobs.length)return;
  e.preventDefault();
  for(const b of blobs)addImageFile(b);
});
function renderImgPreview(){
  const box=document.getElementById('imgPreview');
  if(!box)return;
  if(!pendingImages.length){box.style.display='none';box.innerHTML='';imgBtn.style.color='';input.placeholder='说点什么…（Enter 发送，Shift+Enter 换行）';return;}
  box.style.display='flex';
  imgBtn.style.color='var(--accent)';
  input.placeholder='已添加 '+pendingImages.length+' 张图片，可继续粘贴/选图（上限9）';
  box.innerHTML=pendingImages.map((src,i)=>'<div class="thumb"><img src="'+src+'"><span class="thumb-x" data-i="'+i+'">×</span></div>').join('');
  box.querySelectorAll('.thumb-x').forEach(x=>x.onclick=()=>{pendingImages.splice(+x.dataset.i,1);renderImgPreview();});
}
function showToast(m){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}
  t.textContent=m;t.classList.add('show');
  clearTimeout(t._timer);t._timer=setTimeout(()=>t.classList.remove('show'),1800);
}

sendBtn.addEventListener('click',sendMsg);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg()}});

// ===== 聊天搜索 =====
let _searchResults=[],_searchIdx=-1;
window.toggleSearch=function(){
  const bar=document.getElementById('searchBar');
  const inp=document.getElementById('searchInput');
  bar.style.display=bar.style.display==='flex'?'none':'flex';
  if(bar.style.display==='flex'){inp.focus();inp.value='';_searchResults=[];doSearch('')}
};
document.getElementById('searchInput').addEventListener('input',e=>doSearch(e.target.value));
function doSearch(q){
  const cnt=document.getElementById('searchCount');
  const box=document.getElementById('searchResults');
  clearHighlights();_searchResults=[];_searchIdx=-1;
  if(!q){if(cnt)cnt.textContent='';if(box)box.innerHTML='';return}
  if(cnt)cnt.textContent='搜索中…';
  (async()=>{
    try{
      const esc=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const re=new db.RegExp({regexp:esc,options:'i'});
      const res=await db.collection('chats').where({text:re}).orderBy('ts','desc').limit(30).get();
      const hits=res.data||[];
      if(cnt)cnt.textContent=hits.length+' 条';
      if(!box)return;
      if(!hits.length){box.innerHTML='<div class="s-empty">无匹配结果</div>';return}
      box.innerHTML='';
      for(const h of hits){
        const el=document.createElement('div');el.className='s-item';
        const who=h.who==='ai'?'助手':'你';
        const snip=(h.text||'').replace(new RegExp(esc,'gi'),m=>'<mark>'+m+'</mark>');
        el.innerHTML='<div class="s-meta">'+h.date+' '+h.time+' · '+who+'</div><div class="s-text">'+snip+'</div>';
        el.onclick=()=>{const d=h.date;loadDay(d).then(()=>setTimeout(()=>locateInDay(q),400));closeSearchLight()};
        box.appendChild(el);
      }
    }catch(e){if(cnt)cnt.textContent='搜索失败';if(box)box.innerHTML=''}
  })();
}
function locateInDay(q){
  const msgs=chatEl.querySelectorAll('.msg');
  const low=q.toLowerCase();
  for(const m of msgs){if(m.textContent.toLowerCase().includes(low)){m.scrollIntoView({block:'center',behavior:'smooth'});m.style.boxShadow='0 0 0 2px var(--accent)';return}}
}
function closeSearchLight(){const bar=document.getElementById('searchBar');if(bar)bar.style.display='none';clearHighlights();}
function jumpToResult(i){
  clearHighlights();
  if(!_searchResults.length)return;
  const el=_searchResults[i];el.scrollIntoView({block:'center',behavior:'smooth'});
  el.style.boxShadow='0 0 0 2px var(--accent)';
}
function clearHighlights(){_searchResults.forEach(m=>m.style.boxShadow='')}
window.searchNext=function(){if(_searchResults.length){_searchIdx=(_searchIdx+1)%_searchResults.length;jumpToResult(_searchIdx)}}
window.searchPrev=function(){if(_searchResults.length){_searchIdx=(_searchIdx-1+_searchResults.length)%_searchResults.length;jumpToResult(_searchIdx)}}
window.closeSearch=function(){closeSearchLight()}
