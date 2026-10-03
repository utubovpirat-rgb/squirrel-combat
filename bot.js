// bot.js — Telegram-бот Squirrel Combat
import { Bot, InlineKeyboard } from 'grammy';
import 'dotenv/config';
import { DB, sbAdmin } from './db.js';

export const bot = new Bot(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL;
const CHANNEL_URL = 'https://t.me/squirrel_combat_news';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(x=>parseInt(x)).filter(Boolean);

bot.catch((err)=>{
  console.error('Bot error:', err);
});

// ---------- /start ----------
bot.command('start', async (ctx) => {
  const tgId = ctx.from.id;
  const uname = ctx.from.username || null;
  const fname = ctx.from.first_name || 'Игрок';
  const payload = String(ctx.match || '');

  let referrerId = null;
  if(payload.startsWith('ref_')){
    const rid = parseInt(payload.slice(4));
    if(!isNaN(rid) && rid !== tgId) referrerId = rid;
  }

  let channelId = null;
  if(payload.startsWith('ch_')){
    channelId = payload.slice(3);
  }

  if(payload.startsWith('duel_')){
    const duelId = payload.slice(5);
    const kb = new InlineKeyboard()
      .webApp('⚔️ Присоединиться к дуэли', `${WEBAPP_URL}?duel=${duelId}`);
    return ctx.reply('⚔️ Тебя вызвали на дуэль! Открой мини-апп чтобы принять.', { reply_markup: kb });
  }

  let p = await DB.getPlayer(tgId);
  if(!p){
    p = await DB.createPlayer(tgId, uname, fname, referrerId);
    if(referrerId){
      try{
        const { data: refCount } = await DB.referralCount(referrerId);
        if(refCount < 20){
          await DB.addBalance(referrerId, 25000);
          await DB.addBalance(tgId, 25000);
          await DB.logReferral(referrerId, tgId, 25000);
          const { data: rc } = await sbAdmin.from('ref_contests').select('*').eq('status','active').maybeSingle();
          if(rc){
            const { data: s } = await sbAdmin.from('ref_contest_scores')
              .select('score').eq('contest_id', rc.id).eq('tg_id', referrerId).maybeSingle();
            await sbAdmin.from('ref_contest_scores').upsert({
              contest_id: rc.id, tg_id: referrerId, score: (s?.score||0) + 1
            });
          }
        }
      }catch(e){ console.error('ref bonus', e); }
    }
    if(channelId){
      try{
        const { data: ch } = await sbAdmin.from('channels').select('*').eq('id', channelId).maybeSingle();
        if(ch){
          const { error: e } = await sbAdmin.from('channel_referrals').insert({
            channel_id: channelId, tg_id: tgId, joined_at: Math.floor(Date.now()/1000)
          });
          if(!e) await sbAdmin.from('channels').update({ signups: (ch.signups||0)+1 }).eq('id', channelId);
        }
      }catch(e){ console.error('channel reg', e); }
    }
  } else {
    await DB.updatePlayer(tgId, { last_seen: Math.floor(Date.now()/1000) });
  }

  const kb = new InlineKeyboard()
    .webApp('🐿️ Открыть Squirrel Combat', WEBAPP_URL).row()
    .url('📢 Наш канал', CHANNEL_URL);

  await ctx.reply(
    `🐿️ <b>Squirrel Combat</b>\n\n` +
    `Тапай белку, собирай орехи, качай доход в час, поднимайся в лигах.\n\n` +
    `Приглашай друзей — <b>25 000 орехов</b> каждому.`,
    { parse_mode:'HTML', reply_markup: kb }
  );
});

// ---------- /help ----------
bot.command('help', async (ctx) => {
  await ctx.reply(
    `🐿️ <b>Команды</b>\n` +
    `/start — играть\n/stats — статистика\n/top — топ-10\n/invite — реф-ссылка\n` +
    `/duel — создать дуэль\n/clan — клан\n/premium — премиум\n/stars — купить за звёзды`,
    { parse_mode:'HTML' }
  );
});

// ---------- /stats ----------
bot.command('stats', async (ctx) => {
  const p = await DB.getPlayer(ctx.from.id);
  if(!p) return ctx.reply('Сначала /start');
  await ctx.reply(
    `🐿️ <b>${p.first_name}</b>\n` +
    `Баланс: <b>${Number(p.balance).toLocaleString('ru')}</b>\n` +
    `Всего: ${Number(p.total_earned).toLocaleString('ru')}\n` +
    `В час: ${Number(p.per_hour).toLocaleString('ru')}\n` +
    `За тап: ${p.per_click}\n` +
    `Лига: ${p.league || 1}/10\n` +
    `Рефералов: ${p.referrals || 0}\n` +
    `PvP: ${p.pvp_wins||0}W / ${p.pvp_losses||0}L · рейтинг ${p.pvp_rating||1000}`,
    { parse_mode:'HTML' }
  );
});

// ---------- /top ----------
bot.command('top', async (ctx) => {
  const top = await DB.topPlayers(10);
  if(!top.length) return ctx.reply('Пока пусто.');
  const lines = top.map((p,i)=>{
    const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
    return `${medal} ${p.first_name} — ${Number(p.total_earned).toLocaleString('ru')}`;
  });
  await ctx.reply('🏆 <b>Топ-10</b>\n\n' + lines.join('\n'), {parse_mode:'HTML'});
});

// ---------- /invite ----------
bot.command('invite', async (ctx) => {
  const me = await bot.api.getMe();
  const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;
  const p = await DB.getPlayer(ctx.from.id);
  await ctx.reply(
    `🔗 <b>Твоя ссылка:</b>\n${link}\n\n` +
    `Приглашено: <b>${p?.referrals || 0}</b>\n` +
    `За каждого друга — 25 000 орехов тебе и ему.`,
    { parse_mode:'HTML' }
  );
});

// ---------- /duel ----------
bot.command('duel', async (ctx) => {
  const id = Math.random().toString(36).slice(2,10);
  const me = await bot.api.getMe();
  const link = `https://t.me/${me.username}?start=duel_${id}`;
  await DB.createDuel(id, ctx.from.id);
  await ctx.reply(
    `⚔️ <b>PvP-дуэль создана</b>\n\nОтправь другу:\n${link}\n\nПобедитель забирает ставку.`,
    { parse_mode:'HTML' }
  );
});

// ---------- /clan ----------
bot.command('clan', async (ctx) => {
  const kb = new InlineKeyboard().webApp('🛡️ Открыть клан', `${WEBAPP_URL}#clan`);
  await ctx.reply('🛡️ <b>Кланы Squirrel Combat</b>\n\nСоздавай свой клан, вступай в чужие, объявляй войны.', {parse_mode:'HTML', reply_markup:kb});
});

// ---------- /premium ----------
bot.command('premium', async (ctx) => {
  const p = await DB.getPlayer(ctx.from.id);
  const until = p?.premium_until || 0;
  const t = Math.floor(Date.now()/1000);
  const active = until > t;
  await ctx.reply(
    `💎 <b>Премиум</b>\n\n` +
    (active
      ? `Активен до ${new Date(until*1000).toLocaleString('ru')}`
      : `Не активен.\n\nДаёт: ×2 к тапу, +20% оффлайн.`),
    { parse_mode:'HTML' }
  );
});

// ---------- /stars ----------
bot.command('stars', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('💎 Премиум 30 дней — 100 ⭐', 'buy_premium_30').row()
    .text('🐿️ 100 000 орехов — 50 ⭐', 'buy_coins_100k').row()
    .text('⚡ 5 полных энергии — 25 ⭐', 'buy_energy_5');
  await ctx.reply('⭐ <b>Telegram Stars</b>\n\nВыбери товар:', {parse_mode:'HTML', reply_markup:kb});
});

