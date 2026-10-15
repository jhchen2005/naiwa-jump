import { LEADERBOARD_CONFIG } from './leaderboard-config.js';

export class LeaderboardError extends Error {
  constructor(code, retryAfter = 0) { super(code); this.code=code; this.retryAfter=retryAfter; }
}
export class LeaderboardClient {
  constructor(config = LEADERBOARD_CONFIG, { fetchImpl = fetch, authFactory } = {}) {
    this.config=config; this.fetch=(...args)=>fetchImpl(...args); this.authFactory=authFactory; this.authPromise=null;
    this.playerId=null; this.confirmedPlayers=new Set();
  }
  get enabled() { return this.config.enabled && Boolean(this.config.supabaseUrl && this.config.publishableKey); }
  get nicknamePreferenceKey() {
    return this.playerId ? `naiwai.nickname-confirmed.${this.config.supabaseUrl}.${this.playerId}` : null;
  }
  get nicknameConfirmed() {
    const key=this.nicknamePreferenceKey;
    if(!key)return false;
    try { return this.confirmedPlayers.has(key) || localStorage.getItem(key)==='1'; }
    catch { return this.confirmedPlayers.has(key); }
  }
  confirmNickname() {
    const key=this.nicknamePreferenceKey;if(!key)return;
    // UI preference only, scoped to the current authenticated player; no score,
    // nickname, credential or trust decision is stored here.
    this.confirmedPlayers.add(key);
    try { localStorage.setItem(key,'1'); } catch { /* In-memory fallback. */ }
  }
  async auth() {
    if (!this.enabled) throw new LeaderboardError('disabled');
    if (!this.authPromise) this.authPromise=(async () => {
      if (this.authFactory) return this.authFactory();
      const { AuthClient } = await import('./leaderboard-auth-vendor.js');
      return new AuthClient({ url:`${this.config.supabaseUrl}/auth/v1`,
        headers:{apikey:this.config.publishableKey}, storageKey:`naiwai.online.${new URL(this.config.supabaseUrl).hostname}`,
        autoRefreshToken:true,persistSession:true,detectSessionInUrl:false });
    })().catch(error => { this.authPromise=null; throw error; });
    return this.authPromise;
  }
  async token() {
    const auth=await this.auth();
    // One anonymous signup across concurrent calls AND same-origin tabs.
    const get=async () => {
      let {data,error}=await auth.getSession();
      if (error) throw new LeaderboardError('auth_failed');
      if (!data.session) {
        ({data,error}=await auth.signInAnonymously());
        if (error || !data.session) throw new LeaderboardError('auth_failed');
      }
      this.playerId=data.session.user?.id || null;
      return data.session.access_token;
    };
    if (globalThis.navigator?.locks) return navigator.locks.request('naiwai-anonymous-signup',get);
    if (!this.tokenPromise) this.tokenPromise=get().finally(() => {this.tokenPromise=null;});
    return this.tokenPromise;
  }
  async call(op, fields = {}) {
    let token=await this.token();
    const playerId=this.playerId;
    for (let attempt=0;attempt<2;attempt++) {
      let response;
      try { response=await this.fetch(`${this.config.supabaseUrl}/functions/v1/leaderboard`, {
        method:'POST',headers:{'Content-Type':'application/json',apikey:this.config.publishableKey,Authorization:`Bearer ${token}`},
        body:JSON.stringify({op,board:this.config.board,...fields}),signal:AbortSignal.timeout(12000),
      }); } catch { throw new LeaderboardError('network'); }
      if (response.status===401 && attempt===0) {
        const {data,error}=await (await this.auth()).refreshSession();
        if (error || !data.session) throw new LeaderboardError('auth_expired');
        this.playerId=data.session.user?.id || null;
        if(this.playerId!==playerId)throw new LeaderboardError('auth_expired');
        token=data.session.access_token; continue;
      }
      if(this.playerId!==playerId)throw new LeaderboardError('auth_expired');
      let data; try {data=await response.json();} catch {throw new LeaderboardError('unavailable');}
      if(this.playerId!==playerId)throw new LeaderboardError('auth_expired');
      if (!response.ok) throw new LeaderboardError(data.error || 'unavailable',Number(data.retryAfter || response.headers.get('Retry-After')) || 0);
      return data;
    }
  }
}
export const leaderboardClient = new LeaderboardClient();
