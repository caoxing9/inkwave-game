// A network start is not a browser user gesture. Give each player their own
// click to enter pointer lock, including when an automatic request was denied.
import { G } from './ctx.js';

export class ControlGate {
  constructor(game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'iwl hidden';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Enter match controls');
    this.el.innerHTML = `<div class="iwl-card">
      <h2>Enter the Match</h2>
      <p class="iwl-muted">Click the button below to enable mouse aiming, then hold left click to shoot. Press Esc to open the menu.</p>
      <p class="iwl-muted" id="iw-control-status" role="status"></p>
      <div class="iwl-row iwl-end"><button type="button" class="iwl-btn iwl-primary" id="iw-control-enter">Click to Enter the Match</button></div>
    </div>`;
    document.body.appendChild(this.el);
    this.button = this.el.querySelector('#iw-control-enter');
    this.status = this.el.querySelector('#iw-control-status');
    this.button.addEventListener('click', async e => {
      e.stopPropagation();
      this.button.disabled = true;
      this.status.textContent = 'Enabling mouse control…';
      game.input.clearButtons();
      G.audio?.init?.();
      const locked = await game.input.requestLock();
      this.button.disabled = false;
      if (!locked) this.status.textContent = 'The browser has not allowed mouse control yet. Click back into the game page and try again, or open the game in its own tab.';
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