bot.callbackQuery(/^buy_/, async (ctx) => {
  const item = ctx.callbackQuery.data;
  const prices = {
    buy_premium_30: {stars:100, title:'Премиум 30 дней'},
    buy_coins_100k: {stars:50,  title:'100 000 орехов'},
    buy_energy_5:   {stars:25,  title:'5 полных энергии'}
  };
  const it = prices[item];
  if(!it) return ctx.answerCallbackQuery('Неизвестный товар');
  try{
    await ctx.replyWithInvoice({
      title: it.title,
      description: `Покупка в Squirrel Combat: ${it.title}`,
      payload: JSON.stringify({tg:ctx.from.id, item}),
      provider_token: '',
      currency: 'XTR',
      prices: [{label: it.title, amount: it.stars}]
    });
    await ctx.answerCallbackQuery();
  }catch(e){
    await ctx.answerCallbackQuery('Ошибка: ' + e.message);
  }
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on(':successful_payment', async (ctx) => {
  const sp = ctx.message.successful_payment;
  const { tg, item } = JSON.parse(sp.invoice_payload);
  const p = await DB.getPlayer(tg);
  if(!p) return;
  const t = Math.floor(Date.now()/1000);
  if(item === 'buy_premium_30'){
    const base = Math.max(p.premium_until || t, t);
    await DB.updatePlayer(tg, { premium_until: base + 30*86400 });
  } else if(item === 'buy_coins_100k'){
    await DB.updatePlayer(tg, { balance: p.balance + 100000, total_earned: p.total_earned + 100000 });
  } else if(item === 'buy_energy_5'){
    const b = {...p.boosts}; b.full_energy = (b.full_energy||0) + 5;
    await DB.updatePlayer(tg, { boosts: b });
  }
  await ctx.reply('✅ Оплата получена! Возвращайся в игру.');
});

// ---------- /admin ----------
bot.command('admin', async (ctx) => {
  if(!ADMIN_IDS.includes(ctx.from.id)) return;
  const kb = new InlineKeyboard().webApp('📊 Дашборд', `${WEBAPP_URL}/admin.html`);
  await ctx.reply(`🔐 Админ-панель:`, {reply_markup: kb});
});

// ---------- /export ----------
bot.command('export', async (ctx) => {
  if(!ADMIN_IDS.includes(ctx.from.id)) return;
  const type = (ctx.match || 'players').trim();
  const url = `${WEBAPP_URL}/api/admin/export/${type}`;
  await ctx.reply(
    `📥 CSV-экспорт «${type}»\n\nОткрой ссылку в браузере:\n${url}\n\nДоступные: players, history, clans, duels, promos, channels`,
    {disable_web_page_preview:true}
  );
});

// ---------- /promo ----------
bot.command('promo', async (ctx) => {
  if(!ADMIN_IDS.includes(ctx.from.id)) return;
  const parts = (ctx.match || '').split(' ');
  const [code, rewardStr, usesStr, kind, ttlStr] = parts;
  if(!code || !rewardStr){
    return ctx.reply('Использование: /promo CODE reward uses kind ttl_days\nНапример: /promo NUTS2025 50000 100 coins 7');
  }
  const reward = parseInt(rewardStr)||10000;
  const uses = parseInt(usesStr)||100;
  const k = ['coins','boost_energy','premium_days'].includes(kind)?kind:'coins';
  const ttl = parseInt(ttlStr)||7;
  const { error } = await sbAdmin.from('promos').insert({
    code: code.toUpperCase(), reward, kind:k, uses_left:uses,
    expires_at: Math.floor(Date.now()/1000) + ttl*86400,
    min_league:1, created_at: Math.floor(Date.now()/1000), created_by:ctx.from.id
  });
  if(error) return ctx.reply('Ошибка: ' + error.message);
  await ctx.reply(`✅ Промокод <b>${code.toUpperCase()}</b>\n${reward} × ${uses} шт · ${k} · ${ttl} дн.`, {parse_mode:'HTML'});
});

// ---------- /give ----------
bot.command('give', async (ctx) => {
  if(!ADMIN_IDS.includes(ctx.from.id)) return;
  const [_, tgIdStr, amountStr] = (ctx.match||'').split(' ');
  const tgId = parseInt(tgIdStr), amount = parseInt(amountStr);
  if(!tgId || !amount) return ctx.reply('Использование: /give <tg_id> <сумма>');
  await DB.addBalance(tgId, amount);
  await ctx.reply(`Выдано ${amount} игроку ${tgId}`);
});

// ---------- /ban ----------
bot.command('ban', async (ctx) => {
  if(!ADMIN_IDS.includes(ctx.from.id)) return;
  const tgId = parseInt(ctx.match);
  if(!tgId) return;
  await DB.updatePlayer(tgId, { banned: true });
  await ctx.reply(`Забанен: ${tgId}`);
});

// ---------- заглушка ----------
bot.on('message:text', async (ctx) => {
  await ctx.reply('Жми /start чтобы открыть игру 🐿️');
});
