import { leaderboardClient } from './leaderboard-client.js';
import { rulesHash } from './leaderboard-rules.js';

const errors = {
  disabled:'在线排行榜尚未配置；本机纪录和游戏照常使用。', network:'网络连接失败，请重试。',
  unavailable:'排行榜暂时不可用，请稍后重试。',auth_failed:'匿名身份连接失败，请重试。',
  auth_expired:'匿名身份已失效，本局无法提交。请刷新后重新开局。',
  rules_mismatch:'本局规则与在线榜不一致，仅保留本机成绩。',
  invalid_nickname:'昵称需要 1–16 个字，不能包含控制字符。',
  run_conflict:'本局提交内容发生变化，无法重复提交。',session_missing:'未找到本局在线会话，请重新开局。',
};
const message = error => error?.code==='rate_limited' ? `操作较频繁，请 ${error.retryAfter || 60} 秒后重试。` : errors[error?.code] || '操作失败，请稍后重试。';

export class LeaderboardDialog {
  constructor(root, client=leaderboardClient, onStatus=()=>{}) {
    this.client=client; this.run=null; this.dead=false; this.generation=0;this.abort=new AbortController();
    this.onStatus=onStatus;this.savedNickname='';this.nicknameConfirmed=false;this.profileLoaded=false;
    this.profileRevision=0;this.draftDirty=false;this.saving=false;
    this.dialog=document.createElement('dialog'); this.dialog.className='leaderboard-dialog';
    this.dialog.setAttribute('aria-labelledby','online-rank-title');
    this.dialog.innerHTML=`<div class="leaderboard-heading"><div><small>NAIWAI JUMP · ONLINE</small><h2 id="online-rank-title">高手排行榜</h2></div><button type="button" data-close aria-label="关闭排行榜">×</button></div>
      <p class="leaderboard-intro">经典玩法 · 前 100 名 · 同分同名次</p>
      <form data-profile><label>你的昵称 <input name="nickname" autocomplete="off" maxlength="32" placeholder="取个 1–16 字的昵称" required aria-describedby="online-nickname-help"></label>
      <p class="leaderboard-note" id="online-nickname-help">首次保存昵称后，本局会立即提交；以后每局结束自动提交。修改昵称不会新增玩家。</p>
      <button data-submit type="submit">保存昵称并提交本局</button></form>
      <p class="leaderboard-note">匿名身份保存在此浏览器；清理浏览器数据或换设备可能丢失，暂不支持跨设备同步。昵称仅用于展示。</p>
      <p data-operation role="status" aria-live="polite"></p>
      <div class="leaderboard-submit"><p data-submit-state role="status" aria-live="polite"></p></div>
      <p data-me class="leaderboard-me"></p><p data-query role="status" aria-live="polite"></p><button data-retry type="button">刷新排行</button>
      <div class="leaderboard-table-wrap"><table><caption class="sr-only">在线最高分排行榜</caption><thead><tr><th>名次</th><th>昵称</th><th>最高分</th></tr></thead><tbody></tbody></table></div>
      <p class="leaderboard-note">仅展示通过基础检查或人工复核的成绩。本机历史纪录不会自动导入；基础检查不代表已验证无作弊。</p>`;
    root.append(this.dialog);
    this.el=selector=>this.dialog.querySelector(selector);
    this.el('[data-close]').onclick=()=>this.close();
    document.addEventListener('keydown',event=>{
      if(!this.dialog.open || event.key!=='Tab')return;
      const nodes=[...this.dialog.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
      const first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey && (document.activeElement===first || !this.dialog.contains(document.activeElement))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && (document.activeElement===last || !this.dialog.contains(document.activeElement))){event.preventDefault();first?.focus();}
    },{capture:true,signal:this.abort.signal});
    this.dialog.addEventListener('click',event=>{if(event.target===this.dialog) {const r=this.dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)this.close();}});
    this.el('[data-retry]').onclick=()=>this.load();
    this.el('[data-profile]').onsubmit=event=>{event.preventDefault();this.saveAndSubmit();};
    this.el('input').oninput=()=>{this.draftDirty=true;this.el('[data-operation]').textContent='';this.renderRun();};
    this.renderRun();
  }
  begin() {
    this.close(); this.generation++;
    this.draftDirty=false;this.el('input').value=this.nicknameConfirmed?this.savedNickname:'';
    this.el('[data-operation]').textContent='';
    const run={status:'starting',score:null,durationMs:null}; this.run=run;
    if (!this.client.enabled) {run.status='disabled';this.renderRun();return;}
    if (!globalThis.crypto?.randomUUID || !globalThis.crypto?.subtle) {run.status='unranked';this.renderRun();return;}
    run.id=crypto.randomUUID();
    this.ensureProfile()?.then(()=>this.maybeSubmit(run));this.renderRun();
    // Fire-and-forget: neither identity nor the backend may block the first jump.
    run.ready=rulesHash().then(hash=>{
      run.hash=hash;return this.client.call('start',{runId:run.id,rulesHash:hash});
    }).then(()=>{run.playerId=this.client.playerId;run.status='ready';},error=>{run.status='unranked';run.error=error;}).finally(()=>{this.renderRun();this.maybeSubmit(run);});
  }
  finish(score,durationMs) {
    if (!this.run || this.run.score!==null) return;
    this.run.score=score; this.run.durationMs=durationMs; this.renderRun();
    // Only this newly registered run is eligible, never a stored local best.
    this.maybeSubmit();
  }
  applyProfile(data, revision) {
    if(this.dead || revision!==this.profileRevision)return;
    this.profileLoaded=true;this.profileError=null;this.profilePlayerId=this.client.playerId;this.savedNickname=data.nickname || '奶娃';
    // Earlier versions required an explicit submit. Preserve those players;
    // a new account's automatically created default profile is not consent.
    this.nicknameConfirmed=this.client.nicknameConfirmed || this.savedNickname!=='奶娃' || Boolean(data.me) || data.pending>0;
    if(this.nicknameConfirmed)this.client.confirmNickname();
    if(!this.draftDirty && !this.saving)this.el('input').value=this.nicknameConfirmed?this.savedNickname:'';
    this.renderRun();this.maybeSubmit();
  }
  ensureProfile() {
    this.checkIdentity();
    if(this.profileLoaded || !this.client.enabled)return;
    if(this.profilePromise)return this.profilePromise;
    const revision=this.profileRevision;
    this.profilePromise=this.client.call('read').then(data=>this.applyProfile(data,revision),error=>{
      if(revision===this.profileRevision)this.profileError=error;
    }).finally(()=>{this.profilePromise=null;this.renderRun();});
    return this.profilePromise;
  }
  checkIdentity() {
    if(!this.profileLoaded || this.profilePlayerId===this.client.playerId)return;
    this.profileLoaded=false;this.nicknameConfirmed=false;this.profileError=null;this.savedNickname='';this.profileRevision++;
    this.draftDirty=false;this.el('input').value='';
  }
  maybeSubmit(run=this.run) {
    if(this.dead)return;
    this.checkIdentity();
    if(!this.profileLoaded && !this.profileError){this.ensureProfile()?.then(()=>this.maybeSubmit(run));return;}
    if(!this.dead && this.nicknameConfirmed && (run!==this.run || (!this.saving && !this.draftDirty)) && run?.status==='ready' && run.score!==null)void this.submit(run);
  }
  renderRun() {
    if(this.dead)return;
    const r=this.run, button=this.el('[data-submit]'), input=this.el('input');
    const needsSave=!this.nicknameConfirmed || input.value.trim()!==this.savedNickname;
    const canSubmit=r?.score!==null && r && ['ready','failed'].includes(r.status);
    const busy=this.saving || r?.status==='sending';
    button.disabled=!this.client.enabled || busy || (!needsSave && !canSubmit);
    input.disabled=!this.client.enabled || busy;
    button.textContent=r?.status==='sending'?'正在提交…':this.saving?'正在保存昵称…':needsSave?
      (canSubmit?'保存昵称并提交本局':'保存昵称'):r?.status==='failed'?'重试提交本局':canSubmit?'提交本局成绩':'已开启自动提交';
    this.el('[data-submit-state]').textContent=!this.client.enabled?errors.disabled:!r?'本局尚未建立在线会话。':
      r.status==='starting'?'正在连接本局在线会话…':r.status==='unranked'?`本局仅保留本机成绩：${message(r.error)}`:
      r.status==='sending'?'正在提交，等待服务器确认…':r.status==='accepted'?'服务器已确认：本局成绩已接收，仅在超过在线最高分时更新。':
      r.status==='pending'?'服务器已接收，成绩待复核，暂不进入公开榜。':r.status==='rejected'?'本局成绩经复核未进入公开榜。':
      r.status==='failed'?`未确认提交成功：${message(r.error)}`:this.saving?'正在保存昵称，保存成功后提交本局…':
      this.profileError && !this.profileLoaded?`昵称读取失败：${message(this.profileError)} 可刷新排行重试。`:
      !this.profileLoaded && this.profilePromise?'正在读取昵称…':!this.nicknameConfirmed?`先设置一次昵称${r.score===null?'，以后每局结束自动提交。':`，即可提交本局 ${r.score} m；以后自动提交。`}`:
      r.score===null?'本局结束后会自动提交。':`本局 ${r.score} m；只提交本局新成绩。`;
    const status=!this.client.enabled?'在线榜未配置':r?.status==='unranked'?'本局仅本机':
      r?.status==='sending'?'自动提交中…':r?.status==='accepted'?'已提交 · 查看排行':r?.status==='pending'?'待复核 · 查看排行':
      r?.status==='rejected'?'未入榜 · 查看详情':r?.status==='failed'?'提交失败 · 重试':
      !this.profileLoaded && this.profileError?'连接失败 · 重试':!this.profileLoaded?'正在连接…':
      !this.nicknameConfirmed?'设置昵称 · 上榜':r?.status==='starting'?'正在连接…':'查看排行 ↗';
    this.onStatus(status);
  }
  async submit(r=this.run) {
    if(this.dead || !this.nicknameConfirmed || !r || !['ready','failed'].includes(r.status) || r.score===null)return;
    if(r.playerId!==this.client.playerId){r.status='unranked';r.error={code:'auth_expired'};this.renderRun();return;}
    r.status='sending';this.renderRun();
    try {
      const result=await this.client.call('submit',{runId:r.id,rulesHash:r.hash,score:r.score,durationMs:r.durationMs});
      if(!['accepted','pending','rejected'].includes(result.verdict))throw new Error('Invalid server response');
      r.status=result.verdict;
      if(!this.dead && this.run===r && this.dialog.open)await this.load();
    }catch(error){r.status='failed';r.error=error;}
    this.renderRun();
  }
  async saveAndSubmit() {
    if(this.dead || this.el('[data-submit]').disabled)return;
    const nickname=this.el('input').value.trim(), r=this.run;
    if([...nickname].length<1 || [...nickname].length>16 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(nickname)){
      this.el('[data-operation]').textContent=errors.invalid_nickname;return;
    }
    this.saving=true;this.profileRevision++;this.renderRun();
    try{
      if(!this.nicknameConfirmed || nickname!==this.savedNickname){
        this.el('[data-operation]').textContent='正在保存昵称…';
        const result=await this.client.call('profile',{nickname});
        if(this.dead)return;
        if(result.nickname!==nickname)throw new Error('Invalid profile response');
        this.profileRevision++;
        this.savedNickname=result.nickname;this.nicknameConfirmed=true;this.profileLoaded=true;this.profileError=null;this.profilePlayerId=this.client.playerId;
        this.client.confirmNickname();this.el('input').value=result.nickname;
        this.el('[data-operation]').textContent='昵称已保存，以后每局结束自动提交。';
      }
      this.draftDirty=false;
      if(this.run===r && r?.score!==null && ['ready','failed'].includes(r?.status))await this.submit();
      else if(this.dialog.open)await this.load();
    }catch(error){if(!this.dead)this.el('[data-operation]').textContent=message(error);}
    finally{this.saving=false;this.renderRun();this.maybeSubmit(r);if(r!==this.run)this.maybeSubmit();}
  }
  async load() {
    if(this.dead)return;
    const generation=++this.generation;
    const revision=this.profileRevision;
    this.el('[data-query]').textContent='正在加载在线排行…';this.el('[data-retry]').disabled=true;
    try{
      const data=await this.client.call('read');if(this.dead || generation!==this.generation)return;
      this.el('tbody').replaceChildren();
      for(const entry of data.entries){
        const tr=document.createElement('tr');if(entry.id===data.me?.id)tr.className='is-me';
        for(const value of [entry.rank,entry.nickname,`${entry.score} m`]){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}
        this.el('tbody').append(tr);
      }
      this.el('[data-query]').textContent=data.entries.length?'':'还没有在线成绩，来留下第一条纪录吧。';
      this.el('[data-me]').textContent=data.me?`我的在线最高分 ${data.me.score} m · 第 ${data.me.rank} 名`:'我还没有已上榜的成绩。';
      if(data.pending)this.el('[data-me]').textContent+=` · ${data.pending} 局待复核`;
      this.applyProfile(data,revision);
    }catch(error){if(!this.dead && generation===this.generation){this.el('[data-query]').textContent=`查询失败：${message(error)}`;this.el('tbody').replaceChildren();this.el('[data-me]').textContent='';}}
    finally{if(!this.dead && generation===this.generation)this.el('[data-retry]').disabled=false;}
  }
  open(){if(this.dead)return;this.renderRun();if(!this.dialog.open)this.dialog.showModal();this.load();}
  close(){this.dialog.close();}
  destroy(){this.dead=true;this.generation++;this.abort.abort();this.close();this.dialog.remove();}
}
