// server.js — Express API + Telegram webhook
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { bot } from './bot.js';
import { webhookCallback } from 'grammy';
import { DB, sbAdmin } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(x=>parseInt(x)).filter(Boolean);

app.use(cors());
app.use(express.json({ limit:'128kb' }));

// HTTP-логгер — каждая строка видна в Render Logs
app.use((req,res,next)=>{
  const t = Date.now();
  res.on('finish', ()=>{
    console.log(`>> ${req.method} ${req.path} ${res.statusCode} ${Date.now()-t}ms`);
  });
  next();
});

app.use(express.static(path.join(__dirname,'public')));

const now = ()=>Math.floor(Date.now()/1000);

async function safeRpc(name, params){
  try{ await sbAdmin.rpc(name, params); }catch(e){ }
}

// ---------- AUTH ----------
function verifyInitData(initData){
  try{
    const params = new URLSearchParams(initData);
    const hash = params.get('hash'); params.delete('hash');
    const str = [...params.entries()].sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>`${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(process.env.BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    return calc === hash;
  }catch(e){ return false; }
}

const lastDevice = new Map();
function auth(req,res,next){
  const initData = req.headers['x-init-data'] || req.body?.initData;
  if(!initData || !verifyInitData(initData)){
    if(process.env.DEV === '1'){ req.tgId = 1; return next(); }
    return res.status(401).json({error:'unauthorized'});
  }
  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user'));
  req.tgId = user.id;
  next();
}
// ---------- HELPERS ----------
function regenEnergy(p){
  const t = now();
  const dt = t - (p.last_energy_ts||t);
  if(dt <= 0) return p;
  const gained = Math.floor(dt * (p.max_energy / 3600));
  if(gained > 0){
    p.energy = Math.min(p.max_energy, (p.energy||0) + gained);
    p.last_energy_ts = t;
  }
  return p;
}
function leagueFor(total){
  const th = [0,5e3,25e3,1e5,5e5,1e6,5e6,1e7,5e7,1e8];
  let l = 1;
  for(let i=0;i<th.length;i++) if(total >= th[i]) l = i+1;
  return Math.min(l, 10);
}
function premiumActive(p){ return (p.premium_until || 0) > now(); }
function todayUTC(){ return new Date().toISOString().slice(0,10); }

async function bumpQuest(tgId, kind, amount=1){
  try{
    const day = todayUTC();
    const { data: quests } = await sbAdmin.from('daily_quests')
      .select('*').eq('tg_id', tgId).eq('day', day);
    if(!quests || !quests.length) return;
    const { data: pool } = await sbAdmin.from('quest_pool').select('id, goal').eq('kind', kind);
    const byId = {};
    (pool||[]).forEach(p=>{ byId[p.id]=p; });
    for(const q of quests){
      if(!byId[q.quest_id] || q.claimed || q.progress >= q.goal) continue;
      const newP = Math.min(q.goal, q.progress + amount);
      await sbAdmin.from('daily_quests').update({progress:newP})
        .eq('tg_id', tgId).eq('day', day).eq('quest_id', q.quest_id);
    }
  }catch(e){ }
}

async function payChannel(tgId, amount){
  try{
    const { data: ref } = await sbAdmin.from('channel_referrals').select('channel_id').eq('tg_id',tgId).maybeSingle();
    if(!ref) return;
    const { data: ch } = await sbAdmin.from('channels').select('*').eq('id', ref.channel_id).single();
    if(!ch) return;
    const cut = Math.floor(amount * Number(ch.rate));
    if(cut <= 0) return;
    await sbAdmin.from('channels').update({
      balance: (ch.balance||0) + cut, earnings: (ch.earnings||0) + cut
    }).eq('id', ch.id);
  }catch(e){ }
}

// ---------- ME ----------
app.post('/api/me', auth, async (req,res)=>{
  try{
    let p = await DB.getPlayer(req.tgId);
    if(!p){
      const { username, first_name } = req.body.tgUser || {};
      const refId = req.body.refId || null;
      let ref2=null, ref3=null;
      if(refId){
        const parent = await DB.getPlayer(refId);
        if(parent){ ref2 = parent.referrer_id||null; ref3 = parent.referrer_lvl2||null; }
      }
      p = await DB.createPlayer(req.tgId, username, first_name, refId);
      if(ref2 || ref3){
        await DB.updatePlayer(req.tgId, { referrer_lvl2: ref2, referrer_lvl3: ref3 });
      }
    }
    p = regenEnergy(p);
    await DB.updatePlayer(req.tgId, {
      energy:p.energy, last_energy_ts:p.last_energy_ts, last_seen: now()
    });
    res.json(p);
  }catch(e){
    console.error('/api/me error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- TAP ----------
app.post('/api/tap', auth, async (req,res)=>{
  try{
    const count = Math.max(1, Math.min(20, parseInt(req.body.count) || 1));
    const p = regenEnergy(await DB.getPlayer(req.tgId));
    if(!p) return res.status(404).json({error:'no player'});
    if(p.banned) return res.status(403).json({error:'banned'});

    const since = now() - 1;
    const recent = await DB.recentClicks(req.tgId, since);
    const recentTotal = recent.reduce((s,c)=>s+c.count, 0);
    if(recentTotal + count > 25) return res.status(429).json({error:'too fast'});

    const spent = Math.min(count, p.energy);
    if(spent <= 0) return res.json({ok:false, reason:'no energy'});

    const turbo = p.turbo_until > now() ? p.turbo_mult : 1;
    const premiumMul = premiumActive(p) ? 2 : 1;
    const gain = spent * p.per_click * turbo * premiumMul;

    p.energy -= spent;
    p.balance += gain;
    p.total_earned += gain;
    p.total_taps = (p.total_taps||0) + spent;
    p.league = leagueFor(p.total_earned);

    await DB.updatePlayer(req.tgId, {
      energy:p.energy, balance:p.balance, total_earned:p.total_earned,
      total_taps:p.total_taps, league:p.league, last_energy_ts:p.last_energy_ts
    });
    await DB.logClicks(req.tgId, spent);

    bumpQuest(req.tgId, 'taps', spent);
    safeRpc('pay_referrals', { p_from:req.tgId, p_amount:gain, p_source:'tap' });
    payChannel(req.tgId, gain);

    res.json({ ok:true, balance:p.balance, energy:p.energy, gain, turbo });
  }catch(e){
    console.error('/api/tap error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- PASSIVE ----------
app.post('/api/passive', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const dt = now() - (p.last_claim_ts || 0);
    if(dt < 60) return res.json({ok:false, reason:'too soon'});
    const mult = premiumActive(p) ? 1.2 : 1;
    const gain = Math.floor((p.per_hour || 0) * dt / 3600 * mult);
    if(gain <= 0) return res.json({ok:false, reason:'nothing'});
    await DB.updatePlayer(req.tgId, {
      balance: p.balance + gain,
      total_earned: p.total_earned + gain,
      last_claim_ts: now(),
      league: leagueFor(p.total_earned + gain)
    });
    bumpQuest(req.tgId, 'passive', 1);
    safeRpc('pay_referrals', { p_from:req.tgId, p_amount:gain, p_source:'passive' });
    payChannel(req.tgId, gain);
    res.json({ok:true, gain, seconds: dt});
  }catch(e){
    console.error('/api/passive error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- BONUS ----------
app.post('/api/bonus', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const cd = 86400;
    if(now() - (p.last_bonus_ts||0) < cd)
      return res.json({ok:false, reason:'wait', next: cd - (now()-(p.last_bonus_ts||0))});
    const isStreak = (p.last_bonus_ts||0) > 0 && (now() - p.last_bonus_ts) < cd*2;
    const streak = isStreak ? Math.min((p.streak||0)+1, 10) : 1;
    const reward = 1000 * streak * (p.league||1);
    await DB.updatePlayer(req.tgId, {
      balance: p.balance + reward, last_bonus_ts: now(), streak
    });
    res.json({ok:true, reward, streak});
  }catch(e){
    console.error('/api/bonus error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- CATALOG ----------
let CARDS_CACHE = null, CARDS_CACHE_TS = 0;
async function loadCatalog(){
  if(CARDS_CACHE && Date.now() - CARDS_CACHE_TS < 60000) return CARDS_CACHE;
  try{
    const { data } = await sbAdmin.from('card_catalog').select('*');
    CARDS_CACHE = data || [];
    CARDS_CACHE_TS = Date.now();
  }catch(e){
    CARDS_CACHE = CARDS_CACHE || [];
  }
  return CARDS_CACHE;
}
const RARITY_MULT = { common:1.0, rare:1.6, epic:2.4, legendary:4.0 };
const RARITY_COLOR = { common:'#a89080', rare:'#00bbf9', epic:'#8338ec', legendary:'#ffd166' };

app.get('/api/catalog', async (_,res)=>{
  const data = await loadCatalog();
  res.json({ cards:data, rarityMult:RARITY_MULT, rarityColor:RARITY_COLOR });
});

app.post('/api/buy-card', auth, async (req,res)=>{
  try{
    const cardId = String(req.body.cardId||'');
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const catalog = await loadCatalog();
    const base = catalog.find(c=>c.id===cardId);
    if(!base) return res.status(400).json({error:'unknown card'});

    const cards = [...(p.cards||[])];
    const owned = cards.find(c=>c.id===cardId);
    const level = owned ? owned.level : 0;
    if(level >= (base.max_level||10)) return res.status(400).json({error:'max level'});

    const cost = Math.floor(base.base_price * Math.pow(1.85, level));
    if(p.balance < cost) return res.status(400).json({error:'not enough'});
    const mult = RARITY_MULT[base.rarity] || 1;
    const incomeAdd = Math.floor(base.base_income * Math.pow(1.65, level) * mult);

    if(owned) owned.level += 1;
    else cards.push({id:cardId, level:1});

    let totalPerHour = 0;
    for(const c of cards){
      const cat = catalog.find(x=>x.id===c.id);
      if(!cat) continue;
      const m = RARITY_MULT[cat.rarity] || 1;
      totalPerHour += Math.floor(cat.base_income * Math.pow(1.65, c.level-1) * m);
    }

    await DB.updatePlayer(req.tgId, {
      balance: p.balance - cost, per_hour: totalPerHour, cards
    });
    bumpQuest(req.tgId, 'buy', 1);
    res.json({ok:true, cost, incomeAdd, level:level+1, per_hour: totalPerHour});
  }catch(e){
    console.error('/api/buy-card error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- BOOSTS ----------
app.post('/api/boost-energy', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if((p.boosts?.full_energy||0) <= 0) return res.status(400).json({error:'no boosts'});
    const b = {...p.boosts}; b.full_energy -= 1;
    await DB.updatePlayer(req.tgId, { energy:p.max_energy, boosts:b });
    res.json({ok:true, left:b.full_energy});
  }catch(e){
    console.error('/api/boost-energy error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/boost-turbo', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if((p.boosts?.turbo||0) <= 0) return res.status(400).json({error:'no boosts'});
    const b = {...p.boosts}; b.turbo -= 1;
    await DB.updatePlayer(req.tgId, { turbo_until: now()+20, boosts:b });
    res.json({ok:true, until: now()+20});
  }catch(e){
    console.error('/api/boost-turbo error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- TASKS ----------
app.post('/api/complete-task', auth, async (req,res)=>{
  try{
    const taskId = String(req.body.taskId||'');
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if((p.tasks_done||[]).includes(taskId)) return res.status(400).json({error:'done'});

    const REWARDS = { join_channel:25000, invite_3:50000, boost_5:30000 };
    if(taskId === 'invite_3'){
      const refs = await DB.referralCount(req.tgId);
      if((refs.data||0) < 3) return res.status(400).json({error:'not enough referrals'});
    }
    if(taskId === 'join_channel'){
      try{
        const member = await bot.api.getChatMember('@squirrel_combat_news', req.tgId);
        if(!['member','administrator','creator'].includes(member.status))
          return res.status(400).json({error:'not subscribed'});
      }catch(e){}
    }
    const reward = REWARDS[taskId];
    if(!reward) return res.status(400).json({error:'unknown task'});
    await DB.updatePlayer(req.tgId, {
      balance: p.balance + reward,
      tasks_done: [...(p.tasks_done||[]), taskId]
    });
    res.json({ok:true, reward});
  }catch(e){
    console.error('/api/complete-task error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- LEAGUE ----------
app.get('/api/league', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const th = [0,5e3,25e3,1e5,5e5,1e6,5e6,1e7,5e7,1e8];
    const cur = p.league||1;
    const nextTh = th[cur] || th[th.length-1];
    res.json({
      league: cur, total: p.total_earned,
      nextThreshold: nextTh,
      progress: Math.min(1, p.total_earned / (nextTh||1))
    });
  }catch(e){
    console.error('/api/league error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- TOP ----------
let TOP_CACHE = null, TOP_CACHE_TS = 0;
app.get('/api/top', async (_, res)=>{
  try{
    if(TOP_CACHE && Date.now() - TOP_CACHE_TS < 60000) return res.json(TOP_CACHE);
    const data = await DB.topPlayers(50);
    TOP_CACHE = data; TOP_CACHE_TS = Date.now();
    res.json(data);
  }catch(e){
    console.error('/api/top error:', e);
    res.json([]);
  }
});

// ---------- DUEL ----------
app.post('/api/duel/create', auth, async (req,res)=>{
  try{
    const stake = Math.max(1000, Math.min(1e6, parseInt(req.body.stake)||1000));
    const p = await DB.getPlayer(req.tgId);
    if(p.balance < stake) return res.status(400).json({error:'not enough'});
    await DB.updatePlayer(req.tgId, { balance: p.balance - stake });
    const id = Math.random().toString(36).slice(2,10);
    await DB.createDuel(id, req.tgId);
    await DB.updateDuel(id, {stake, duration:15});
    const me = await bot.api.getMe();
    res.json({ id, link:`https://t.me/${me.username}?start=duel_${id}` });
  }catch(e){
    console.error('/api/duel/create error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/duel/join', auth, async (req,res)=>{
  try{
    const id = String(req.body.id||'');
    const d = await DB.getDuel(id);
    if(!d) return res.status(404).json({error:'no duel'});
    if(d.guest_id) return res.status(400).json({error:'taken'});
    if(d.host_id === req.tgId) return res.status(400).json({error:'self'});
    const p = await DB.getPlayer(req.tgId);
    if(p.balance < d.stake) return res.status(400).json({error:'not enough'});
    await DB.updatePlayer(req.tgId, { balance: p.balance - d.stake });
    await DB.updateDuel(id, { guest_id:req.tgId, status:'ready', started_at: now() });
    res.json({ok:true});
  }catch(e){
    console.error('/api/duel/join error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/duel/poll', auth, async (req,res)=>{
  try{
    const id = String(req.body.id||'');
    const d = await DB.getDuel(id);
    if(!d) return res.status(404).json({error:'no duel'});
    if(d.host_id !== req.tgId && d.guest_id !== req.tgId)
      return res.status(403).json({error:'not in duel'});
    const t = now();
    const elapsed = d.started_at ? t - d.started_at : 0;
    const timeLeft = Math.max(0, (d.duration||15) - elapsed);
    const isHost = d.host_id === req.tgId;

    if(d.status !== 'settled' && d.started_at && timeLeft <= 0){
      const winner = d.host_score > d.guest_score ? d.host_id
                    : d.guest_score > d.host_score ? d.guest_id : null;
      const pot = d.stake * 2;
      if(winner){
        const w = await DB.getPlayer(winner);
        await DB.updatePlayer(winner, {
          balance: w.balance + pot, total_earned: w.total_earned + pot,
          pvp_wins: (w.pvp_wins||0)+1, pvp_rating: (w.pvp_rating||1000)+25
        });
        const loserId = winner === d.host_id ? d.guest_id : d.host_id;
        const l = await DB.getPlayer(loserId);
        await DB.updatePlayer(loserId, {
          pvp_losses: (l.pvp_losses||0)+1, pvp_rating: Math.max(100,(l.pvp_rating||1000)-25)
        });
        bumpQuest(winner, 'duel', 1);
      } else {
        for(const uid of [d.host_id, d.guest_id]){
          const u = await DB.getPlayer(uid);
          await DB.updatePlayer(uid, { balance: u.balance + d.stake });
        }
      }
      await DB.updateDuel(id, { status:'settled', settled_at:t });
      d.status='settled';
    }

    res.json({
      id, status:d.status, started:d.started_at>0, timeLeft,
      hostScore:d.host_score||0, guestScore:d.guest_score||0,
      your:isHost?'host':'guest',
      finished: d.status==='settled' || timeLeft<=0
    });
  }catch(e){
    console.error('/api/duel/poll error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/duel/tap', auth, async (req,res)=>{
  try{
    const id = String(req.body.id||'');
    const count = Math.max(1, Math.min(10, parseInt(req.body.count)||1));
    const d = await DB.getDuel(id);
    if(!d || d.status === 'settled') return res.status(400).json({error:'inactive'});
    const elapsed = now() - (d.started_at||0);
    if(elapsed < 0 || elapsed > (d.duration||15)) return res.status(400).json({error:'not running'});
    if(d.host_id === req.tgId){
      await DB.updateDuel(id, { host_score: (d.host_score||0)+count });
    } else if(d.guest_id === req.tgId){
      await DB.updateDuel(id, { guest_score: (d.guest_score||0)+count });
    } else return res.status(403).json({error:'not in duel'});
    res.json({ok:true});
  }catch(e){
    console.error('/api/duel/tap error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- PREMIUM ----------
app.post('/api/premium/buy', auth, async (req,res)=>{
  try{
    const days = Math.max(1, Math.min(365, parseInt(req.body.days)||30));
    const p = await DB.getPlayer(req.tgId);
    const COST = days * 1000;
    if(p.balance < COST) return res.status(400).json({error:'not enough'});
    const base = Math.max(p.premium_until || now(), now());
    await DB.updatePlayer(req.tgId, {
      balance: p.balance - COST, premium_until: base + days*86400
    });
    res.json({ok:true, until: base + days*86400});
  }catch(e){
    console.error('/api/premium/buy error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- SESSION ----------
const SESSION_TIERS = [
  {lvl:1, sec:10800, mult:1.0},
  {lvl:2, sec:10800, mult:1.3, cost:25000},
  {lvl:3, sec:10800, mult:1.7, cost:100000},
  {lvl:4, sec:10800, mult:2.2, cost:500000},
  {lvl:5, sec:10800, mult:3.0, cost:2000000}
];
function sessionAccrue(p){
  if(!p.session_start || !p.session_dur) return 0;
  const elapsed = Math.min(now() - p.session_start, p.session_dur);
  if(elapsed <= 0) return 0;
  const mult = parseFloat(p.session_mult) || 1;
  return Math.max(0, Math.floor((p.per_hour/3600) * mult * elapsed));
}
app.post('/api/session/start', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if(p.session_start && now() - p.session_start < (p.session_dur||0))
      return res.status(400).json({error:'already active'});
    await DB.updatePlayer(req.tgId, {
      session_start: now(), session_dur: 10800, session_accrued: 0,
      session_mult: p.session_mult || 1.0
    });
    res.json({ok:true});
  }catch(e){
    console.error('/api/session/start error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/session/status', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const elapsed = p.session_start ? Math.min(now()-p.session_start, p.session_dur||0) : 0;
    res.json({
      start:p.session_start, dur:p.session_dur||10800, elapsed,
      accrued: sessionAccrue(p), ready: elapsed >= (p.session_dur||10800),
      perHour: p.per_hour, mult: p.session_mult||1.0,
      speedLevel: p.session_speed_level||1, tiers: SESSION_TIERS
    });
  }catch(e){
    console.error('/api/session/status error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/session/claim', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if(!p.session_start) return res.status(400).json({error:'no session'});
    if(now() - p.session_start < 1800) return res.status(400).json({error:'min 30 min'});
    const gain = sessionAccrue(p);
    if(gain <= 0) return res.status(400).json({error:'nothing'});
    await DB.updatePlayer(req.tgId, {
      balance: p.balance + gain, total_earned: p.total_earned + gain,
      session_start: 0, session_dur: 0, session_accrued: 0,
      league: leagueFor(p.total_earned + gain)
    });
    bumpQuest(req.tgId, 'session', 1);
    safeRpc('pay_referrals', { p_from:req.tgId, p_amount:gain, p_source:'session' });
    res.json({ok:true, gain});
  }catch(e){
    console.error('/api/session/claim error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/session/upgrade', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const cur = p.session_speed_level||1;
    const next = SESSION_TIERS.find(t=>t.lvl===cur+1);
    if(!next) return res.status(400).json({error:'max level'});
    if(p.balance < next.cost) return res.status(400).json({error:'not enough'});
    await DB.updatePlayer(req.tgId, {
      balance: p.balance - next.cost,
      session_speed_level: next.lvl, session_mult: next.mult
    });
    res.json({ok:true, level:next.lvl, mult:next.mult});
  }catch(e){
    console.error('/api/session/upgrade error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- DAILY QUESTS ----------
async function ensureDailyQuests(tgId){
  try{
    const day = todayUTC();
    const tgNum = parseInt(tgId, 10);
    console.log('[ensureDailyQuests] start', tgNum, day);

    const { data: existing, error: e1 } = await sbAdmin.from('daily_quests')
      .select('*').eq('tg_id', tgNum).eq('day', day);
    if(e1){ console.error('[daily select error]', JSON.stringify(e1)); }
    if(existing && existing.length){
      console.log('[ensureDailyQuests] existing', existing.length);
      return existing;
    }

    const { data: pool, error: e2 } = await sbAdmin.from('quest_pool').select('*');
    if(e2){ console.error('[quest_pool error]', JSON.stringify(e2)); }
    if(!pool || !pool.length){
      console.error('[quest_pool empty]');
      return [];
    }
    console.log('[quest_pool size]', pool.length);

    const picked = [...pool].sort(()=>Math.random()-.5).slice(0,5);
    const rows = picked.map(q=>({
      tg_id:tgNum, day, quest_id:q.id, progress:0, goal:q.goal, claimed:false
    }));

    const { error: e3 } = await sbAdmin.from('daily_quests').insert(rows);
    if(e3){
      console.error('[daily insert error]', JSON.stringify(e3));
      return [];
    }
    console.log('[ensureDailyQuests] inserted', rows.length);
    return rows;
  }catch(e){
    console.error('[ensureDailyQuests fatal]', e.message, e.stack);
    return [];
  }
}

app.get('/api/daily/list', auth, async (req,res)=>{
  try{
    console.log('[/api/daily/list] called for', req.tgId);
    const quests = await ensureDailyQuests(req.tgId);
    console.log('[/api/daily/list] quests:', quests.length);
    if(!quests.length){ return res.json([]); }
    const ids = quests.map(q=>q.quest_id);
    const { data: pool, error } = await sbAdmin.from('quest_pool').select('*').in('id', ids);
    if(error){ console.error('[/api/daily/list pool error]', JSON.stringify(error)); }
    const pmap = {};
    (pool||[]).forEach(q=>{ pmap[q.id]=q; });
    const player = await DB.getPlayer(req.tgId);
    const lang = player?.lang || 'ru';
    res.json(quests.map(q=>{
      const p = pmap[q.quest_id]||{};
      return {
        id:q.quest_id, title:p['title_'+lang] || p.title_ru || q.quest_id,
        icon:p.icon||'🎯', progress:q.progress, goal:q.goal,
        reward:p.reward||0, xp:p.xp||0, claimed:q.claimed,
        done: q.progress >= q.goal
      };
    }));
  }catch(e){
    console.error('[/api/daily/list FATAL]', e.message, e.stack);
    res.json([]);
  }
});

app.post('/api/daily/claim', auth, async (req,res)=>{
  try{
    const day = todayUTC();
    const id = String(req.body.id||'');
    const { data: q } = await sbAdmin.from('daily_quests').select('*')
      .eq('tg_id', req.tgId).eq('day', day).eq('quest_id', id).maybeSingle();
    if(!q) return res.status(404).json({error:'no quest'});
    if(q.claimed) return res.status(400).json({error:'already claimed'});
    if(q.progress < q.goal) return res.status(400).json({error:'not done'});
    const { data: meta } = await sbAdmin.from('quest_pool').select('*').eq('id', id).single();
    const p = await DB.getPlayer(req.tgId);
    await sbAdmin.from('daily_quests').update({claimed:true})
      .eq('tg_id', req.tgId).eq('day', day).eq('quest_id', id);
    await DB.updatePlayer(req.tgId, {
      balance: p.balance + (meta?.reward||0),
      total_earned: p.total_earned + (meta?.reward||0),
      xp: (p.xp||0) + (meta?.xp||0)
    });
    res.json({ok:true, reward: meta?.reward||0, xp: meta?.xp||0});
  }catch(e){
    console.error('/api/daily/claim error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- ACHIEVEMENTS ----------
app.get('/api/ach/list', auth, async (req,res)=>{
  try{
    const lang = (await DB.getPlayer(req.tgId))?.lang || 'ru';
    const { data: all } = await sbAdmin.from('achievements').select('*');
    const { data: owned } = await sbAdmin.from('player_achievements').select('ach_id, unlocked_at').eq('tg_id', req.tgId);
    const ownedMap = {};
    (owned||[]).forEach(o=>{ ownedMap[o.ach_id]=o.unlocked_at; });
    const p = await DB.getPlayer(req.tgId);
    const metrics = {
      total_taps: p.total_taps||0,
      total_earned: p.total_earned||0,
      per_hour: p.per_hour||0,
      pvp_wins: p.pvp_wins||0,
      referrals: p.referrals||0,
      clan_joined:0, clan_created:0, clan_wins:0
    };
    const { data: cm } = await sbAdmin.from('clan_members').select('role').eq('tg_id', req.tgId).maybeSingle();
    if(cm){ metrics.clan_joined=1; if(cm.role==='owner') metrics.clan_created=1; }
    const { data: cl } = await sbAdmin.from('clans').select('war_wins').eq('owner_id', req.tgId);
    metrics.clan_wins = (cl||[]).reduce((a,c)=>a+(c.war_wins||0),0);
    res.json((all||[]).map(a=>({
      id: a.id,
      title: a['title_'+lang] || a.title_ru,
      desc: a['desc_'+lang] || a.desc_ru,
      tier: a.tier, category: a.category,
      reward: a.reward, xp: a.xp,
      progress: Math.min(metrics[a.metric]||0, a.threshold),
      goal: a.threshold,
      unlocked: !!ownedMap[a.id],
      unlocked_at: ownedMap[a.id] || null
    })));
  }catch(e){
    console.error('/api/ach/list error:', e);
    res.json([]);
  }
});

// ---------- SEASONS ----------
async function currentSeason(){
  const t = now();
  const { data } = await sbAdmin.from('seasons').select('*').eq('status','active')
    .lte('started_at', t).gte('ends_at', t).maybeSingle();
  return data;
}
app.get('/api/season/current', auth, async (req,res)=>{
  try{
    const s = await currentSeason();
    if(!s) return res.json({active:false});
    const { data: me } = await sbAdmin.from('season_scores')
      .select('score').eq('season_id', s.id).eq('tg_id', req.tgId).maybeSingle();
    const { count: rank } = await sbAdmin.from('season_scores')
      .select('*',{count:'exact',head:true})
      .eq('season_id', s.id).gt('score', me?.score || 0);
    res.json({
      active:true, id:s.id,
      endsAt:s.ends_at, startedAt:s.started_at,
      myScore: me?.score || 0,
      myRank: (rank||0) + 1,
      secondsLeft: Math.max(0, s.ends_at - now())
    });
  }catch(e){
    console.error('/api/season/current error:', e);
    res.json({active:false});
  }
});
app.get('/api/season/leaderboard', auth, async (req,res)=>{
  try{
    const s = await currentSeason();
    if(!s) return res.json([]);
    const { data: top } = await sbAdmin.from('season_scores')
      .select('tg_id, score').eq('season_id', s.id)
      .order('score',{ascending:false}).limit(100);
    const ids = (top||[]).map(x=>x.tg_id);
    const { data: pl } = await sbAdmin.from('players')
      .select('tg_id, first_name, username').in('tg_id', ids.length?ids:[0]);
    const pmap = {};
    (pl||[]).forEach(p=>{ pmap[p.tg_id]=p; });
    res.json((top||[]).map((x,i)=>({
      rank:i+1, tg_id:x.tg_id, score:x.score,
      name: pmap[x.tg_id]?.first_name || 'Игрок'
    })));
  }catch(e){
    console.error('/api/season/leaderboard error:', e);
    res.json([]);
  }
});

// ---------- WHEEL ----------
const WHEEL_PRIZES = [
  {idx:0, type:'coins', value:1000, label:'1 000', color:'#8338ec', weight:20},
  {idx:1, type:'coins', value:5000, label:'5 000', color:'#00bbf9', weight:18},
  {idx:2, type:'coins', value:10000, label:'10 000', color:'#06d6a0', weight:15},
  {idx:3, type:'energy', value:1, label:'⚡ Полная', color:'#ffd166', weight:14},
  {idx:4, type:'coins', value:25000, label:'25 000', color:'#ff006e', weight:10},
  {idx:5, type:'xp', value:100, label:'100 XP', color:'#9d4edd', weight:10},
  {idx:6, type:'coins', value:100000, label:'100 000', color:'#ffb703', weight:6},
  {idx:7, type:'premium', value:1, label:'💎 1 день', color:'#ffd60a', weight:3},
  {idx:8, type:'jackpot', value:1000000, label:'🎰 1М', color:'#ef476f', weight:1},
  {idx:9, type:'boost_turbo', value:3, label:'🔥 ×3', color:'#ff8c42', weight:3}
];
function weightedPrize(){
  const total = WHEEL_PRIZES.reduce((a,b)=>a+b.weight,0);
  let r = Math.random()*total;
  for(const p of WHEEL_PRIZES){ r -= p.weight; if(r<=0) return p; }
  return WHEEL_PRIZES[0];
}
app.get('/api/wheel/info', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const ready = (now() - (p.wheel_last||0)) >= 86400;
    const { data: hist } = await sbAdmin.from('wheel_history')
      .select('prize_type, prize_value, spun_at').eq('tg_id', req.tgId)
      .order('spun_at',{ascending:false}).limit(10);
    res.json({
      ready, nextIn: ready?0:86400-(now()-(p.wheel_last||0)),
      streak: p.wheel_streak||0, prizes: WHEEL_PRIZES, history: hist||[]
    });
  }catch(e){
    console.error('/api/wheel/info error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/wheel/spin', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    if((now() - (p.wheel_last||0)) < 86400) return res.status(400).json({error:'cooldown'});
    const prize = weightedPrize();
    const t = now();
    let msg = '';
    const update = { wheel_last:t, wheel_streak:(p.wheel_streak||0)+1 };
    if(prize.type === 'coins'){
      update.balance = p.balance + prize.value;
      update.total_earned = p.total_earned + prize.value;
      msg = `+${prize.value} орехов`;
    } else if(prize.type === 'energy'){
      const b = {...p.boosts}; b.full_energy = (b.full_energy||0)+1; update.boosts = b;
      msg = `+1 полная энергия`;
    } else if(prize.type === 'xp'){
      update.xp = (p.xp||0) + prize.value; msg = `+${prize.value} XP`;
    } else if(prize.type === 'premium'){
      const base = Math.max(p.premium_until||t, t);
      update.premium_until = base + 86400; msg = `+1 день премиума`;
    } else if(prize.type === 'boost_turbo'){
      const b = {...p.boosts}; b.turbo = (b.turbo||0)+prize.value; update.boosts = b;
      msg = `+${prize.value} турбо`;
    } else if(prize.type === 'jackpot'){
      update.balance = p.balance + prize.value;
      update.total_earned = p.total_earned + prize.value;
      msg = `🎰 ДЖЕКПОТ 1 000 000`;
    }
    await DB.updatePlayer(req.tgId, update);
    await sbAdmin.from('wheel_history').insert({
      tg_id:req.tgId, prize_index:prize.idx, prize_type:prize.type,
      prize_value:prize.value, spun_at:t
    });
    res.json({ok:true, prize, msg});
  }catch(e){
    console.error('/api/wheel/spin error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- PROMO ----------
app.post('/api/promo/redeem', auth, async (req,res)=>{
  try{
    const code = String(req.body.code||'').trim().toUpperCase();
    if(!code) return res.status(400).json({error:'empty'});
    const { data: promo } = await sbAdmin.from('promos').select('*').eq('code', code).maybeSingle();
    if(!promo) return res.status(404).json({error:'not found'});
    if(promo.expires_at && promo.expires_at < now()) return res.status(400).json({error:'expired'});
    if(promo.uses_left <= 0) return res.status(400).json({error:'no uses'});
    const { data: used } = await sbAdmin.from('promo_uses').select('*')
      .eq('code',code).eq('tg_id',req.tgId).maybeSingle();
    if(used) return res.status(400).json({error:'already used'});
    const p = await DB.getPlayer(req.tgId);
    if(p.league < promo.min_league) return res.status(400).json({error:`need league ${promo.min_league}`});

    if(promo.kind === 'coins'){
      await DB.updatePlayer(req.tgId, {
        balance: p.balance + promo.reward, total_earned: p.total_earned + promo.reward
      });
    } else if(promo.kind === 'boost_energy'){
      const b = {...p.boosts}; b.full_energy = (b.full_energy||0) + promo.reward;
      await DB.updatePlayer(req.tgId, { boosts: b });
    } else if(promo.kind === 'premium_days'){
      const base = Math.max(p.premium_until||now(), now());
      await DB.updatePlayer(req.tgId, { premium_until: base + promo.reward*86400 });
    }
    await sbAdmin.from('promo_uses').insert({code, tg_id:req.tgId, used_at: now()});
    await sbAdmin.from('promos').update({uses_left: promo.uses_left - 1}).eq('code', code);
    res.json({ok:true, reward:promo.reward, kind:promo.kind});
  }catch(e){
    console.error('/api/promo/redeem error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- LANG ----------
app.post('/api/lang/set', auth, async (req,res)=>{
  try{
    const lang = ['ru','en','es'].includes(req.body.lang)?req.body.lang:'ru';
    await DB.updatePlayer(req.tgId, { lang });
    res.json({ok:true, lang});
  }catch(e){
    console.error('/api/lang/set error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- CLAN ----------
app.post('/api/clan/create', auth, async (req,res)=>{
  try{
    const name = String(req.body.name||'').trim().slice(0,30);
    const tag = String(req.body.tag||'').trim().slice(0,5).toUpperCase();
    const emblem = String(req.body.emblem||'🛡️').slice(0,4);
    if(!name || !tag) return res.status(400).json({error:'name and tag required'});
    const { data: mine } = await sbAdmin.from('clan_members').select('clan_id').eq('tg_id', req.tgId).maybeSingle();
    if(mine) return res.status(400).json({error:'already in clan'});
    const cost = 50000;
    const p = await DB.getPlayer(req.tgId);
    if(p.balance < cost) return res.status(400).json({error:'need 50000'});
    const id = 'c_' + Math.random().toString(36).slice(2,10);
    const t = now();
    const { error: e1 } = await sbAdmin.from('clans').insert({
      id, name, tag, owner_id:req.tgId, created_at:t, emblem, treasury:0, total_earned:0, is_open:true
    });
    if(e1) return res.status(400).json({error:e1.message});
    await sbAdmin.from('clan_members').insert({
      clan_id:id, tg_id:req.tgId, role:'owner', joined_at:t, contribution:0
    });
    await DB.updatePlayer(req.tgId, { balance: p.balance - cost });
    res.json({ok:true, id});
  }catch(e){
    console.error('/api/clan/create error:', e);
    res.status(500).json({error: e.message});
  }
});
app.get('/api/clan/list', auth, async (req,res)=>{
  try{
    const { data } = await sbAdmin.from('clans').select('*')
      .order('total_earned',{ascending:false}).limit(50);
    const ids = (data||[]).map(c=>c.id);
    const { data: counts } = await sbAdmin.from('clan_members')
      .select('clan_id').in('clan_id', ids.length?ids:['_']);
    const map = {};
    (counts||[]).forEach(r=>{ map[r.clan_id]=(map[r.clan_id]||0)+1; });
    res.json((data||[]).map(c=>({...c, members: map[c.id]||0})));
  }catch(e){
    console.error('/api/clan/list error:', e);
    res.json([]);
  }
});
app.post('/api/clan/me', auth, async (req,res)=>{
  try{
    const { data: m } = await sbAdmin.from('clan_members').select('*').eq('tg_id', req.tgId).maybeSingle();
    if(!m) return res.json({inClan:false});
    const { data: clan } = await sbAdmin.from('clans').select('*').eq('id', m.clan_id).single();
    const { data: members } = await sbAdmin.from('clan_members')
      .select('tg_id, role, contribution, joined_at').eq('clan_id', m.clan_id)
      .order('contribution',{ascending:false}).limit(50);
    const tgIds = (members||[]).map(x=>x.tg_id);
    const { data: players } = await sbAdmin.from('players')
      .select('tg_id, first_name, username, balance, total_earned')
      .in('tg_id', tgIds.length?tgIds:[0]);
    const pmap = {};
    (players||[]).forEach(p=>{ pmap[p.tg_id]=p; });
    const enriched = (members||[]).map(x=>({
      ...x, name: pmap[x.tg_id]?.first_name||'Игрок',
      username: pmap[x.tg_id]?.username||null,
      total_earned: pmap[x.tg_id]?.total_earned||0
    }));
    res.json({inClan:true, clan, members:enriched, myRole:m.role});
  }catch(e){
    console.error('/api/clan/me error:', e);
    res.json({inClan:false});
  }
});
app.post('/api/clan/join', auth, async (req,res)=>{
  try{
    const id = String(req.body.clanId||'');
    const { data: mine } = await sbAdmin.from('clan_members').select('clan_id').eq('tg_id', req.tgId).maybeSingle();
    if(mine) await sbAdmin.from('clan_members').delete().eq('tg_id', req.tgId);
    const { data: result, error } = await sbAdmin.rpc('clan_join', { p_clan:id, p_tg:req.tgId });
    if(error || result !== 'ok') return res.status(400).json({error: result || error?.message || 'fail'});
    res.json({ok:true});
  }catch(e){
    console.error('/api/clan/join error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/clan/leave', auth, async (req,res)=>{
  try{
    await sbAdmin.from('clan_members').delete().eq('tg_id', req.tgId);
    res.json({ok:true});
  }catch(e){
    console.error('/api/clan/leave error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/clan/donate', auth, async (req,res)=>{
  try{
    const amount = Math.max(1000, Math.min(1e6, parseInt(req.body.amount)||1000));
    const p = await DB.getPlayer(req.tgId);
    if(p.balance < amount) return res.status(400).json({error:'not enough'});
    const { data: m } = await sbAdmin.from('clan_members').select('clan_id').eq('tg_id', req.tgId).maybeSingle();
    if(!m) return res.status(400).json({error:'not in clan'});
    await DB.updatePlayer(req.tgId, { balance: p.balance - amount });
    await sbAdmin.rpc('clan_add_contribution', { p_clan:m.clan_id, p_tg:req.tgId, p_amount:amount });
    res.json({ok:true});
  }catch(e){
    console.error('/api/clan/donate error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- REF ----------
app.post('/api/ref/stats', auth, async (req,res)=>{
  try{
    const p = await DB.getPlayer(req.tgId);
    if(!p) return res.status(404).json({error:'no player'});
    const { data: lvl1 } = await sbAdmin.from('players')
      .select('tg_id, first_name, total_earned').eq('referrer_id', req.tgId).limit(100);
    const { data: lvl2 } = await sbAdmin.from('players')
      .select('tg_id, first_name, total_earned').eq('referrer_lvl2', req.tgId).limit(200);
    const { data: lvl3 } = await sbAdmin.from('players')
      .select('tg_id, first_name, total_earned').eq('referrer_lvl3', req.tgId).limit(500);
    const { data: earnings } = await sbAdmin.from('ref_earnings')
      .select('level, amount').eq('tg_id', req.tgId).limit(10000);
    const totalByLevel = {1:0,2:0,3:0};
    (earnings||[]).forEach(e=>{ totalByLevel[e.level] = (totalByLevel[e.level]||0) + Number(e.amount); });
    res.json({
      lvl1: lvl1||[], lvl2: lvl2||[], lvl3: lvl3||[],
      earned: totalByLevel,
      totalEarned: Object.values(totalByLevel).reduce((a,b)=>a+b,0),
      rates: { l1:0.10, l2:0.05, l3:0.02 }
    });
  }catch(e){
    console.error('/api/ref/stats error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- REF CONTEST ----------
async function currentRefContest(){
  const { data } = await sbAdmin.from('ref_contests').select('*').eq('status','active').maybeSingle();
  return data;
}
app.get('/api/ref-contest/current', auth, async (req,res)=>{
  try{
    const c = await currentRefContest();
    if(!c) return res.json({active:false});
    const { data: me } = await sbAdmin.from('ref_contest_scores')
      .select('score').eq('contest_id',c.id).eq('tg_id',req.tgId).maybeSingle();
    const { count: rank } = await sbAdmin.from('ref_contest_scores')
      .select('*',{count:'exact',head:true}).eq('contest_id',c.id).gt('score',me?.score||0);
    res.json({
      active:true, id:c.id, endsAt:c.ends_at, prizePool:c.prize_pool,
      myScore: me?.score||0, myRank:(rank||0)+1, secondsLeft: Math.max(0, c.ends_at - now())
    });
  }catch(e){
    console.error('/api/ref-contest/current error:', e);
    res.json({active:false});
  }
});
app.get('/api/ref-contest/leaderboard', auth, async (req,res)=>{
  try{
    const c = await currentRefContest();
    if(!c) return res.json([]);
    const { data: top } = await sbAdmin.from('ref_contest_scores')
      .select('tg_id, score').eq('contest_id',c.id)
      .order('score',{ascending:false}).limit(50);
    const ids = (top||[]).map(x=>x.tg_id);
    const { data: pl } = await sbAdmin.from('players')
      .select('tg_id, first_name').in('tg_id', ids.length?ids:[0]);
    const pmap = {};
    (pl||[]).forEach(p=>{ pmap[p.tg_id]=p; });
    res.json((top||[]).map((x,i)=>({rank:i+1, name:pmap[x.tg_id]?.first_name||'Игрок', score:x.score})));
  }catch(e){
    console.error('/api/ref-contest/leaderboard error:', e);
    res.json([]);
  }
});

// ---------- CHANNEL ----------
app.post('/api/channel/create', auth, async (req,res)=>{
  try{
    const title = String(req.body.title||'').trim().slice(0,60);
    const username = String(req.body.username||'').replace(/[^a-zA-Z0-9_]/g,'').slice(0,32);
    if(!title || !username) return res.status(400).json({error:'title and username'});
    const id = 'ch_' + Math.random().toString(36).slice(2,8);
    const { error } = await sbAdmin.from('channels').insert({
      id, owner_id:req.tgId, title, username,
      link:`https://t.me/your_bot?start=ch_${id}`,
      rate:0.15, clicks:0, signups:0, earnings:0, balance:0,
      created_at:now(), status:'active'
    });
    if(error) return res.status(400).json({error:error.message});
    res.json({ok:true, id});
  }catch(e){
    console.error('/api/channel/create error:', e);
    res.status(500).json({error: e.message});
  }
});
app.post('/api/channel/me', auth, async (req,res)=>{
  try{
    const { data } = await sbAdmin.from('channels').select('*').eq('owner_id', req.tgId).maybeSingle();
    if(!data) return res.json({has:false});
    const { count: refs } = await sbAdmin.from('channel_referrals')
      .select('*',{count:'exact',head:true}).eq('channel_id', data.id);
    const { data: history } = await sbAdmin.from('channel_payouts')
      .select('*').eq('channel_id', data.id).order('created_at',{ascending:false}).limit(20);
    res.json({has:true, channel:data, referrals:refs||0, payouts:history||[]});
  }catch(e){
    console.error('/api/channel/me error:', e);
    res.json({has:false});
  }
});
app.post('/api/channel/withdraw', auth, async (req,res)=>{
  try{
    const amount = Math.max(10000, Math.min(1e9, parseInt(req.body.amount)||0));
    const { data: ch } = await sbAdmin.from('channels').select('*').eq('owner_id', req.tgId).maybeSingle();
    if(!ch) return res.status(404).json({error:'no channel'});
    if(ch.balance < amount) return res.status(400).json({error:'not enough'});
    await sbAdmin.from('channels').update({balance: ch.balance - amount}).eq('id', ch.id);
    await sbAdmin.from('channel_payouts').insert({
      channel_id:ch.id, amount, method:'manual', status:'pending', created_at:now()
    });
    res.json({ok:true});
  }catch(e){
    console.error('/api/channel/withdraw error:', e);
    res.status(500).json({error: e.message});
  }
});

// ---------- ADMIN ----------
app.get('/api/admin/stats', auth, adminOnly, async (req,res)=>{
  try{
    const dayAgo = now() - 86400;
    const { count: total } = await sbAdmin.from('players').select('*',{count:'exact',head:true});
    const { count: active } = await sbAdmin.from('players').select('*',{count:'exact',head:true}).gte('last_seen', dayAgo);
    const { count: clans } = await sbAdmin.from('clans').select('*',{count:'exact',head:true});
    const { count: duels } = await sbAdmin.from('duels').select('*',{count:'exact',head:true});
    const { count: bans } = await sbAdmin.from('players').select('*',{count:'exact',head:true}).eq('banned', true);
    const { data: top } = await sbAdmin.from('players')
      .select('first_name, total_earned').order('total_earned',{ascending:false}).limit(5);
    res.json({ total:total||0, active:active||0, clans:clans||0, duels:duels||0, bans:bans||0, top:top||[] });
  }catch(e){
    console.error('/api/admin/stats error:', e);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/admin/dashboard', auth, adminOnly, async (req,res)=>{
  try{
    const days = Math.max(7, Math.min(90, parseInt(req.query.days)||30));
    const since = new Date(Date.now() - days*864e5).toISOString().slice(0,10);
    try{ await sbAdmin.rpc('snapshot_daily'); }catch(e){}
    const { data: metrics } = await sbAdmin.from('daily_metrics')
      .select('*').gte('day', since).order('day');
    const dayAgo = now() - 86400;
    const weekAgo = now() - 7*86400;
    const { count: total } = await sbAdmin.from('players').select('*',{count:'exact',head:true});
    const { count: active24 } = await sbAdmin.from('players').select('*',{count:'exact',head:true}).gte('last_seen',dayAgo);
    const { count: active7 } = await sbAdmin.from('players').select('*',{count:'exact',head:true}).gte('last_seen',weekAgo);
    const { count: clans } = await sbAdmin.from('clans').select('*',{count:'exact',head:true});
    const { count: duels } = await sbAdmin.from('duels').select('*',{count:'exact',head:true});
    const { count: promosUsed } = await sbAdmin.from('promo_uses').select('*',{count:'exact',head:true});
    const { data: top } = await sbAdmin.from('players')
      .select('first_name, total_earned, league').order('total_earned',{ascending:false}).limit(10);
    const { data: recent } = await sbAdmin.from('players')
      .select('tg_id, first_name, created_at, total_earned').order('created_at',{ascending:false}).limit(20);
    res.json({
      metrics: metrics||[],
      totals: {total:total||0, active24:active24||0, active7:active7||0, clans:clans||0, duels:duels||0, promosUsed:promosUsed||0},
      top: top||[], recent: recent||[]
    });
  }catch(e){
    console.error('/api/admin/dashboard error:', e);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/admin/export/:type', auth, adminOnly, async (req,res)=>{
  try{
    const type = String(req.params.type);
    const tables = {
      players:'players', history:'ref_earnings', clans:'clans',
      duels:'duels', promos:'promo_uses', channels:'channel_referrals'
    };
    const table = tables[type];
    if(!table) return res.status(400).send('unknown type');
    const { data } = await sbAdmin.from(table).select('*').limit(10000);
    if(!data?.length) return res.status(404).send('empty');
    const keys = Object.keys(data[0]);
    const esc = v => {
      if(v === null || v === undefined) return '';
      const s = String(v).replace(/"/g,'""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = '\uFEFF' + [keys.join(',')].concat(
      data.map(r => keys.map(k=>esc(r[k])).join(','))
    ).join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  }catch(e){
    console.error('/api/admin/export error:', e);
    res.status(500).send('error');
  }
});

// ---------- PUBLIC ----------
let PUB_CACHE = null, PUB_TS = 0;
app.get('/api/public/stats', async (_,res)=>{
  try{
    if(PUB_CACHE && Date.now() - PUB_TS < 120000) return res.json(PUB_CACHE);
    const { count: players } = await sbAdmin.from('players').select('*',{count:'exact',head:true});
    const { count: clans } = await sbAdmin.from('clans').select('*',{count:'exact',head:true});
    const { count: duels } = await sbAdmin.from('duels').select('*',{count:'exact',head:true});
    PUB_CACHE = {
      players: Math.max(players||0, 1000),
      clans: Math.max(clans||0, 50),
      duels: Math.max(duels||0, 500),
      season: 10000000
    };
    PUB_TS = Date.now();
    res.json(PUB_CACHE);
  }catch(e){
    res.json({players:1000, clans:50, duels:500, season:10000000});
  }
});

// ---------- STATIC ----------
app.get('/', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ---------- WEBHOOK ----------
app.post(`/bot${process.env.BOT_TOKEN}`, (req,res)=>{
  try{
    return webhookCallback(bot, 'express')(req,res);
  }catch(e){
    console.error('webhook error', e);
    res.sendStatus(200);
  }
});

// ---------- CRON ----------
setInterval(async ()=>{
  try{ await sbAdmin.rpc('snapshot_daily'); }catch(e){}
}, 15*60000);

// ---------- START ----------
app.listen(PORT, async ()=>{
  console.log(`🐿️ Squirrel Combat online on ${PORT}`);
  const url = `${process.env.WEBAPP_URL}/bot${process.env.BOT_TOKEN}`;

  for(let attempt = 1; attempt <= 5; attempt++){
    try{
      await bot.api.setWebhook(url, { drop_pending_updates:true });
      console.log(`✅ Webhook установлен (попытка ${attempt}):`, url);
      break;
    }catch(e){
      console.error(`⚠️ Webhook attempt ${attempt} failed:`, e.message);
      if(attempt < 5) await new Promise(r=>setTimeout(r, 3000));
    }
  }

  setInterval(async ()=>{
    try{
      const info = await bot.api.getWebhookInfo();
      if(info.url !== url){
        console.log('Webhook не совпадает, переустанавливаю...');
        await bot.api.setWebhook(url, { drop_pending_updates:false });
        console.log('✅ Webhook восстановлен');
      }
    }catch(e){ }
  }, 5*60000);
});
