// scoring.js
// 音量の計算・スコア・ゴースト比較に関する「純関数のみ」のモジュール。
// DOM / localStorage / AudioContext には一切触れない（node --test でテストできる）。

/** サンプリング間隔（ms）。audio.js の約20Hzに対応。progress の時間重みの単位にも使う。 */
export const SAMPLE_INTERVAL_MS = 50;

/** 無音（RMS=0）のときに返す下限 dBFS。log10(0) = -Infinity を避ける。 */
export const MIN_DBFS = -120;

/** この dBFS 以上のピークでクリップ警告を出す。 */
export const CLIP_DBFS = -1;

/** スコア方式: 'mean' = dBサンプルの算術平均 / 'leq' = エネルギー平均(Leq) */
export const SCORE_METHODS = ['mean', 'leq'];

// ---------------------------------------------------------------------------
// 波形 → dBFS
// ---------------------------------------------------------------------------

/** 波形サンプル（-1.0〜1.0）の RMS。空配列は 0。 */
export function rmsOf(samples) {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** 波形サンプルの絶対値最大（ピーク）。空配列は 0。 */
export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/** 振幅（フルスケール=1.0）→ dBFS。0以下・非数は MIN_DBFS に丸める。 */
export function amplitudeToDbfs(amplitude) {
  if (!(amplitude > 0)) return MIN_DBFS;
  return Math.max(MIN_DBFS, 20 * Math.log10(amplitude));
}

/** RMS → dBFS（RMS=1.0 が 0 dBFS。なおフルスケール正弦波の RMS は約 -3.01 dBFS）。 */
export function rmsToDbfs(rms) {
  return amplitudeToDbfs(rms);
}

/** ピーク振幅 → dBFS。 */
export function peakToDbfs(peak) {
  return amplitudeToDbfs(peak);
}

/** 波形サンプル → RMS dBFS（まとめ関数）。 */
export function samplesToDbfs(samples) {
  return rmsToDbfs(rmsOf(samples));
}

// ---------------------------------------------------------------------------
// スコア
// ---------------------------------------------------------------------------

/** 小数1桁に丸める。 */
export function roundTo1(x) {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

function finiteOnly(values) {
  return Array.from(values).filter((v) => Number.isFinite(v));
}

/** dB サンプルの算術平均。有効なサンプルが無ければ null。 */
export function averageDb(dbs) {
  const v = finiteOnly(dbs);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** エネルギー平均 Leq = 10*log10( mean(10^(dB/10)) )。有効なサンプルが無ければ null。 */
export function leqDb(dbs) {
  const v = finiteOnly(dbs);
  if (v.length === 0) return null;
  const meanEnergy = v.reduce((a, b) => a + Math.pow(10, b / 10), 0) / v.length;
  return 10 * Math.log10(meanEnergy);
}

/**
 * スコア算出（小数1桁）。
 * @param {number[]} dbs 計測区間の dB サンプル（校正オフセット適用済み）
 * @param {'mean'|'leq'} method
 * @returns {number|null} サンプルが無ければ null
 */
export function computeScore(dbs, method = 'mean') {
  const raw = method === 'leq' ? leqDb(dbs) : averageDb(dbs);
  return raw === null ? null : roundTo1(raw);
}

// ---------------------------------------------------------------------------
// 累積 progress（ゴースト競争用）
// ---------------------------------------------------------------------------
// 時系列 series は [[t_ms, db], ...]（t は計測開始からの経過ms、昇順）。
//
// progress(t) = Σ max(0, dB_i − floor) を「最終スコアで正規化しない生の累積値」で扱う。
// ただしタイマーの揺らぎで不利/有利が出ないよう、各サンプルの寄与に
// (経過時間差 / SAMPLE_INTERVAL_MS) を掛ける。ちょうど20Hzなら素の Σ と一致する。

/**
 * 累積 progress 配列を作る。
 * @param {Array<[number, number]>} series
 * @param {number} floor
 * @returns {Array<{t:number, p:number}>}
 */
export function cumulativeProgress(series, floor) {
  const out = [];
  let prevT = 0;
  let p = 0;
  for (const [t, db] of series) {
    const dt = Math.max(0, t - prevT);
    p += Math.max(0, db - floor) * (dt / SAMPLE_INTERVAL_MS);
    out.push({ t, p });
    prevT = t;
  }
  return out;
}

/**
 * 累積配列の時刻 t(ms) における progress を線形補間で返す。
 * - t <= 0 は 0（原点 (0,0) から補間する）
 * - 最終サンプルより後は最終値で止まる（ゴーストがゴールした扱い）
 */
export function progressAt(cum, t) {
  if (!cum || cum.length === 0 || !(t > 0)) return 0;
  const last = cum[cum.length - 1];
  if (t >= last.t) return last.p;

  let prev = { t: 0, p: 0 };
  for (const point of cum) {
    if (t <= point.t) {
      const span = point.t - prev.t;
      if (span <= 0) return point.p;
      return prev.p + ((point.p - prev.p) * (t - prev.t)) / span;
    }
    prev = point;
  }
  return last.p;
}

/** 累積配列の最終値（合計 progress）。空なら 0。 */
export function totalProgress(cum) {
  return cum && cum.length ? cum[cum.length - 1].p : 0;
}

/**
 * リード判定。
 * @returns {'lead'|'behind'|'even'}
 */
export function leadState(current, ghost, epsilon = 0.5) {
  const diff = current - ghost;
  if (diff > epsilon) return 'lead';
  if (diff < -epsilon) return 'behind';
  return 'even';
}

/**
 * ゴースト未登録時の、レーン満タン基準になる progress。
 * 「refDb の声を duration 秒出し続けた場合」の累積値（20Hz換算）。
 */
export function referenceProgress(floor, duration, refDb = 90) {
  return Math.max(1, (refDb - floor) * duration * (1000 / SAMPLE_INTERVAL_MS));
}

/**
 * レーン(100%)に相当する progress。ゴーストがいればその最終値、いなければ基準値。
 * 挑戦者が超えたらそれに追従して伸びる（バーがはみ出さない）。5%の余白付き。
 */
export function laneScale({ ghostTotal = null, current = 0, reference = 1 }) {
  const base = ghostTotal !== null && ghostTotal > 0 ? ghostTotal : reference;
  return Math.max(base, current, 1) * 1.05;
}

/** series から dB だけを取り出す。 */
export function seriesToDbs(series) {
  return series.map((s) => s[1]);
}
