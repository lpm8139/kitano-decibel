// world.js
// メインモニターの「宇宙」。高さ(km) → 画面の位置に変換し、カメラがロケットを追いかける。
// DOM は最初（と目標の高さが変わったとき）に作り、毎フレームは transform だけ更新する。

import { landmarksFor } from './game.js';
import { ghostRocketSvg, planetSvg, planetWidth, rocketSvg } from './art.js';

/** 高さ → 世界座標(px)。√ にすると、低いところ（くも・うちゅう）も高いところ（どせい…）も間隔がほどよくそろう。 */
export const PX_SCALE = 60;
export const worldY = (km) => PX_SCALE * Math.sqrt(Math.max(0, km));

const GROUND_PAD = 110; // 地面（ロケットの足元）の画面下からの位置（.world の bottom と同じ）
const ROCKET_BASE_FROM_TOP = 0.7; // 飛んでいる間、ロケットの足元をこの位置（画面の上からの割合）に保つ（上＝これから行く先を広く見せる）
const PLANET_D = 250;
const EARTH_D = 1700;

/** カメラ位置（世界座標で、画面のいちばん下に映っている高さ）。純関数なのでテストできる。 */
export function cameraFor(rocketY, screenH) {
  const limit = screenH * (1 - ROCKET_BASE_FROM_TOP) - GROUND_PAD; // 足元がここより上なら追いかける
  return Math.max(0, rocketY - limit);
}

/** 足元のちきゅう（大きな円の上の方だけが見える）。 */
function earthHorizonSvg(d) {
  const r = d / 2;
  return `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" aria-hidden="true">
<circle cx="${r}" cy="${r}" r="${r + 10}" fill="#8ED6FF" opacity=".35"/>
<circle cx="${r}" cy="${r}" r="${r}" fill="#3A86FF"/>
<ellipse cx="${r - 420}" cy="70" rx="260" ry="60" fill="#4CC38A"/>
<ellipse cx="${r + 330}" cy="60" rx="300" ry="55" fill="#4CC38A"/>
<ellipse cx="${r - 20}" cy="150" rx="200" ry="45" fill="#4CC38A"/>
<ellipse cx="${r + 120}" cy="25" rx="120" ry="18" fill="#BFE3FF" opacity=".55"/></svg>`;
}

export class WorldView {
  constructor(screen) {
    this.screen = screen;
    this.world = screen.querySelector('#world');
    this.farStars = screen.querySelector('#stars-far');
    this.nearStars = screen.querySelector('#stars-near');
    this.hint = screen.querySelector('#ghost-hint');
    this.cam = 0;
    this.marks = [];
    this.goalEls = {};
    this.key = '';
    // ブースターの「スピード線」
    const lines = screen.querySelector('.speedlines');
    if (lines && !lines.childElementCount) {
      for (let i = 0; i < 18; i++) {
        const el = document.createElement('i');
        el.style.left = `${Math.round(30 + Math.random() * 880)}px`;
        el.style.height = `${Math.round(90 + Math.random() * 160)}px`;
        el.style.animationDuration = `${(0.35 + Math.random() * 0.4).toFixed(2)}s`;
        el.style.animationDelay = `${(-Math.random()).toFixed(2)}s`;
        lines.append(el);
      }
    }
  }

