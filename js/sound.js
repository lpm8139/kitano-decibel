// sound.js
// BGM（sound フォルダの音楽ファイルを順番に流す）と効果音（Web Audio で合成。ファイル不要）。
//
// ・計測中（スタンバイ〜エンドレス）は BGM を自動で消す（スピーカーの音をマイクが拾って dB が上がらないように）。
// ・ブラウザは「ユーザーが何か操作するまで音を出さない」ので、最初のキー／クリックで unlock() を呼ぶ。

const FADE_MS = 400;
const FADE_STEP_MS = 40;

export class SoundSystem {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.files = [];
    this.index = 0;
    this.audio = null;
    this.ctx = null;
    this.master = null;
    this.unlocked = false;
    this.wantBgm = false; // 今 BGM を鳴らす場面か（設定・計測中かどうかで決まる）
    this.runActive = false;
    this.cfg = { bgm: true, bgmVolume: 0.4, muteBgmDuringRun: true, se: true, seVolume: 0.7 };
    this.vol = 0; // BGM の今の音量（フェード用）
    this.fadeTimer = null;
    this.failures = 0;
  }

  /** 設定を反映（音量・オンオフ）。 */
  configure(s) {
    this.cfg = {
      bgm: Boolean(s.bgm),
      bgmVolume: Number(s.bgmVolume) || 0,
      muteBgmDuringRun: Boolean(s.muteBgmDuringRun),
      se: Boolean(s.se),
      seVolume: Number(s.seVolume) || 0,
    };
    if (this.master) this.master.gain.value = this.cfg.seVolume;
    this.updateBgm();
  }

  /** sound フォルダのファイル一覧を取得（保存サーバーの /api/sounds）。 */
  async loadPlaylist() {
    try {
      const res = await this.fetch('/api/sounds', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      const files = Array.isArray(data?.files) ? data.files.filter((f) => typeof f === 'string') : [];
      const changed = files.join('\n') !== this.files.join('\n');
      this.files = files;
      if (changed) {
        this.index = 0;
        this.failures = 0;
        if (this.audio) {
          this.audio.pause();
          this.audio = null;
        }
        this.updateBgm();
      }
    } catch {
      /* サーバー未接続でも効果音は鳴る */
    }
    return this.files;
  }

  /** 最初のユーザー操作で呼ぶ（キー・クリック）。 */
  unlock() {
    if (!this.ctx) {
      try {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.cfg.seVolume;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.unlocked = true;
    this.updateBgm();
  }

  /** 計測中かどうか（true の間は設定に従って BGM を消す）。 */
  setRunActive(active) {
    this.runActive = Boolean(active);
    this.updateBgm();
  }

  get bgmPlaying() {
    return Boolean(this.audio && !this.audio.paused && this.vol > 0);
  }

  updateBgm() {
    this.wantBgm = this.cfg.bgm && this.files.length > 0 && !(this.runActive && this.cfg.muteBgmDuringRun);
    const target = this.wantBgm ? this.cfg.bgmVolume : 0;
    if (target > 0) this.ensurePlaying();
    this.fadeTo(target, this.runActive ? 250 : FADE_MS * 3);
  }

  ensurePlaying() {
    if (!this.unlocked || !this.files.length) return;
    if (!this.audio) {
      const a = new Audio();
      a.preload = 'auto';
      a.volume = 0;
      a.addEventListener('ended', () => this.next());
      a.addEventListener('error', () => {
        this.failures += 1;
        if (this.failures < this.files.length * 2) this.next();
      });
      a.addEventListener('playing', () => (this.failures = 0));
      this.audio = a;
      this.load(this.index);
    }
    if (this.audio.paused) this.audio.play().catch(() => {});
  }

  load(i) {
    if (!this.files.length || !this.audio) return;
    this.index = ((i % this.files.length) + this.files.length) % this.files.length;
    this.audio.src = `sound/${encodeURIComponent(this.files[this.index])}`;
  }

  next() {
    if (!this.audio) return;
    this.load(this.index + 1);
    if (this.wantBgm) this.audio.play().catch(() => {});
  }

  fadeTo(target, ms) {
    clearInterval(this.fadeTimer);
    const a = this.audio;
    if (!a) {
      this.vol = 0;
      return;
    }
    const from = this.vol;
    const steps = Math.max(1, Math.round(ms / FADE_STEP_MS));
    let i = 0;
    this.fadeTimer = setInterval(() => {
      i += 1;
      this.vol = from + ((target - from) * i) / steps;
      a.volume = Math.min(1, Math.max(0, this.vol));
      if (i >= steps) {
        clearInterval(this.fadeTimer);
        if (target === 0) a.pause(); // 止めておく（計測の邪魔をしない・CPU も使わない）
      }
    }, FADE_STEP_MS);
  }

  // -------------------------------------------------------------------------
  // 効果音（合成）
  // -------------------------------------------------------------------------

  /** 効果音を鳴らす。name: standby / launch / goal / booster / endless / pass / end / result / newRecord / abort / click */
  se(name) {
    if (!this.cfg.se || !this.ctx || !this.master) return false;
    const fn = SE[name];
    if (!fn) return false;
    try {
      fn(this.ctx, this.master, this.ctx.currentTime + 0.02);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 合成のための小さな部品
// ---------------------------------------------------------------------------

function tone(ctx, out, { f, t, d, type = 'triangle', g = 0.3, f2 = null }) {
  const o = ctx.createOscillator();
  const v = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  v.gain.setValueAtTime(0.0001, t);
  v.gain.exponentialRampToValueAtTime(g, t + 0.015);
  v.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(v).connect(out);
  o.start(t);
  o.stop(t + d + 0.05);
}

function noise(ctx, out, { t, d, g = 0.25, from = 300, to = 3000, q = 1.2 }) {
  const len = Math.ceil(ctx.sampleRate * d);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(from, t);
  bp.frequency.exponentialRampToValueAtTime(to, t + d);
  const v = ctx.createGain();
  v.gain.setValueAtTime(0.0001, t);
  v.gain.exponentialRampToValueAtTime(g, t + 0.08);
  v.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(bp).connect(v).connect(out);
  src.start(t);
  src.stop(t + d + 0.05);
}

const N = { C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, E6: 1318.5, G6: 1568, C7: 2093 };

const SE = {
  click: (c, o, t) => tone(c, o, { f: 1200, t, d: 0.05, type: 'square', g: 0.08 }),
  standby: (c, o, t) => {
    tone(c, o, { f: N.A5, t, d: 0.12, type: 'square', g: 0.12 });
    tone(c, o, { f: N.E6, t: t + 0.13, d: 0.18, type: 'square', g: 0.12 });
  },
  launch: (c, o, t) => noise(c, o, { t, d: 0.9, g: 0.3, from: 200, to: 1600 }),
  goal: (c, o, t) => [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => tone(c, o, { f, t: t + i * 0.08, d: 0.25, g: 0.25 })),
  booster: (c, o, t) => {
    noise(c, o, { t, d: 1.8, g: 0.35, from: 150, to: 4000, q: 0.8 });
    tone(c, o, { f: 180, f2: 900, t, d: 1.6, type: 'sawtooth', g: 0.12 });
  },
  endless: (c, o, t) => [N.C6, N.E6, N.G6, N.C7].forEach((f, i) => tone(c, o, { f, t: t + i * 0.06, d: 0.2, type: 'sine', g: 0.2 })),
  pass: (c, o, t) => {
    tone(c, o, { f: N.G5, t, d: 0.12, type: 'sine', g: 0.2 });
    tone(c, o, { f: N.C6, t: t + 0.1, d: 0.2, type: 'sine', g: 0.2 });
  },
  end: (c, o, t) => [N.C6, N.G5, N.E5].forEach((f, i) => tone(c, o, { f, t: t + i * 0.09, d: 0.2, type: 'square', g: 0.1 })),
  result: (c, o, t) => {
    const seq = [[N.C5, 0], [N.E5, 0.12], [N.G5, 0.24], [N.C6, 0.36]];
    seq.forEach(([f, dt]) => tone(c, o, { f, t: t + dt, d: 0.22, type: 'square', g: 0.12 }));
    [N.C5, N.E5, N.G5, N.C6].forEach((f) => tone(c, o, { f, t: t + 0.5, d: 0.9, type: 'triangle', g: 0.14 }));
  },
  newRecord: (c, o, t) => {
    const seq = [N.G5, N.G5, N.G5, N.E5, N.G5, N.C6];
    const at = [0, 0.12, 0.24, 0.36, 0.6, 0.84];
    seq.forEach((f, i) => tone(c, o, { f, t: t + at[i], d: i === 5 ? 1.0 : 0.16, type: 'square', g: 0.13 }));
    [N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f) => tone(c, o, { f, t: t + 0.84, d: 1.2, type: 'triangle', g: 0.1 }));
  },
  abort: (c, o, t) => tone(c, o, { f: 220, f2: 110, t, d: 0.35, type: 'square', g: 0.12 }),
};

export const SE_NAMES = Object.keys(SE);
