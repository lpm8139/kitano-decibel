// game.js
// ロケットゲームのルール（画面・音・保存には触らない純粋なロジック。テスト対象）。
//
// 流れ: stage1（既定5秒）→ つきに届いたら即 endless ／ 届かなければ booster（3秒で月へワープ）→ endless
//       endless は「声が silenceEndSec 秒とぎれる」か「endlessMaxSec 秒たつ」と終了 → done
// 高さ: 1サンプルごとに max(0, dB - floor) × kmRate × 経過秒 だけ上昇（km はゲーム内の数字）

export const BOOSTER_SEC = 3;
/** ブースターのいちばん短い時間（秒）。 */
export const BOOSTER_MIN_SEC = 1.2;
/** サンプル間隔がこれより空いても、1回で加算する時間はここまで（タブの一時停止などで跳ねないように）。 */
const MAX_STEP_SEC = 0.25;
/** 高さの履歴を残す間隔（ms）。ゴースト再生と保存用。 */
const ALT_SAMPLE_MS = 100;
/** 保存する声の履歴の間隔（ms）。計測は 50ms ごとだが、ファイルを軽くするため間引いて残す。 */
const VOICE_SAVE_MS = 100;

/** 道のりの目印（km）。goal1/goal2 の高さは設定で上書きする。 */
export const LANDMARKS = Object.freeze([
  { key: 'earth', name: 'ちきゅう', km: 0, planet: 'earth' },
  { key: 'cloud', name: 'くも', km: 10 },
  { key: 'space', name: 'うちゅう', km: 100, goal: 1 },
  { key: 'moon', name: 'つき', km: 500, goal: 2, planet: 'moon' },
  { key: 'mars', name: 'かせい', km: 800, planet: 'mars' },
  { key: 'jupiter', name: 'もくせい', km: 1200, planet: 'jupiter' },
  { key: 'saturn', name: 'どせい', km: 1600, planet: 'saturn' },
  { key: 'uranus', name: 'てんのうせい', km: 2200, planet: 'uranus' },
  { key: 'neptune', name: 'かいおうせい', km: 2900, planet: 'neptune' },
  { key: 'edge', name: 'たいようけいの はて', km: 4000 },
  { key: 'galaxy', name: 'ぎんがの かなた', km: 6000 },
]);

/** 設定の目標の高さを反映した目印の一覧（km 昇順）。 */
export function landmarksFor(settings) {
  return LANDMARKS.map((m) => {
    if (m.goal === 1) return { ...m, km: settings.goal1Km };
    if (m.goal === 2) return { ...m, km: settings.goal2Km };
    return { ...m };
  });
}

/** 1サンプル分の上昇量（km）。 */
export function altitudeGain(db, dtSec, settings) {
  if (!Number.isFinite(db) || !(dtSec > 0)) return 0;
  return Math.max(0, db - settings.floor) * settings.kmRate * dtSec;
}

/** その高さで到達済みの、いちばん遠い目印。 */
export function reachedLandmark(alt, marks) {
  let last = marks[0];
  for (const m of marks) if (alt >= m.km) last = m;
  return last;
}

/** その高さの次の目印（無ければ null）。 */
export function nextLandmark(alt, marks) {
  return marks.find((m) => m.km > alt) ?? null;
}

/** 高さの履歴 [[t(ms), km], ...] を時刻 t で線形補間（範囲外は端の値）。 */
export function altitudeAt(series, t) {
  if (!series || series.length === 0) return 0;
  if (t <= series[0][0]) return series[0][1];
  for (let i = 1; i < series.length; i++) {
    const [t1, a1] = series[i];
    if (t <= t1) {
      const [t0, a0] = series[i - 1];
      return t1 === t0 ? a1 : a0 + ((a1 - a0) * (t - t0)) / (t1 - t0);
    }
  }
  return series[series.length - 1][1];
}

/**
 * 複数の高さの履歴（[[t, km], ...] の配列）を、時刻ごとに平均した履歴を作る（「へいきん」ゴースト用）。
 * それぞれ、飛び終わったあとは最後の高さのままとして平均する。stepMs ごとに1点。
 */