  /** 目印・星・ロケットを作る（目標の高さが変わったときだけ作り直す）。 */
  build(settings) {
    const key = `${settings.goal1Km}/${settings.goal2Km}`;
    if (key === this.key) return;
    this.key = key;
    const marks = landmarksFor(settings);
    this.marks = marks;
    const w = this.world;
    w.textContent = '';
    const add = (html, y = 0) => {
      const el = document.createElement('div');
      el.className = 'w-item';
      el.style.bottom = `${y}px`;
      el.innerHTML = html;
      w.append(el);
      return el;
    };

    // 大気（地上〜うちゅう）と、くも
    add(`<div class="atmos" style="height:${Math.round(worldY(settings.goal1Km) + 60)}px"></div>`, -GROUND_PAD);
    const cloudY = worldY(10);
    add(`<div class="cloud" style="left:40px;width:150px;bottom:0"></div><div class="cloud" style="left:700px;width:180px;bottom:40px"></div><div class="cloud" style="left:460px;width:120px;bottom:-60px;opacity:.7"></div>`, cloudY - 20);

    // ちきゅう（足元の地平線）と発射台
    add(`<div class="earth" style="left:${470 - EARTH_D / 2}px;bottom:${-EARTH_D + 40}px">${earthHorizonSvg(EARTH_D)}</div><div class="pad" style="left:275px;bottom:14px"></div>`, 0);

    // 走路
    add(`<div class="track" style="height:${Math.round(worldY(8000))}px"></div>`, 0);

    // 目印（線とラベル）と、星（左はしから半分だけ見える）
    this.goalEls = {};
    for (const m of marks) {
      if (m.key === 'earth') continue;
      const y = worldY(m.km);
      if (m.planet) {
        const d = m.planet === 'moon' ? PLANET_D + 20 : PLANET_D;
        const pw = planetWidth(m.planet, d);
        add(`<div class="planet-peek" style="left:${-pw / 2}px;bottom:${-d / 2}px">${planetSvg(m.planet, d)}</div>`, y);
      }
      const goal = m.goal ? ` goal` : '';
      const label = m.goal ? `★ ${m.name} ${m.km.toLocaleString('ja-JP')}km` : `${m.name} ${m.km.toLocaleString('ja-JP')}km`;
      const el = add(`<div class="mark${goal}"><div class="mark-line"></div><div class="mark-label">${label}</div></div>`, y);
      if (m.goal) this.goalEls[m.goal] = { el: el.firstElementChild, label: el.querySelector('.mark-label'), m };
    }

    // ロケット（きみ・チャンピオン）
    this.ghost = document.createElement('div');
    this.ghost.className = 'rocket ghost';
    this.ghost.innerHTML = `${ghostRocketSvg(70)}<div class="rocket-label">チャンピオン</div>`;
    this.you = document.createElement('div');
    this.you.className = 'rocket you';
    this.you.innerHTML = `${rocketSvg({ width: 90 })}<div class="rocket-label">きみ</div>`;
    w.append(this.ghost, this.you);
    this.ghostLabel = this.ghost.querySelector('.rocket-label');
    this.resetGoals();
  }

  setGhostName(text) {
    if (this.ghostLabel) this.ghostLabel.textContent = text;
  }

  resetGoals() {
    for (const g of Object.values(this.goalEls)) {
      g.el.classList.remove('done');
      g.label.textContent = `★ ${g.m.name} ${g.m.km.toLocaleString('ja-JP')}km`;
    }
  }

  markGoalDone(n) {
    const g = this.goalEls[n];
    if (!g) return;
    g.el.classList.add('done');
    g.label.textContent = `✓ ${g.m.name} クリア`;
  }

  /**
   * 毎フレーム呼ぶ。
   * @param {{alt:number, ghostAlt:number|null, ghostAhead?:string, thrust:number, dt:number}} p
   */
  update({ alt, ghostAlt, thrust, dt, snap = false }) {
    const H = this.screen.clientHeight || 722;
    const youY = worldY(alt);
    const target = cameraFor(youY, H);
    // カメラはなめらかに追いかける（いきなり飛ばない）。snap = 待機に戻ったときなどは即座に。
    const k = snap ? 1 : 1 - Math.exp(-dt / 0.12);
    this.cam += (target - this.cam) * k;
    if (this.cam > youY) this.cam = Math.max(0, target);

    this.world.style.transform = `translateY(${this.cam.toFixed(1)}px)`;
    this.you.style.transform = `translateY(${(-youY).toFixed(1)}px)`;
    this.you.style.setProperty('--thrust', thrust.toFixed(2));
    this.farStars.style.transform = `translateY(${((this.cam * 0.08) % 260).toFixed(1)}px)`;
    this.nearStars.style.transform = `translateY(${((this.cam * 0.2) % 420).toFixed(1)}px)`;

    if (ghostAlt === null || ghostAlt === undefined) {
      this.hint.hidden = true;
      return;
    }
    const gY = worldY(ghostAlt);
    this.ghost.style.transform = `translateY(${(-gY).toFixed(1)}px)`;
    // 画面の外にいるときは、上か下のはしに「チャンピオン ○km さき」を出す
    const screenBottomOfGhost = H - GROUND_PAD - (gY - this.cam); // ゴーストの足元の画面Y
    const diff = Math.round(ghostAlt - alt);
    if (screenBottomOfGhost < 40) {
      this.hint.hidden = false;
      this.hint.dataset.dir = 'up';
      this.hint.textContent = `▲ チャンピオン ${diff.toLocaleString('ja-JP')}km さき`;
    } else if (screenBottomOfGhost - 130 > H) {
      this.hint.hidden = false;
      this.hint.dataset.dir = 'down';
      this.hint.textContent = `▼ チャンピオン ${(-diff).toLocaleString('ja-JP')}km うしろ`;
    } else {
      this.hint.hidden = true;
    }
  }
}
