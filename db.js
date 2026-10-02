// db.js — обёртка над Supabase
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
export const sbAdmin = sb;

export const DB = {
  async getPlayer(tgId){
    const { data } = await sb.from('players').select('*').eq('tg_id', tgId).maybeSingle();
    return data;
  },
  async createPlayer(tgId, username, firstName, referrerId, lang='ru'){
    const now = Math.floor(Date.now()/1000);
    const row = {
      tg_id: tgId, username, first_name: firstName, lang,
      balance: 0, total_earned: 0, per_hour: 0, per_click: 1,
      energy: 1000, max_energy: 1000, last_energy_ts: now,
      last_claim_ts: now, last_bonus_ts: 0, streak: 0,
      referrer_id: referrerId || null, referrals: 0, league: 1,
      boosts: {full_energy:3, turbo:3, recharge:3},
      turbo_until: 0, turbo_mult: 5, cards: [], tasks_done: [],
      banned: false, created_at: now
    };
    const { data, error } = await sb.from('players').insert(row).select().single();
    if(error) throw error;
    if(referrerId){
      await sb.rpc('increment_referrals', { p_tg_id: referrerId });
    }
    return data;
  },
  async updatePlayer(tgId, patch){
    const { data, error } = await sb.from('players').update(patch).eq('tg_id', tgId).select().single();
    if(error) throw error;
    return data;
  },
  async topPlayers(limit=50){
    const { data } = await sb.from('players')
      .select('tg_id, username, first_name, total_earned, league')
      .order('total_earned', {ascending:false}).limit(limit);
    return data || [];
  },
  async logClicks(tgId, count){
    const now = Math.floor(Date.now()/1000);
    await sb.from('clicks_log').insert({tg_id: tgId, ts: now, count});
  },
  async recentClicks(tgId, sinceTs){
    const { data } = await sb.from('clicks_log').select('count, ts')
      .eq('tg_id', tgId).gte('ts', sinceTs);
    return data || [];
  },
  async addBalance(tgId, amount){
    const p = await this.getPlayer(tgId);
    if(!p) return null;
    return this.updatePlayer(tgId, { balance: p.balance + amount });
  },
  async referralCount(tgId){
    const { count } = await sb.from('players').select('*', { count:'exact', head:true })
      .eq('referrer_id', tgId);
    return { data: count || 0 };
  },
  async logReferral(referrerId, invitedId, reward){
    await sb.from('referral_log').insert({
      referrer_id: referrerId, invited_id: invitedId,
      reward, created_at: Math.floor(Date.now()/1000)
    });
  },
  async createDuel(id, hostId){
    await sb.from('duels').insert({
      id, host_id: hostId, guest_id: null,
      host_score: 0, guest_score: 0, stake: 0,
      status: 'pending', created_at: Math.floor(Date.now()/1000)
    });
  },
  async getDuel(id){
    const { data } = await sb.from('duels').select('*').eq('id', id).maybeSingle();
    return data;
  },
  async updateDuel(id, patch){
    const { data } = await sb.from('duels').update(patch).eq('id', id).select().single();
    return data;
  },
  async transfer(fromId, toId, amount){
    const { data, error } = await sb.rpc('transfer_coins', { p_from:fromId, p_to:toId, p_amount:amount });
    if(error){ console.error('transfer error', error); return false; }
    return !!data;
  }
};