export function averageSeries(list, stepMs = 100) {
  const xs = (list ?? []).filter((s) => Array.isArray(s) && s.length > 0);
  if (xs.length === 0) return [];
  const end = Math.max(...xs.map((s) => s[s.length - 1][0]));
  const idx = xs.map(() => 0);
  const out = [];
  for (let t = 0; ; t += stepMs) {
    const tt = Math.min(t, end);
    let sum = 0;
    xs.forEach((s, k) => {
      while (idx[k] < s.length - 1 && s[idx[k] + 1][0] <= tt) idx[k] += 1;
      const i = idx[k];
      if (i >= s.length - 1 || tt <= s[0][0]) sum += tt <= s[0][0] ? s[0][1] : s[s.length - 1][1];
      else {
        const [t0, a0] = s[i];
        const [t1, a1] = s[i + 1];
        sum += t1 === t0 ? a1 : a0 + ((a1 - a0) * (tt - t0)) / (t1 - t0);
      }
    });
    out.push([tt, Math.round(sum / xs.length)]);
    if (tt >= end) break;
  }
  return out;
}

/** ランキング・ゴーストの対象になる記録か（ロケット版・破棄していない・リハーサルでない）。 */
export function isRankable(r) {
  return Boolean(r && r.game === 'rocket' && !r.deleted && !r.rehearsal && Number.isFinite(r.score));
}

/** [[t, v], ...] を最低 stepMs 間隔に間引く（最後の1点は必ず残す）。 */
export function thin(series, stepMs) {
  const out = [];
  let last = -Infinity;
  series.forEach((p, i) => {
    if (p[0] - last >= stepMs || i === series.length - 1) {
      out.push(p);
      last = p[0];
    }
  });
  return out;
}

/**
 * ブースターの進み方（0〜1 の割合）。いまの速さ v0（全体の距離を1としたときの、1回分の時間あたり）から始めて、
 * だんだん速くなってつきに着く。最後に止まりかけると、そのあとのエンドレスが遅く見えるため。
 */
export const boostCurve = (p, v0) => {
  const a = Math.min(Math.max(0, v0), 1);
  return a * p + (1 - a) * p * p;
};
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * 1回分のプレイ。時刻はミリ秒（performance.now() など、単調増加なら何でもよい）。
 *
 *   const run = new RocketRun(settings);
 *   run.start(now, db);
 *   const events = run.update(now, db);   // 計測サンプルごと（db=null なら時間だけ進める）
 *   if (run.phase === 'done') save(run.result());
 *
 * events: { type: 'goal1' | 'goal2' | 'booster' | 'endless' | 'end', boosted?, reason? }
 */
export class RocketRun {
  constructor(settings) {
    this.s = settings;
    this.marks = landmarksFor(settings);
    this.phase = 'ready';
    this.alt = 0;
    this.voice = []; // [[t(ms), dB]] 声を出していた区間（stage1・endless）
    this.altSeries = [];
    this.reached = { goal1: false, goal2: false };
    this.boosted = false;
    this.silence = 0;
    this.cheer = null; // ブースター中の会場の声（表示用。記録には入れない）
    this.lastSpeed = 0;
    this.endReason = null;
  }

  start(t, db) {
    this.t0 = t;
    this.last = t;
    this.phase = 'stage1';
    this.altSeries = [[0, 0]];
    this.lastAltT = 0;
    return this.update(t, db);
  }

  rel(t) {
    return Math.max(0, Math.round(t - this.t0));
  }

  /** stage1 の残り秒（stage1 以外は null）。 */
  stageLeft(t) {
    return this.phase === 'stage1' ? Math.max(0, this.s.stage1Sec - (t - this.t0) / 1000) : null;
  }

  /** endless の経過秒（endless 以外は null）。 */
  endlessElapsed(t) {
    return this.phase === 'endless' ? Math.max(0, (t - this.endlessStart) / 1000) : null;
  }

