// A network start is not a browser user gesture. Give each player their own
// click to enter pointer lock, including when an automatic request was denied.
import { G } from './ctx.js';

export class ControlGate {
  constructor(game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'iwl hidden';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', '进入对战控制');
    this.el.innerHTML = `<div class="iwl-card">
      <h2>进入对战</h2>
      <p class="iwl-muted">点击下方按钮启用鼠标瞄准，然后按住左键开枪。按 Esc 可打开菜单。</p>
      <p class="iwl-muted" id="iw-control-status" role="status"></p>
      <div class="iwl-row iwl-end"><button type="button" class="iwl-btn iwl-primary" id="iw-control-enter">点击进入对战</button></div>
    </div>`;
    document.body.appendChild(this.el);
    this.button = this.el.querySelector('#iw-control-enter');
    this.status = this.el.querySelector('#iw-control-status');
    this.button.addEventListener('click', async e => {
      e.stopPropagation();
      this.button.disabled = true;
      this.status.textContent = '正在启用鼠标控制…';
      game.input.clearButtons();
      G.audio?.init?.();
      const locked = await game.input.requestLock();
      this.button.disabled = false;
      if (!locked) this.status.textContent = '浏览器尚未允许鼠标控制。请先点回游戏页面，再点一次；也可在独立页面中打开游戏。';
      this.update();
    });
  }
  update() {
    const { input, match, menus } = this.game;
    const gamepad = input.pad && input.lastDevice === 'pad';
    const active = G.mode === 'match' && match && !match.attract && match.local?.alive &&
      ['intro', 'playing'].includes(match.state) && !match.paused && !match.netMenu && !menus?.current;
    this.el.classList.toggle('hidden', !(active && !input.locked && !gamepad));
  }
}
