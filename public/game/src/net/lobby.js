// 联机大厅（中文界面）：创建/加入房间、选队伍和武器、房主设置地图/时长/机器人难度、查看每个人的连接状态。
import { G } from '../core/ctx.js';
import { WEAPONS, WEAPON_ORDER, MAPS, DIFFICULTY } from '../config.js';
import { LanClient, serverAvailable } from './lan.js';
import { PublicClient } from './public.js';
import { WssClient } from './wss.js';
import { NetSession } from './session.js';
import { readInvite, inviteUrl } from './invite.js';
import { PeerDiagnostics } from './peer-diagnostics.js';

const WEAPON_ZH = { shooter: '喷溅枪', roller: '滚筒刷', charger: '蓄力狙', blaster: '爆破枪' };
const MAP_ZH = { tidewater: '潮汐广场', kelpline: '海带码头', sunset: '黄昏潮汐广场' };
const DIFF_ZH = { easy: '轻松', normal: '普通', hard: '困难' };
const TEAM_ZH = ['蓝方', '红方'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Lobby {
  constructor(game) {
    this.game = game;
    this.client = null; this.session = null;
    const invite = readInvite();
    this.mode = invite.mode; this.server = invite.server; this.key = invite.key;
    this.capability = 'unknown'; this.checkedCapability = false;
    this.el = document.createElement('div');
    this.el.className = 'iwl hidden';
    document.body.appendChild(this.el);
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this._renderT = 0;
    this.metricsTimer = setInterval(() => {
      const c = this.client;
      const status = c?.status() || [];
      const pings = status.map(s => s.ping).filter(Number.isFinite);
      const queued = c?.channels ? [...c.channels.values()].reduce((n, ch) => n + (ch.dataChannel?.bufferedAmount || 0), 0) + [...(c.stateChannels?.values() || [])].reduce((n, ch) => n + ch.bufferedAmount, 0) : 0;
      const fast = !!c?.targets.length && c.targets.every(m => c.stateChannels?.get(m.id)?.readyState === 'open' || c.stCh?.get(m.id)?.readyState === 'open');
      if (parent !== window) parent.postMessage({ type: 'inkwave-metrics', active: this.inRoom && G.mode === 'match', fps: Math.round(game.fps || 0), ping: c?.serverRelays ? c.rtt ?? null : pings.length ? Math.max(...pings) : null, queued: Math.round((c?.serverRelays ? (c.ws?.bufferedAmount || 0) + c.eventBytes : queued) / 1024), fast, server: !!c?.serverRelays, host: !!c?.isHost }, location.origin);
    }, 1000);
  }

  get inRoom() { return !!this.client && !this.client.closed; }

  async open() {
    this.el.classList.remove('hidden');
    if (this.inRoom) return this._room();
    this.el.innerHTML = `<div class="iwl-card"><h2>联机对战</h2><p class="iwl-muted">正在检查联机服务器…</p></div>`;
    this.serverOk = await serverAvailable();
    if (!this.checkedCapability) {
      try {
        const response = await fetch('/api/multiplayer-status', { signal: AbortSignal.timeout(5000) });
        const data = await response.json();
        this.capability = response.ok && ['ready', 'pending'].includes(data.state) ? data.state : 'unknown';
      } catch { this.capability = 'unknown'; }
      this.checkedCapability = true;
    }
    // Explicit invitations always win. Unknown capability is not a readiness claim.
    this.mode ||= this.capability === 'ready' ? 'wss' : 'public';
    this._entry();
  }
  hide() { this.el.classList.add('hidden'); }

  _profile() { return this.game.api.getProfile(); }
  _weapon() { return this.game.api.getLoadout().weapon; }

  // ---------------------------------------------------------------- 入口
  _entry(error = '') {
    const p = this._profile();
    const code = this.joinCode ?? readInvite().room;
    this.el.innerHTML = `
      <div class="iwl-card">
        <h2>联机对战 <small>INKWAVE</small></h2>
        <p class="iwl-muted">一人创建房间，把房间码告诉朋友。最多 10 人，空位由机器人补齐。</p>
        <label class="iwl-field"><span>连接方式</span><select id="iwl-mode"><option value="wss" ${this.mode === 'wss' ? 'selected' : ''}>WSS 专用服务器（10人）</option><option value="public" ${this.mode === 'public' ? 'selected' : ''}>浏览器直连（最多10人）</option>${this.serverOk ? `<option value="local" ${this.mode === 'local' ? 'selected' : ''}>局域网服务器（支持中转）</option>` : ''}</select></label>
        <div id="iwl-wss-fields" ${this.mode === 'wss' ? '' : 'hidden'}>
          <label class="iwl-field"><span>服务器</span><input id="iwl-server" value="${esc(this.server)}"></label>
          <label class="iwl-field"><span>房间口令</span><input id="iwl-key" maxlength="4" placeholder="加入 WSS 房间时填写" value="${esc(this.key)}"></label>
        </div>
        <p class="iwl-muted">${this.capability === 'ready' ? '默认专用服务器已公布墨浪协议支持。' : this.capability === 'pending' ? '专用服务器待部署墨浪版本。' : '暂时无法确认专用服务器状态。'} 浏览器直连需要先成功连接公共信令并建房，不保证不同网络都能直连。也可<a href="/downloads/inkwave-local.zip" download>下载局域网版</a>自托管。</p>
        <label class="iwl-field"><span>昵称</span><input id="iwl-name" maxlength="16" value="${esc(p.name || '玩家')}"></label>
        <label class="iwl-field"><span>武器</span>${this._weaponSelect(this._weapon())}</label>
        <div class="iwl-row">
          <button class="iwl-btn iwl-primary" id="iwl-create">创建房间</button>
        </div>
        <div class="iwl-row">
          <input id="iwl-code" class="iwl-code" maxlength="6" placeholder="房间码" value="${esc(code)}">
          <button class="iwl-btn" id="iwl-join">加入房间</button>
        </div>
        <p class="iwl-muted" id="iwl-progress" role="status"></p>
        ${error ? `<p class="iwl-error" role="alert">${esc(error)}</p>` : ''}
        <div class="iwl-row iwl-end"><button class="iwl-btn iwl-ghost" id="iwl-diagnostics">导出连接日志</button><button class="iwl-btn iwl-ghost" id="iwl-back">返回</button></div>
      </div>`;
    const $ = (id) => this.el.querySelector('#' + id);
    const name = () => { const n = $('iwl-name').value.trim() || '玩家'; this.game.api.setProfileName(n); return n; };
    $('iwl-diagnostics').onclick = () => PeerDiagnostics.download();
    $('iwl-weapon').onchange = (e) => this.game.api.setLoadout({ weapon: e.target.value });
    $('iwl-back').onclick = () => { this.hide(); this.game.menus?.show('main'); };
    $('iwl-mode').onchange = e => {
      name(); this.server = $('iwl-server').value; this.key = '';
      this.mode = e.target.value; this.joinCode = ''; this._writeInvite(); this._entry();
    };
    const transport = () => this.mode === 'wss' ? WssClient : this.mode === 'local' ? LanClient : PublicClient;
    $('iwl-create').onclick = () => this._connect(progress => transport().create(name(), this._weapon(), $('iwl-server').value, progress));
    $('iwl-join').onclick = () => {
      const c = $('iwl-code').value.trim().toUpperCase();
      if (!c) return this._entry('请输入房间码');
      this.server = $('iwl-server').value; this.key = $('iwl-key').value;
      this._connect(progress => transport().join(c, name(), this._weapon(), this.server, this.key, progress));
    };
    $('iwl-code').onkeydown = (e) => { if (e.key === 'Enter') $('iwl-join').click(); };
  }

  _writeInvite(room = '', key = '') {
    const url = inviteUrl(location.href, this.mode, room, this.server, key);
    history.replaceState(null, '', url.pathname + url.search);
    if (parent !== window) parent.postMessage({ type: 'inkwave-invite', search: url.search }, location.origin);
  }
  _shareUrl() {
    const c = this.client;
    const base = parent === window ? `${location.origin}${location.pathname}` : `${location.origin}/`;
    return inviteUrl(base, this.mode, c.code, c.server || this.server, c.room.key || '').href;
  }

  _weaponSelect(cur) {
    return `<select id="iwl-weapon">${WEAPON_ORDER.map((w) => `<option value="${w}" ${w === cur ? 'selected' : ''}>${WEAPON_ZH[w]}（${esc(WEAPONS[w].name)}）</option>`).join('')}</select>`;
  }

  async _connect(fn) {
    this.joinCode = this.el.querySelector('#iwl-code').value;
    this.server = this.el.querySelector('#iwl-server').value;
    this.key = this.el.querySelector('#iwl-key').value;
    this.el.querySelectorAll('button, input, select').forEach((b) => (b.disabled = true));
    this.el.querySelector('#iwl-create').textContent = '正在连接…';
    const progress = text => { const el=this.el.querySelector('#iwl-progress'); if(el)el.textContent=text; };
    try {
      this.client = await fn(progress);
    } catch (e) { return this._entry(e.message); }
    this.session = new NetSession(this.client);
    this.client.onRoom = () => this._schedule();
    this.client.onStatus = () => this._schedule();
    this.client.onError = async (msg, fatal) => {
      if (fatal) {
        this._drop();
        if (G.mode === 'match') await this.game.quitToMenu();
        await this.open(); this._entry(msg);
      } else this._toast(msg);
    };
    this.session.on((d, from) => {
      if (d.t === 'start' && !this.client.isHost && from === this.client.room.host) this._launch(d);
      if (d.t === 'host-left') { this._toast('房主已离开，对局结束'); this._drop(); this.game.quitToMenu(); }
    });
    this.server = this.client.server || this.server;
    this._writeInvite(this.client.code, this.client.room.key || '');
    this._room();
  }

  _schedule() {
    if (this.el.classList.contains('hidden')) return;
    const now = performance.now();
    if (now - this._renderT < 150) { clearTimeout(this._rt); this._rt = setTimeout(() => this._room(), 160); return; }
    this._renderT = now;
    this._room();
  }

  // ---------------------------------------------------------------- 房间
  _room() {
    const c = this.client;
    if (!c || c.closed) return this._entry();
    if (this.el.classList.contains('hidden')) return;
    const room = c.room, s = room.settings || {};
    const st = new Map(c.status().map((x) => [x.id, x]));
    const me = room.members.find((m) => m.id === c.id);
    const host = c.isHost;
    const allOk = c.allConnected();
    const col = (t) => {
      const list = room.members.filter((m) => m.team === t);
      const rows = list.map((m) => {
        const x = st.get(m.id);
        let conn = '';
        if (m.id === c.id) conn = '<em class="iwl-self">你</em>';
        else if (!host && m.id !== room.host) conn = '<em class="iwl-muted">经房主</em>';
        else if (x) conn = `<em class="iwl-conn iwl-conn--${x.via}" title="${esc(x.stage)}">${x.via === 'direct' ? '直连' : x.via === 'relay' ? '中转' : '连接中…'}${x.ping != null ? ` · ${x.ping}ms` : ''}</em>`;
        return `<li><b>${esc(m.name)}</b>${m.id === room.host ? '<i class="iwl-host">房主</i>' : ''}<span>${WEAPON_ZH[m.weapon] || ''}</span>${conn}</li>`;
      }).join('');
      const bots = Math.max(0, 5 - list.length);
      return `<div class="iwl-team iwl-team--${t}"><h3>${TEAM_ZH[t]} <small>${list.length} 人${bots ? ` + ${bots} 机器人` : ''}</small></h3><ul>${rows || '<li class="iwl-muted">（全部由机器人补位）</li>'}</ul></div>`;
    };
    const opt = (obj, cur, zh) => Object.keys(obj).map((k) => `<option value="${k}" ${k === String(cur) ? 'selected' : ''}>${zh[k] || k}</option>`).join('');
    const mapOpts = MAPS.map((m) => `<option value="${m.id}" ${m.id === s.mapId ? 'selected' : ''}>${MAP_ZH[m.id] || m.name}</option>`).join('');
    const addr = this._shareUrl();
    this.el.innerHTML = `
      <div class="iwl-card iwl-wide">
        <div class="iwl-head">
          <h2>房间 <span class="iwl-roomcode">${room.code}</span>${c.serverRelays ? `<small>口令 ${esc(room.key)}</small>` : ''}</h2>
          <div class="iwl-muted">把房间码或链接发给朋友：<code>${esc(addr)}</code> <button class="iwl-btn iwl-small" id="iwl-copy">复制</button></div>
        </div>
        <div class="iwl-teams">${col(0)}${col(1)}</div>
        <div class="iwl-row iwl-opts">
          <label>你的队伍 <button class="iwl-btn iwl-small" id="iwl-switch">换到${TEAM_ZH[me && me.team === 0 ? 1 : 0]}</button></label>
          <label>武器 ${this._weaponSelect(me?.weapon || this._weapon())}</label>
        </div>
        <div class="iwl-row iwl-opts">
          <label>地图 <select id="iwl-map" ${host ? '' : 'disabled'}>${mapOpts}</select></label>
          <label>时长 <select id="iwl-dur" ${host ? '' : 'disabled'}><option value="90" ${s.duration === 90 ? 'selected' : ''}>90 秒</option><option value="180" ${s.duration === 180 ? 'selected' : ''}>3 分钟</option></select></label>
          <label>机器人 <select id="iwl-diff" ${host ? '' : 'disabled'}>${opt(DIFFICULTY, s.difficulty, DIFF_ZH)}</select></label>
        </div>
        <div class="iwl-row iwl-end">
          <button class="iwl-btn iwl-ghost" id="iwl-leave">离开房间</button>
          ${this.mode === 'public' ? '<button class="iwl-btn iwl-ghost" id="iwl-diagnostics">导出连接日志</button>' : ''}
          ${host ? `<button class="iwl-btn iwl-primary" id="iwl-start" ${allOk ? '' : 'disabled'}>${allOk ? '开始对战' : '等待所有人连接…'}</button>`
      : `<span class="iwl-muted">${room.started ? '对战进行中…' : '等待房主开始…'}</span>`}
        </div>
        <p class="iwl-tip">操作：WASD 移动 · 鼠标瞄准 · 左键射击 · Shift 潜墨 · 空格跳 · 右键/E 炸弹 · F/Q 大招 · Tab 地图 · Esc 菜单（联机时比赛不会暂停）</p>
      </div>`;
    const $ = (id) => this.el.querySelector('#' + id);
    $('iwl-copy').onclick = () => { navigator.clipboard?.writeText(addr).then(() => this._toast('已复制'), () => this._toast(addr)); };
    $('iwl-switch').onclick = () => c.request('profile', { team: me.team === 0 ? 1 : 0 }).then((d) => c._applyRoom(d.room)).catch((e) => this._toast(e.message));
    $('iwl-weapon').onchange = (e) => { this.game.api.setLoadout({ weapon: e.target.value }); c.request('profile', { weapon: e.target.value }).then((d) => c._applyRoom(d.room)).catch(() => {}); };
    const setS = (k, v) => c.request('settings', { settings: { [k]: v } }).then((d) => c._applyRoom(d.room)).catch((e) => this._toast(e.message));
    if (host) {
      $('iwl-map').onchange = (e) => setS('mapId', e.target.value);
      $('iwl-dur').onchange = (e) => setS('duration', +e.target.value);
      $('iwl-diff').onchange = (e) => setS('difficulty', e.target.value);
      $('iwl-start').onclick = () => this._hostStart();
    }
    if ($('iwl-diagnostics')) $('iwl-diagnostics').onclick = () => { c.debug?.flush(); PeerDiagnostics.download(); };
    $('iwl-leave').onclick = () => { this.leave(); this._entry(); };
  }

  async _hostStart() {
    if (this.launching) return;
    this.launching = true;
    const c = this.client;
    const pkt = this.session.buildStart(c.room.settings);
    try { await c.request('start', c.serverRelays ? {packet:pkt} : {}); } catch (e) { this.launching = false; return this._toast(e.message); }
    if (!c.serverRelays) this.session.send(pkt);
    this._launch(pkt);
  }

  async _launch(d) {
    this.hide();
    this.session.prepare();
    try {
      await this.game.startMatch({ mapId: d.mapId, duration: d.duration, difficulty: d.difficulty, palette: d.palette, roster: d.roster, net: this.session });
    } catch (error) {
      this._drop(); await this.game.quitToMenu();
      await this.open(); this._entry(`对局加载失败：${error.message}`);
    } finally { this.launching = false; }
  }

  // 一局结束后回到房间
  back() {
    this.session?.detach();
    if (this.client?.isHost) this.client.request('end').catch(() => {});
    this.open();
  }

  _drop() {
    this.session?.close();
    this.session = null; this.client = null; G.net = null;
    this.key = ''; this.joinCode = ''; this._writeInvite();
  }
  leave() { if (this.client) this._drop(); }

  _toast(msg) {
    const t = document.createElement('div');
    t.className = 'iwl-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }
}
