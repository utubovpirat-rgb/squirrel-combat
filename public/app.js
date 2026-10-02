// app.js — фронт Squirrel Combat
const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
tg?.setHeaderColor?.('#0a0a12');
tg?.setBackgroundColor?.('#0a0a12');
const initData = tg?.initData || '';

const $ = id => document.getElementById(id);
const fmt = n => { n = Math.floor(n||0); if(n>=1e9) return (n/1e9).toFixed(2)+'B';
  if(n>=1e6) return (n/1e6).toFixed(2)+'M'; if(n>=1e4) return (n/1e3).toFixed(1)+'K';
  return n.toLocaleString('ru'); };

const state = {
  player: null, balance: 0, energy: 0, maxEnergy: 1000, perClick: 1, perHour: 0,
  league: 1, tapBuffer: 0, tapTimer: null, activeDuel: null
};

function getDevice(){
  let id = localStorage.getItem('dev_id');
  if(!id){ id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)); localStorage.setItem('dev_id', id); }
  return id;
}
async function api(path, body={}){
  const r = await fetch(path, {
    method:'POST',
    headers:{'Content-Type':'application/json','X-Init-Data':initData,'X-Device':getDevice()},
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json; try{ json = JSON.parse(text); }catch(e){ json = {error:text}; }
  if(!r.ok) throw Object.assign(new Error(json.error||'err'), {status:r.status, body:json});
  return json;
}

async function loadMe(){
  const p = await api('/api/me', {
    tgUser:{
      username: tg?.initDataUnsafe?.user?.username,
      first_name: tg?.initDataUnsafe?.user?.first_name
    },
    lang: tg?.initDataUnsafe?.user?.language_code?.startsWith('ru') ? 'ru'
      : tg?.initDataUnsafe?.user?.language_code?.startsWith('es') ? 'es' : 'en',
    refId: new URLSearchParams(location.search).get('ref')
  });
  state.player = p;
  state.balance = p.balance;
  state.energy = p.energy;
  state.maxEnergy = p.max_energy;
  state.perClick = p.per_click;
  state.perHour = p.per_hour;
  state.league = p.league;
  renderHdr();
}

function renderHdr(){
  $('hBal').textContent = fmt(state.balance);
  $('hPerHour').textContent = fmt(state.perHour);
  $('hLeague').textContent = state.league || 1;
  $('uname').textContent = tg?.initDataUnsafe?.user?.first_name || 'Игрок';
  $('league').textContent = `Лига ${state.league}/10`;
  const ef = $('energyFill'); const et = $('energyText');
  const pct = Math.max(0, Math.min(100, state.energy/state.maxEnergy*100));
  if(ef){
    ef.style.width = pct+'%';
    ef.classList.toggle('low', pct < 20);
  }
  if(et) et.textContent = `${fmt(state.energy)} / ${fmt(state.maxEnergy)}`;
}

function toast(msg, cls='', dur=3000){
  const t = document.createElement('div');
  t.className = 'toast '+cls; t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(()=>t.remove(), dur+400);
}
function modal(html){
  $('modalBody').innerHTML = html;
  $('modalBg').classList.add('on');
}
function closeModal(){ $('modalBg').classList.remove('on'); }
$('modalBg').onclick = e => { if(e.target.id === 'modalBg') closeModal(); };

// ---------- TAP (улучшенный) ----------
const sq = $('squirrel');
let lastTapTs = 0;
const TAP_DEBOUNCE = 40;
const SEND_INTERVAL = 150;

sq.addEventListener('pointerdown', e => {
  const t = performance.now();
  if(t - lastTapTs < TAP_DEBOUNCE) return;
  lastTapTs = t;

  if(state.energy <= 0){
    toast('⚡ Энергия кончилась', 'pink', 1500);
    return;
  }

  state.energy--;
  state.balance += state.perClick;
  renderHdr();

  spawnFloat(e.clientX, e.clientY, `+${state.perClick}`);
  navigator.vibrate?.(8);
  sq.classList.remove('hit'); void sq.offsetWidth; sq.classList.add('hit');
  spawnCoinBurst(e.clientX, e.clientY);

  state.tapBuffer++;
  if(!state.tapTimer) state.tapTimer = setTimeout(flushTaps, SEND_INTERVAL);
});

async function flushTaps(){
  const count = state.tapBuffer;
  state.tapBuffer = 0;
  state.tapTimer = null;
  if(count <= 0) return;

  const localBal = state.balance;
  const localEng = state.energy;

  try{
    const r = await api('/api/tap', {count});
    if(r.ok){
      const newTaps = state.tapBuffer;
      state.balance = r.balance + newTaps * state.perClick;
      state.energy = Math.max(0, r.energy - newTaps);
      renderHdr();
    } else if(r.reason === 'no energy'){
      state.energy = 0;
      renderHdr();
    }
  }catch(e){
    if(e.status === 401){
      console.warn('auth fail', e.message);
      toast('⚠️ Ошибка авторизации, переоткрой игру', 'pink', 4000);
    } else {
      state.balance = localBal;
      state.energy = localEng;
      renderHdr();
      toast('⚠️ ' + (e.message || 'Ошибка сети'), 'pink', 2500);
    }
  }
}

function spawnCoinBurst(x, y){
  const layer = $('floatLayer'); if(!layer) return;
  const r = layer.getBoundingClientRect();
  for(let i=0;i<4;i++){
    const el = document.createElement('div');
    el.textContent = ['🪙','⭐','💰','✨'][i%4];
    el.style.cssText = `position:absolute;font-size:14px;pointer-events:none;
      left:${x-r.left+ (Math.random()*30-15)}px;top:${y-r.top+(Math.random()*10-5)}px;
      animation:coinBurst .8s ease-out forwards;
      animation-delay:${i*30}ms;`;
    layer.appendChild(el);
    setTimeout(()=>el.remove(), 900);
  }
    }

function spawnFloat(x,y,text){
  const layer = $('floatLayer'); if(!layer) return;
  const el = document.createElement('div');
  el.className = 'float';
  const r = layer.getBoundingClientRect();
  el.style.left = (x - r.left)+'px';
  el.style.top = (y - r.top)+'px';
  el.textContent = text;
  layer.appendChild(el);
  setTimeout(()=>el.remove(), 1000);
}

$('bonusBtn').onclick = async ()=>{
  try{
    const r = await api('/api/bonus');
    if(r.ok){ toast(`🎁 +${fmt(r.reward)} (серия ${r.streak})`, 'gold'); loadMe(); }
    else toast(`Через ${Math.ceil(r.next/3600)}ч`);
  }catch(e){ toast('Ошибка: '+e.message); }
};

$('soundBtn').onclick = ()=>{
  const cur = $('soundBtn').textContent === '🔊';
  $('soundBtn').textContent = cur ? '🔇' : '🔊';
};

$('claimBtn').onclick = async ()=>{
  try{
    const r = await api('/api/passive');
    if(r.ok){ toast(`💤 +${fmt(r.gain)}`, 'green'); loadMe(); }
    else toast('Пока нечего собирать');
  }catch(e){ toast('Ошибка: '+e.message); }
};

$('boostBtn').onclick = async ()=>{
  try{
    await api('/api/boost-energy');
    toast('⚡ Энергия восстановлена', 'green');
    loadMe();
  }catch(e){ toast(e.message); }
};

const TABS = [
  ['home','🐿️','Игра'],
  ['cards','🏦','Карты'],
  ['boosts','⚡','Бусты'],
  ['session','💤','Сессия'],
  ['duel','⚔️','Дуэль'],
  ['clan','🛡️','Клан'],
  ['daily','📅','Задания'],
  ['ach','🏅','Ачивки'],
  ['season','🏆','Сезон'],
  ['wheel','🎡','Колесо'],
  ['promo','🎟️','Промо'],
  ['ref','🔗','Рефералы'],
  ['refcontest','🥇','Турнир'],
  ['channel','📢','Канал'],
  ['top','👑','Топ'],
  ['profile','👤','Профиль']
];
function buildTabs(){
  $('tabs').innerHTML = TABS.map(([id,ic,lbl])=>
    `<button data-tab="${id}" class="${id==='home'?'on':''}">${ic} ${lbl}</button>`).join('');
  document.querySelectorAll('#tabs button').forEach(b=>{
    b.onclick = ()=>go(b.dataset.tab);
  });
}
function go(tab){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  const el = $('p-'+tab); if(el) el.classList.add('on');
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on', b.dataset.tab===tab));
  $('main').scrollTop = 0;
  renderTab(tab);
}

const CARDS_CACHE = {};
async function loadCatalog(){
  if(CARDS_CACHE.cards) return CARDS_CACHE;
  const r = await fetch('/api/catalog').then(r=>r.json());
  Object.assign(CARDS_CACHE, r);
  return CARDS_CACHE;
}

async function renderTab(tab){
  const c = $('p-'+tab); if(!c) return;
  if(c.__cleanup){ c.__cleanup(); c.__cleanup = null; }
  const p = state.player || {};

  if(tab === 'cards'){
    if(!CARDS_CACHE.cards) await loadCatalog();
    const cats = ['FARM','BANK','WEB3','MARKET','AIRDROP','TEAM'];
    c.innerHTML = cats.map(cat=>{
      const cards = CARDS_CACHE.cards.filter(x=>x.category===cat);
      if(!cards.length) return '';
      return `<div class="section-title">${cat}</div>` + cards.map(card=>{
        const owned = (p.cards||[]).find(x=>x.id===card.id);
        const lvl = owned?.level || 0;
        const cost = Math.floor(card.base_price * Math.pow(1.85, lvl));
        const mult = CARDS_CACHE.rarityMult[card.rarity] || 1;
        const inc = Math.floor(card.base_income * Math.pow(1.65, lvl) * mult);
        const dis = state.balance < cost || lvl >= card.max_level ? 'disabled' : '';
        const col = CARDS_CACHE.rarityColor[card.rarity] || '#8888aa';
        return `<div class="card" style="border-left:3px solid ${col}">
          <div class="ic">${card.icon}</div>
          <div class="info">
            <div class="t">${card.title} <span style="color:${col};font-size:9px">${card.rarity.toUpperCase()}</span></div>
            <div class="d">ур.${lvl}/${card.max_level} · +${fmt(inc)}/ч · ${fmt(cost)} 🐿️</div>
          </div>
          <button data-card="${card.id}" ${dis}>${lvl>=card.max_level?'MAX':'Купить'}</button>
        </div>`;
      }).join('');
    }).join('');
    c.querySelectorAll('button[data-card]').forEach(btn=>{
      btn.onclick = async ()=>{
        btn.disabled = true;
        try{ await api('/api/buy-card', {cardId:btn.dataset.card}); await loadMe(); renderTab('cards'); }
        catch(e){ toast(e.message, 'pink'); }
        finally{ btn.disabled = false; }
      };
    });
  }

  else if(tab === 'boosts'){
    c.innerHTML = `
      <div class="card"><div class="ic">⚡</div>
        <div class="info"><div class="t">Полная энергия</div>
        <div class="d">Осталось: ${p.boosts?.full_energy || 0}</div></div>
        <button id="bEn">${(p.boosts?.full_energy||0)>0?'Активировать':'Пусто'}</button></div>
      <div class="card"><div class="ic">🔥</div>
        <div class="info"><div class="t">Турбо ×5 (20 сек)</div>
        <div class="d">Осталось: ${p.boosts?.turbo || 0}</div></div>
        <button id="bTb">${(p.boosts?.turbo||0)>0?'Активировать':'Пусто'}</button></div>
      <div class="card"><div class="ic">💎</div>
        <div class="info"><div class="t">Премиум 30 дней</div>
        <div class="d">×2 тап · 30 000 🐿️</div></div>
        <button id="bPm">Купить</button></div>`;
    $('bEn').onclick = async ()=>{ try{ await api('/api/boost-energy'); loadMe(); renderTab('boosts'); }catch(e){ toast(e.message); } };
    $('bTb').onclick = async ()=>{ try{ await api('/api/boost-turbo'); loadMe(); renderTab('boosts'); }catch(e){ toast(e.message); } };
    $('bPm').onclick = async ()=>{ try{ await api('/api/premium/buy',{days:30}); loadMe(); renderTab('boosts'); }catch(e){ toast(e.message); } };
  }

  else if(tab === 'session'){
    try{
      const s = await api('/api/session/status');
      const el = s.elapsed||0, pct = s.dur? (el/s.dur*100).toFixed(1) : 0;
      const hh = Math.floor(el/3600), mm = Math.floor((el%3600)/60);
      c.innerHTML = `
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div style="display:flex;gap:10px;align-items:center">
            <div class="ic">💤</div>
            <div class="info"><div class="t">Сессия сна · ×${s.mult}</div>
            <div class="d">Уровень ${s.speedLevel}/5 · ${fmt(s.perHour)}/ч</div></div>
          </div>
          <div style="height:8px;background:#0a0a12;border-radius:4px;overflow:hidden;margin:10px 0">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#ffb84d,#ff9e00);transition:width .5s"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#8888aa">
            <span>${hh}ч ${mm}м / 3ч</span>
            <span style="color:#ffd166;font-weight:800">Накоплено: ${fmt(s.accrued)}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:12px">
            <button class="qb" id="sStart">${s.start && el<s.dur?'Активна':'Начать'}</button>
            <button class="qb" id="sClaim" ${el<1800?'disabled':''}>Забрать</button>
          </div>
        </div>
        <div class="card"><div class="ic">🚀</div>
          <div class="info"><div class="t">Улучшить скорость</div>
          <div class="d">Текущий: ×${s.mult} · ур.${s.speedLevel}</div></div>
          <button id="sUpg" ${s.speedLevel>=5?'disabled':''}>${s.speedLevel>=5?'MAX':'Улучшить'}</button></div>`;
      $('sStart').onclick = async ()=>{ try{ await api('/api/session/start'); renderTab('session'); }catch(e){ toast(e.message); } };
      $('sClaim').onclick = async ()=>{
        try{ const r = await api('/api/session/claim'); toast('💤 +'+fmt(r.gain),'gold'); await loadMe(); renderTab('session'); }
        catch(e){ toast(e.message, 'pink'); }
      };
      $('sUpg').onclick = async ()=>{ try{ await api('/api/session/upgrade'); renderTab('session'); }catch(e){ toast(e.message); } };
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка загрузки</div>'; }
  }

  else if(tab === 'duel'){
    c.innerHTML = `
      <div class="card"><div class="ic">⚔️</div>
        <div class="info"><div class="t">Создать дуэль</div>
        <div class="d">15 сек · кто больше натапает · победитель берёт всё</div></div>
        <button id="dCreate">Создать</button></div>
      <div class="card"><div class="ic">🔗</div>
        <div class="info"><div class="t">Войти по ID</div>
        <div class="d">Вставь ID от друга</div></div>
        <button id="dJoin">Войти</button></div>
      <div class="card"><div class="ic">📊</div>
        <div class="info"><div class="t">Моя статистика</div>
        <div class="d">${p.pvp_wins||0}W / ${p.pvp_losses||0}L · рейтинг ${p.pvp_rating||1000}</div></div></div>`;
    $('dCreate').onclick = async ()=>{
      const stake = parseInt(prompt('Ставка (мин 1000):','1000')||'0');
      if(stake < 1000) return;
      try{
        const r = await api('/api/duel/create', {stake});
        state.activeDuel = r.id;
        toast('Ссылка: '+r.link, 'gold', 8000);
        renderDuelGame(c);
      }catch(e){ toast(e.message, 'pink'); }
    };
    $('dJoin').onclick = async ()=>{
      const id = prompt('ID дуэли:'); if(!id) return;
      state.activeDuel = id;
      try{ await api('/api/duel/join', {id}); renderDuelGame(c); }
      catch(e){ toast(e.message, 'pink'); state.activeDuel = null; }
    };
  }

  else if(tab === 'clan'){
    try{
      const me = await api('/api/clan/me');
      if(!me.inClan){
        c.innerHTML = `
          <div class="card"><div class="ic">🛡️</div>
            <div class="info"><div class="t">Создать клан</div>
            <div class="d">50 000 🐿️ · имя + тег</div></div>
            <button id="cCreate">Создать</button></div>
          <div class="section-title">Топ кланов</div>
          <div id="cList">Загрузка...</div>`;
        $('cCreate').onclick = async ()=>{
          const name = prompt('Название (до 30):'); if(!name) return;
          const tag = prompt('Тег (до 5):'); if(!tag) return;
          try{ await api('/api/clan/create',{name,tag}); renderTab('clan'); }
          catch(e){ toast(e.message, 'pink'); }
        };
        const list = await fetch('/api/clan/list', {headers:{'X-Init-Data':initData}}).then(r=>r.json());
        $('cList').innerHTML = list.length ? list.map(cl=>`
          <div class="card">
            <div class="ic">${cl.emblem}</div>
            <div class="info"><div class="t">[${cl.tag}] ${cl.name}</div>
            <div class="d">${cl.members}/${cl.max_members} · ${fmt(cl.total_earned)}</div></div>
            <button data-join="${cl.id}">Войти</button>
          </div>`).join('') : '<div class="empty">Пока пусто</div>';
        c.querySelectorAll('[data-join]').forEach(b=>{
          b.onclick = async ()=>{ try{ await api('/api/clan/join',{clanId:b.dataset.join}); renderTab('clan'); }
            catch(e){ toast(e.message); } };
        });
      } else {
        const cl = me.clan;
        c.innerHTML = `
          <div class="card" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;gap:10px;align-items:center">
              <div class="ic" style="font-size:40px">${cl.emblem}</div>
              <div class="info"><div class="t">[${cl.tag}] ${cl.name}</div>
              <div class="d">${me.members.length}/${cl.max_members} · казна ${fmt(cl.treasury)}</div></div>
            </div>
          </div>
          <div class="card"><div class="ic">💰</div>
            <div class="info"><div class="t">Донат в казну</div><div class="d">От 1000</div></div>
            <button id="cDon">Внести</button></div>
          <div class="card">
            <button id="cLeave" style="background:#8a1a2a;color:#fff;flex:1">Выйти из клана</button>
          </div>
          <div class="section-title">Участники</div>
          ${me.members.map(m=>`
            <div class="row"><span>${m.role==='owner'?'👑':m.role==='officer'?'⭐':'🐿️'} ${m.name}</span>
            <span style="color:#ffd166">${fmt(m.contribution)}</span></div>`).join('')}`;
        $('cDon').onclick = async ()=>{
          const amt = parseInt(prompt('Сумма:','5000')||'0');
          if(amt < 1000) return;
          try{ await api('/api/clan/donate',{amount:amt}); await loadMe(); renderTab('clan'); }
          catch(e){ toast(e.message); }
        };
        $('cLeave').onclick = async ()=>{
          if(!confirm('Выйти из клана?')) return;
          await api('/api/clan/leave'); renderTab('clan');
        };
      }
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'daily'){
    try{
      const list = await fetch('/api/daily/list',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      c.innerHTML = list.map(q=>{
        const pct = q.goal? Math.min(100, q.progress/q.goal*100) : 0;
        const canClaim = q.done && !q.claimed;
        return `<div class="card" style="flex-direction:column;align-items:stretch">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="ic">${q.icon}</div>
            <div class="info"><div class="t">${q.title}</div>
            <div class="d">${q.progress}/${q.goal} · +${fmt(q.reward)}${q.xp?' +'+q.xp+' XP':''}</div></div>
            <button data-q="${q.id}" ${canClaim?'':'disabled'}>
              ${q.claimed?'✓':canClaim?'Забрать':'—'}</button>
          </div>
          <div style="margin-top:8px;height:5px;background:#0a0a12;border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#ffb84d,#ff9e00)"></div>
          </div>
        </div>`;
      }).join('');
      c.querySelectorAll('[data-q]').forEach(b=>{
        b.onclick = async ()=>{
          try{ const r = await api('/api/daily/claim',{id:b.dataset.q});
            toast('+'+fmt(r.reward), 'gold'); await loadMe(); renderTab('daily'); }
          catch(e){ toast(e.message); }
        };
      });
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'ach'){
    try{
      const list = await fetch('/api/ach/list',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      const byCat = {};
      list.forEach(a=>{ (byCat[a.category] ||= []).push(a); });
      const tierColor = { bronze:'#cd7f32', silver:'#c0c0c0', gold:'#ffd166', platinum:'#00f5d4', diamond:'#8338ec' };
      c.innerHTML = Object.entries(byCat).map(([cat, items])=>`
        <div class="section-title">${cat}</div>
        ${items.map(a=>{
          const pct = Math.min(100, a.progress/a.goal*100);
          const col = tierColor[a.tier]||'#8888aa';
          return `<div class="card" style="flex-direction:column;align-items:stretch;opacity:${a.unlocked?1:.65};border-left:3px solid ${col}">
            <div style="display:flex;gap:8px;align-items:center">
              <div class="ic">${a.unlocked?'🏆':'🔒'}</div>
              <div class="info"><div class="t">${a.title}
                <span style="color:${col};font-size:9px">${a.tier.toUpperCase()}</span></div>
                <div class="d">${a.desc} · +${fmt(a.reward)} +${a.xp} XP</div></div>
            </div>
            ${!a.unlocked?`<div style="margin-top:6px;height:4px;background:#0a0a12;border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${col}"></div></div>`:''}
          </div>`;
        }).join('')}`).join('');
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'season'){
    try{
      const s = await fetch('/api/season/current',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      if(!s.active){ c.innerHTML = '<div class="empty">Сезон скоро начнётся</div>'; return; }
      const lb = await fetch('/api/season/leaderboard',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      const days = Math.floor(s.secondsLeft/86400), hrs = Math.floor((s.secondsLeft%86400)/3600);
      c.innerHTML = `
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><div class="t" style="font-size:16px">🏆 Сезон ${s.id}</div>
              <div class="d">Осталось ${days}д ${hrs}ч</div></div>
            <div style="text-align:right">
              <div style="font-size:10px;color:#8888aa">Мой ранг</div>
              <div style="font-weight:800;color:#ffd166;font-size:20px">#${s.myRank}</div>
            </div>
          </div>
          <div style="margin-top:8px;color:#00f5d4;font-size:12px">Очки: <b>${fmt(s.myScore)}</b></div>
        </div>
        <div class="section-title">Топ-50</div>
        ${lb.map(x=>`<div class="row">
          <span>${x.rank<=3?['🥇','🥈','🥉'][x.rank-1]:'#'+x.rank} ${x.name}</span>
          <span style="color:#ffd166">${fmt(x.score)}</span></div>`).join('')}`;
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'wheel'){
    try{
      const info = await fetch('/api/wheel/info',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      const nextH = Math.floor(info.nextIn/3600), nextM = Math.floor((info.nextIn%3600)/60);
      c.innerHTML = `
        <div class="card" style="flex-direction:column;align-items:center;padding:20px">
          <div style="position:relative;width:280px;height:280px;max-width:90vw">
            <canvas id="wheelCanvas" style="width:100%;height:100%"></canvas>
            <div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);
              font-size:26px;color:#ffd166">▼</div>
          </div>
          <button id="spinBtn" class="qb" style="margin-top:16px;padding:14px 30px;font-size:14px;
            background:${info.ready?'linear-gradient(135deg,#ffb84d,#ff9e00)':'#333'};
            color:#3a1e00;border-radius:12px" ${info.ready?'':'disabled'}>
            ${info.ready?'КРУТИТЬ БЕСПЛАТНО':`Через ${nextH}ч ${nextM}м`}
          </button>
          <div style="margin-top:8px;font-size:11px;color:#8888aa">Серия: ${info.streak}</div>
        </div>`;
      drawWheel(info.prizes);
      if(info.ready) $('spinBtn').onclick = async ()=>{
        $('spinBtn').disabled = true;
        try{
          const r = await api('/api/wheel/spin');
          await animateWheel(r.prize.idx, info.prizes);
          setTimeout(()=>{ toast('🎉 '+r.msg, 'gold', 5000); loadMe(); renderTab('wheel'); }, 4200);
        }catch(e){ toast(e.message, 'pink'); $('spinBtn').disabled = false; }
      };
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'promo'){
    c.innerHTML = `
      <div class="card" style="flex-direction:column;align-items:stretch">
        <div class="t" style="margin-bottom:8px">Активировать промокод</div>
        <input id="promoInput" placeholder="Введи код..." style="padding:12px;background:#0a0a12;
          border:1px solid #2a2a48;border-radius:8px;color:#ffd166;font-size:15px;text-align:center;
          font-weight:800;letter-spacing:2px;text-transform:uppercase">
        <button id="promoBtn" class="qb" style="margin-top:10px;padding:12px;background:linear-gradient(135deg,#ffb84d,#ff9e00);color:#3a1e00;border-radius:8px">Активировать</button>
      </div>`;
    $('promoBtn').onclick = async ()=>{
      const code = $('promoInput').value.trim();
      if(!code) return;
      try{
        const r = await api('/api/promo/redeem', {code});
        toast(`✅ +${fmt(r.reward)} (${r.kind})`, 'gold', 5000);
        await loadMe();
      }catch(e){ toast('Ошибка: '+e.message, 'pink'); }
    };
  }

  else if(tab === 'ref'){
    try{
      const r = await api('/api/ref/stats');
      const me = tg?.initDataUnsafe?.user;
      const botUsername = (window.__BOT_USERNAME__) || 'your_bot';
      const link = `https://t.me/${botUsername}?start=ref_${me?.id||''}`;
      c.innerHTML = `
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div class="t" style="margin-bottom:6px">🔗 Твоя ссылка</div>
          <div style="font-size:11px;color:#8888aa;word-break:break-all;background:#0a0a12;
            padding:8px;border-radius:6px">${link}</div>
          <button id="refCopy" class="qb" style="margin-top:8px">Скопировать</button>
        </div>
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div class="t" style="margin-bottom:8px">💰 Заработано с сети</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
            <div><div style="font-size:10px;color:#8888aa">Ур. 1 (10%)</div>
              <div style="font-weight:800;color:#ffd166">${fmt(r.earned[1]||0)}</div></div>
            <div><div style="font-size:10px;color:#8888aa">Ур. 2 (5%)</div>
              <div style="font-weight:800;color:#ffd166">${fmt(r.earned[2]||0)}</div></div>
            <div><div style="font-size:10px;color:#8888aa">Ур. 3 (2%)</div>
              <div style="font-weight:800;color:#ffd166">${fmt(r.earned[3]||0)}</div></div>
          </div>
          <div style="margin-top:10px;text-align:center;color:#00f5d4;font-size:12px">
            Всего: <b>${fmt(r.totalEarned)}</b> 🐿️</div>
        </div>
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div class="t">👥 Прямые (${r.lvl1.length})</div>
          <div style="font-size:12px;color:#8888aa;margin-top:6px">
            ${r.lvl1.slice(0,10).map(p=>`${p.first_name||'?'} · ${fmt(p.total_earned)}`).join('<br>')||'Никого'}
          </div>
        </div>`;
      $('refCopy').onclick = ()=>{ navigator.clipboard?.writeText(link); toast('Скопировано','green'); };
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'refcontest'){
    try{
      const s = await fetch('/api/ref-contest/current',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      if(!s.active){ c.innerHTML = '<div class="empty">Турнир скоро</div>'; return; }
      const lb = await fetch('/api/ref-contest/leaderboard',{headers:{'X-Init-Data':initData}}).then(r=>r.json());
      const days = Math.floor(s.secondsLeft/86400), hrs = Math.floor((s.secondsLeft%86400)/3600);
      c.innerHTML = `
        <div class="card" style="flex-direction:column;align-items:stretch">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><div class="t" style="font-size:16px">🥇 Реф-турнир недели</div>
              <div class="d">Приз: ${fmt(s.prizePool)} · ${days}д ${hrs}ч</div></div>
            <div style="text-align:right">
              <div style="font-size:10px;color:#8888aa">Мой ранг</div>
              <div style="font-weight:800;color:#ffd166;font-size:20px">#${s.myRank}</div>
            </div>
          </div>
        </div>
        <div class="section-title">Топ-50</div>
        ${lb.map(x=>`<div class="row">
          <span>${x.rank<=3?['🥇','🥈','🥉'][x.rank-1]:'#'+x.rank} ${x.name}</span>
          <span style="color:#ffd166">${x.score}</span></div>`).join('')}`;
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'channel'){
    try{
      const m = await api('/api/channel/me');
      if(!m.has){
        c.innerHTML = `
          <div class="card" style="flex-direction:column;align-items:stretch">
            <div class="t" style="margin-bottom:8px">📢 Стать партнёром</div>
            <div style="font-size:12px;color:#8888aa;margin-bottom:10px">
              Владеешь каналом? Получай 15% пожизненно с каждого игрока.
            </div>
            <input id="chTitle" placeholder="Название канала" style="padding:10px;background:#0a0a12;
              border:1px solid #2a2a48;border-radius:6px;color:#eaeaf5;font-size:13px;margin-bottom:8px">
            <input id="chUser" placeholder="@username (без @)" style="padding:10px;background:#0a0a12;
              border:1px solid #2a2a48;border-radius:6px;color:#eaeaf5;font-size:13px;margin-bottom:10px">
            <button id="chCreate" class="qb" style="padding:12px;background:linear-gradient(135deg,#ffb84d,#ff9e00);color:#3a1e00">Создать</button>
          </div>`;
        $('chCreate').onclick = async ()=>{
          try{ await api('/api/channel/create',{title:$('chTitle').value,username:$('chUser').value}); renderTab('channel'); }
          catch(e){ toast(e.message); }
        };
      } else {
        const ch = m.channel;
        c.innerHTML = `
          <div class="card" style="flex-direction:column;align-items:stretch">
            <div class="t">${ch.title}</div>
            <div class="d">@${ch.username} · ${(ch.rate*100).toFixed(0)}%</div>
            <div style="font-size:11px;color:#8888aa;word-break:break-all;margin-top:8px;
              background:#0a0a12;padding:8px;border-radius:6px">${ch.link}</div>
            <button id="chCopy" class="qb" style="margin-top:8px">Скопировать</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            <div class="card"><div><div class="d">Пришло</div>
              <div style="font-weight:800;color:#ffd166;font-size:18px">${fmt(ch.signups)}</div></div></div>
            <div class="card"><div><div class="d">Заработано</div>
              <div style="font-weight:800;color:#ffd166;font-size:18px">${fmt(ch.earnings)}</div></div></div>
            <div class="card"><div><div class="d">Баланс</div>
              <div style="font-weight:800;color:#00f5d4;font-size:18px">${fmt(ch.balance)}</div></div></div>
          </div>
          <div class="card"><div class="ic">💸</div>
            <div class="info"><div class="t">Вывод</div><div class="d">Мин. 10 000</div></div>
            <button id="chWd">Вывести</button></div>`;
        $('chCopy').onclick = ()=>{ navigator.clipboard?.writeText(ch.link); toast('Скопировано'); };
        $('chWd').onclick = async ()=>{
          const amt = parseInt(prompt('Сумма:','10000')||'0');
          if(amt < 10000) return;
          try{ await api('/api/channel/withdraw',{amount:amt}); renderTab('channel'); toast('Заявка отправлена','green'); }
          catch(e){ toast(e.message, 'pink'); }
        };
      }
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'top'){
    try{
      const list = await fetch('/api/top').then(r=>r.json());
      c.innerHTML = list.map((p,i)=>
        `<div class="card">
          <div class="ic">${['🥇','🥈','🥉'][i]||i+1}</div>
          <div class="info"><div class="t">${p.first_name||'Игрок'}</div>
          <div class="d">${fmt(p.total_earned)} · лига ${p.league||1}</div></div>
        </div>`).join('');
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }

  else if(tab === 'profile'){
    c.innerHTML = `
      <div class="card" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;gap:12px;align-items:center">
          <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#8338ec,#ff006e);
            display:flex;align-items:center;justify-content:center;font-size:28px">👤</div>
          <div style="flex:1">
            <div style="font-size:18px;font-weight:900">${tg?.initDataUnsafe?.user?.first_name||'Игрок'}</div>
            <div style="font-size:12px;color:#ffd166">Лига ${state.league}/10</div>
          </div>
        </div>
      </div>
      <div class="row"><span>Баланс</span><b style="color:#ffd166">${fmt(state.balance)}</b></div>
      <div class="row"><span>В час</span><b>${fmt(state.perHour)}</b></div>
      <div class="row"><span>За тап</span><b>${state.perClick}</b></div>
      <div class="row"><span>Игр</span><b>${p.hands||0}</b></div>
      <div class="row"><span>Лучший выигрыш</span><b style="color:#ffd166">${fmt(p.best_win||0)}</b></div>
      <div class="row"><span>PvP</span><b>${p.pvp_wins||0}W / ${p.pvp_losses||0}L</b></div>
      <div class="row"><span>Рефералов</span><b>${p.referrals||0}</b></div>
      <button id="langBtn" class="qb" style="margin-top:14px;padding:12px">🌐 Сменить язык</button>`;
    $('langBtn').onclick = async ()=>{
      const l = prompt('ru / en / es', p.lang||'ru');
      if(!l) return;
      try{ await api('/api/lang/set',{lang:l}); toast('Язык сохранён','green'); }
      catch(e){ toast(e.message); }
    };
  }

  else if(tab === 'tasks'){
    c.innerHTML = `
      <div class="card"><div class="ic">📢</div>
        <div class="info"><div class="t">Подписаться на канал</div><div class="d">+25 000</div></div>
        <button data-task="join_channel">Проверить</button></div>
      <div class="card"><div class="ic">👥</div>
        <div class="info"><div class="t">Пригласить 3 друзей</div><div class="d">+50 000</div></div>
        <button data-task="invite_3">Проверить</button></div>`;
    c.querySelectorAll('[data-task]').forEach(b=>{
      b.onclick = async ()=>{
        b.disabled = true;
        try{ const r = await api('/api/complete-task',{taskId:b.dataset.task}); toast('+'+fmt(r.reward), 'gold'); await loadMe(); }
        catch(e){ toast(e.message); }
        finally{ b.disabled = false; }
      };
    });
  }

  else if(tab === 'league'){
    try{
      const l = await api('/api/league');
      c.innerHTML = `
        <div class="card">
          <div class="ic">🏆</div>
          <div class="info">
            <div class="t">Лига ${l.league}/10</div>
            <div class="d">${fmt(l.total)} / ${fmt(l.nextThreshold)}</div>
            <div style="margin-top:6px;height:6px;background:#0a0a12;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${(l.progress*100).toFixed(1)}%;background:linear-gradient(90deg,#ffb84d,#ff9e00)"></div>
            </div>
          </div>
        </div>`;
    }catch(e){ c.innerHTML = '<div class="empty">Ошибка</div>'; }
  }
}

async function renderDuelGame(c){
  const id = state.activeDuel; if(!id) return;
  c.innerHTML = `
    <div class="card" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between;font-weight:800">
        <div>Соперник: <span id="dOpp">0</span></div>
        <div style="color:#ffd166" id="dTime">Ожидание…</div>
      </div>
      <div style="text-align:center;font-size:80px;margin:16px 0;cursor:pointer" id="dSq">🐿️</div>
      <div style="display:flex;justify-content:space-between;font-weight:800">
        <div>Ты: <span id="dMy">0</span></div>
        <div style="color:#00f5d4" id="dStat">Ждём...</div>
      </div>
    </div>
    <button id="dLeave" class="qb" style="padding:14px">Выйти</button>`;

  let your = null, running = false, finished = false, tapBuf = 0, tapTimer = null;

  const refresh = async ()=>{
    try{
      const s = await api('/api/duel/poll', {id});
      your = s.your;
      const my = your==='host' ? s.hostScore : s.guestScore;
      const op = your==='host' ? s.guestScore : s.hostScore;
      $('dMy').textContent = my; $('dOpp').textContent = op;
      if(s.started && s.timeLeft > 0){
        running = true;
        $('dTime').textContent = s.timeLeft+'с';
        $('dStat').textContent = 'ТАПАЙ!';
      } else if(s.finished && !finished){
        finished = true; running = false;
        let result = 'Ничья';
        const myF = your==='host'? s.hostScore : s.guestScore;
        const opF = your==='host'? s.guestScore : s.hostScore;
        if(myF > opF) result = '🏆 Победа!';
        else if(myF < opF) result = '💀 Проигрыш';
        $('dTime').textContent = '—';
        $('dStat').textContent = `${result} (${myF}:${opF})`;
        setTimeout(()=>{ state.activeDuel = null; loadMe(); renderTab('duel'); }, 2500);
      } else if(!s.started){
        $('dTime').textContent = 'Ожидание';
      }
    }catch(e){ console.warn('poll', e.message); }
  };

  const sendTap = async ()=>{
    const n = tapBuf; tapBuf = 0; tapTimer = null;
    if(!n) return;
    try{ await api('/api/duel/tap', {id, count:n}); }catch(e){}
  };

  $('dSq').onpointerdown = ()=>{
    if(!running) return;
    $('dMy').textContent = (+$('dMy').textContent||0) + 1;
    tapBuf++;
    if(!tapTimer) tapTimer = setTimeout(sendTap, 200);
    navigator.vibrate?.(8);
  };
  $('dLeave').onclick = ()=>{ state.activeDuel = null; renderTab('duel'); };

  const iv = setInterval(refresh, 700);
  c.__cleanup = ()=>clearInterval(iv);
  refresh();
}

function drawWheel(prizes){
  const cv = $('wheelCanvas'); if(!cv) return;
  const dpr = devicePixelRatio||1;
  const S = cv.clientWidth;
  cv.width = S*dpr; cv.height = S*dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr,dpr);
  const cx=S/2, cy=S/2, R=S/2-6, n=prizes.length, arc=2*Math.PI/n;
  for(let i=0;i<n;i++){
    const a0 = i*arc - Math.PI/2, a1 = a0+arc;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,a0,a1); ctx.closePath();
    ctx.fillStyle = prizes[i].color; ctx.fill();
    ctx.strokeStyle = '#0a0a12'; ctx.lineWidth = 2; ctx.stroke();
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(a0+arc/2);
    ctx.textAlign='right'; ctx.fillStyle='#fff'; ctx.font='bold 10px sans-serif';
    ctx.fillText(prizes[i].label, R-8, 3); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx,cy,28,0,Math.PI*2);
  ctx.fillStyle='#141422'; ctx.fill();
  ctx.strokeStyle='#ffd166'; ctx.lineWidth=2; ctx.stroke();
  ctx.fillStyle='#ffd166'; ctx.font='18px sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('🐿️', cx, cy);
}

function animateWheel(targetIdx, prizes){
  return new Promise(resolve=>{
    const cv = $('wheelCanvas'); if(!cv) return resolve();
    const S = cv.clientWidth, cx=S/2, cy=S/2, n=prizes.length;
    const targetAngle = -(targetIdx + 0.5) * (360/n) + 360*5;
    const dur = 4000, t0 = performance.now();
    const baseCv = document.createElement('canvas');
    baseCv.width = cv.width; baseCv.height = cv.height;
    baseCv.getContext('2d').drawImage(cv, 0, 0);
    const spin = t=>{
      const p = Math.min(1, (t-t0)/dur);
      const eased = 1-Math.pow(1-p, 3);
      const angle = eased * targetAngle * Math.PI/180;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0,0,cv.width,cv.height);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
      ctx.drawImage(baseCv, -cx, -cy); ctx.restore();
      if(p<1) requestAnimationFrame(spin);
      else resolve();
    };
    requestAnimationFrame(spin);
  });
}

(async ()=>{
  buildTabs();
  try{
    await loadCatalog();
    await loadMe();
    const urlParams = new URLSearchParams(location.search);
    const duelId = urlParams.get('duel');
    if(duelId){ state.activeDuel = duelId; go('duel'); }
  }catch(e){ console.error('boot', e); }
  setTimeout(()=>{
    const l = $('loader');
    if(l){ l.classList.add('off'); setTimeout(()=>l.remove(), 700); }
  }, 400);
  go('home');
})();