  update(t, db = null) {
    if (this.phase === 'ready' || this.phase === 'done') return [];
    const events = [];
    const dt = Math.min(MAX_STEP_SEC, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    const hasDb = Number.isFinite(db);

    if (this.phase === 'stage1') {
      if (hasDb) {
        this.alt += altitudeGain(db, dt, this.s);
        this.voice.push([this.rel(t), round1(db)]);
        // いまの速さ（km/秒）。1サンプルの大声・小声で決まらないよう、0.4秒くらいでならす
        this.lastSpeed += (altitudeGain(db, 1, this.s) - this.lastSpeed) * Math.min(1, dt / 0.4);
      }
      this.checkGoals(events, false);
      if (this.reached.goal2) {
        this.enterEndless(t, events);
      } else if (t - this.t0 >= this.s.stage1Sec * 1000) {
        if (this.s.booster) {
          this.phase = 'booster';
          this.boostStart = t;
          this.boostFrom = this.alt;
          // ブースター直前の速さ（km/秒）から始める（いきなり止まって見えないように）
          // つきが近くて声も大きかった人は、3秒かけると遅く見えるので短くする（平均でいまの1.5倍の速さ以上）
          const dist = this.s.goal2Km - this.alt;
          const v0 = this.lastSpeed;
          this.boostSec = v0 > 0 ? Math.min(BOOSTER_SEC, Math.max(BOOSTER_MIN_SEC, dist / (1.5 * v0))) : BOOSTER_SEC;
          this.boostV0 = dist > 0 ? (v0 * this.boostSec) / dist : 1;
          this.boosted = true;
          events.push({ type: 'booster' });
        } else {
          this.finish('time', events);
        }
      }
    } else if (this.phase === 'booster') {
      this.cheer = hasDb ? db : this.cheer;
      const p = Math.min(1, (t - this.boostStart) / (this.boostSec * 1000));
      this.alt = this.boostFrom + (this.s.goal2Km - this.boostFrom) * boostCurve(p, this.boostV0);
      this.checkGoals(events, true);
      if (p >= 1) {
        this.alt = Math.max(this.alt, this.s.goal2Km);
        this.checkGoals(events, true);
        this.enterEndless(t, events);
      }
    } else if (this.phase === 'endless') {
      if (hasDb) {
        this.alt += altitudeGain(db, dt, this.s);
        this.voice.push([this.rel(t), round1(db)]);
        this.silence = db >= this.s.threshold ? 0 : this.silence + dt;
      } else {
        this.silence += dt;
      }
      if (this.silence >= this.s.silenceEndSec) this.finish('silence', events);
      else if (t - this.endlessStart >= this.s.endlessMaxSec * 1000) this.finish('max', events);
    }

    const r = this.rel(t);
    if (r - this.lastAltT >= ALT_SAMPLE_MS || this.phase === 'done') {
      this.altSeries.push([r, Math.round(this.alt)]);
      this.lastAltT = r;
    }
    return events;
  }

  checkGoals(events, boosted) {
    if (!this.reached.goal1 && this.alt >= this.s.goal1Km) {
      this.reached.goal1 = true;
      events.push({ type: 'goal1', boosted });
    }
    if (!this.reached.goal2 && this.alt >= this.s.goal2Km) {
      this.reached.goal2 = true;
      events.push({ type: 'goal2', boosted });
    }
  }

  enterEndless(t, events) {
    this.phase = 'endless';
    this.endlessStart = t;
    this.silence = 0;
    this.cheer = null;
    events.push({ type: 'endless' });
  }

  finish(reason, events) {
    this.phase = 'done';
    this.endReason = reason;
    events.push({ type: 'end', reason });
  }

  /** 保存用の記録（id・名前・時刻は呼び出し側で付ける）。 */
  result() {
    const dbs = this.voice.map(([, d]) => d);
    const meanDb = dbs.length ? round1(dbs.reduce((a, b) => a + b, 0) / dbs.length) : null;
    const score = Math.round(this.alt);
    return {
      game: 'rocket',
      score,
      meanDb,
      reached: reachedLandmark(score, this.marks).key,
      boosted: this.boosted,
      endReason: this.endReason,
      durationMs: this.altSeries.length ? this.altSeries[this.altSeries.length - 1][0] : 0,
      series: thin(this.voice, VOICE_SAVE_MS),
      alt: this.altSeries,
    };
  }
}
