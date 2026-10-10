// game.js（ロケットのルール）のテスト。時刻を自分で進めて、画面なしで流れを確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOSTER_SEC,
  thin,
  RocketRun,
  altitudeAt,
  altitudeGain,
  isRankable,
  landmarksFor,
  nextLandmark,
  reachedLandmark,
} from '../js/game.js';

const S = Object.freeze({
  floor: 55, kmRate: 5, goal1Km: 100, goal2Km: 500, stage1Sec: 5,
  endlessMaxSec: 10, silenceEndSec: 1, threshold: 65, booster: true,
});

/** dbAt(tSec) の声を 20Hz で流し、条件を満たすか maxSec たつまで回す。発生したイベントを返す。 */
function play(run, dbAt, maxSec = 30, t0 = 1000) {
  const ev = [];
  ev.push(...run.start(t0, dbAt(0)).map((e) => ({ ...e, t: 0 })));
  for (let i = 1; i <= maxSec * 20 && run.phase !== 'done'; i++) {
    const t = i / 20;
    ev.push(...run.update(t0 + t * 1000, dbAt(t)).map((e) => ({ ...e, t })));
  }
  return ev;
}

test('altitudeGain: floor 以下は 0、超えた分×kmRate×秒', () => {
  assert.equal(altitudeGain(50, 1, S), 0);
  assert.equal(altitudeGain(75, 1, S), 100);
  assert.equal(altitudeGain(75, 0.05, S), 5);
  assert.equal(altitudeGain(NaN, 1, S), 0);
  assert.equal(altitudeGain(80, 0, S), 0);
});

test('大きな声（80dB）: うちゅう→つきに5秒以内に届き、そのままエンドレスへ（ブースターなし）', () => {
  const run = new RocketRun(S);
  const ev = play(run, () => 80, 4.5);
  const types = ev.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['goal1', 'goal2', 'endless']);
  const g2 = ev.find((e) => e.type === 'goal2');
  assert.ok(g2.t > 3.8 && g2.t < 4.2, `つき到達 ${g2.t}s`); // 125km/s → 4秒
  assert.equal(g2.boosted, false);
  assert.equal(run.boosted, false);
});

test('小さな声（60dB）: 5秒で届かず → ブースターで3秒かけて月へ → エンドレス', () => {
  const run = new RocketRun(S);
  const ev = play(run, () => 60, 8.5);
  const b = ev.find((e) => e.type === 'booster');
  assert.ok(b && Math.abs(b.t - 5) < 0.06, 'ブースターは5秒で発動');
  const g2 = ev.find((e) => e.type === 'goal2');
  assert.equal(g2.boosted, true);
  const en = ev.find((e) => e.type === 'endless');
  assert.ok(Math.abs(en.t - (5 + BOOSTER_SEC)) < 0.06, `エンドレス開始 ${en.t}s`);
  assert.ok(run.alt >= 500 && run.alt < 520, `エンドレス開始直後の高さ ${run.alt}`); // 月(500)から再スタート
  assert.equal(run.boosted, true);
});

test('ブースターの間の声は高さにも平均dBにも入らない（応援は表示だけ）', () => {
  const run = new RocketRun(S);
  play(run, (t) => (t >= 5 && t < 8 ? 100 : 60), 7);
  assert.equal(run.phase, 'booster');
  assert.equal(run.cheer, 100);
  assert.ok(run.voice.every(([t]) => t <= 5000), 'ブースター中のサンプルは記録しない（5.0秒ちょうどは stage1 の最後）');
  assert.ok(run.alt <= 500);
});

test('エンドレス: 声が1秒とぎれたら終了（理由 silence）', () => {
  const run = new RocketRun(S);
  const ev = play(run, (t) => (t < 6 ? 80 : 40), 20);
  const end = ev.find((e) => e.type === 'end');
  assert.equal(end.reason, 'silence');
  assert.ok(end.t > 6.9 && end.t < 7.2, `終了 ${end.t}s`);
  assert.equal(run.phase, 'done');
});

test('エンドレス: しきい値未満の小声も「とぎれ」扱い。最長10秒で終了（理由 max）', () => {
  const run = new RocketRun(S);
  const ev = play(run, () => 80, 30);
  const en = ev.find((e) => e.type === 'endless');
  const end = ev.find((e) => e.type === 'end');
  assert.equal(end.reason, 'max');
  assert.ok(Math.abs(end.t - en.t - 10) < 0.06, `エンドレス ${end.t - en.t}s`);
  // 80dB を 14 秒 → 125km/s × 14 = 1750km
  assert.ok(Math.abs(run.alt - 1750) < 15, `高さ ${run.alt}`);

  const quiet = new RocketRun(S);
  const ev2 = play(quiet, (t) => (t < 4.5 ? 80 : 62), 30); // 62dB は floor 超え・しきい値未満
  assert.equal(ev2.find((e) => e.type === 'end').reason, 'silence');
});

test('ブースター無効: 届かなければ5秒で終了（理由 time）', () => {
  const run = new RocketRun({ ...S, booster: false });
  const ev = play(run, () => 60, 10);
  assert.deepEqual(ev.map((e) => e.type), ['goal1', 'end']);
  assert.equal(ev[1].reason, 'time');
});

test('サンプルが大きく空いても1回の加算は0.25秒ぶんまで', () => {
  const run = new RocketRun(S);
  run.start(0, 80);
  run.update(5000, 80); // 5秒とんだ
  assert.ok(run.alt <= 125 * 0.25 + 1e-9, `高さ ${run.alt}`);
});

test('result: スコア=高さ（整数）、平均dB、到達した目印、高さ履歴は単調増加', () => {
  const run = new RocketRun(S);
  play(run, (t) => (t < 9 ? 80 : 40), 30);
  const r = run.result();
  assert.equal(r.game, 'rocket');
  assert.equal(r.score, Math.round(run.alt));
  assert.equal(r.meanDb, (() => { const d = run.voice.map(([, x]) => x); return Math.round((d.reduce((a, b) => a + b) / d.length) * 10) / 10; })());
  assert.ok(r.series.length < run.voice.length * 0.6, `声の履歴は間引いて保存 (${r.series.length}/${run.voice.length})`);
  assert.deepEqual(r.series[r.series.length - 1], run.voice[run.voice.length - 1]);
  assert.equal(r.reached, reachedLandmark(r.score, landmarksFor(S)).key);
  assert.equal(r.boosted, false);
  for (let i = 1; i < r.alt.length; i++) {
    assert.ok(r.alt[i][0] >= r.alt[i - 1][0] && r.alt[i][1] >= r.alt[i - 1][1]);
  }
  assert.ok(r.alt.length < 200, `履歴は 10Hz 程度 (${r.alt.length})`);
  assert.equal(r.durationMs, r.alt[r.alt.length - 1][0]);
});

test('目標の高さは設定で変えられる', () => {
  const s = { ...S, goal1Km: 50, goal2Km: 300 };
  const marks = landmarksFor(s);
  assert.equal(marks.find((m) => m.key === 'space').km, 50);
  assert.equal(marks.find((m) => m.key === 'moon').km, 300);
  const run = new RocketRun(s);
  const ev = play(run, () => 70, 6); // 75km/s → つき(300) は 4 秒
  assert.ok(ev.some((e) => e.type === 'goal2' && !e.boosted));
});

test('altitudeAt / reachedLandmark / nextLandmark / isRankable', () => {
  const s = [[0, 0], [1000, 100], [2000, 300]];
  assert.equal(altitudeAt(s, -5), 0);
  assert.equal(altitudeAt(s, 500), 50);
  assert.equal(altitudeAt(s, 1500), 200);
  assert.equal(altitudeAt(s, 9999), 300);
  assert.equal(altitudeAt([], 10), 0);
  const marks = landmarksFor(S);
  assert.equal(reachedLandmark(0, marks).key, 'earth');
  assert.equal(reachedLandmark(820, marks).key, 'mars');
  assert.equal(nextLandmark(820, marks).key, 'jupiter');
  assert.equal(nextLandmark(99999, marks), null);
  assert.equal(isRankable({ game: 'rocket', score: 10 }), true);
  assert.equal(isRankable({ game: 'rocket', score: 10, deleted: true }), false);
  assert.equal(isRankable({ game: 'rocket', score: 10, rehearsal: true }), false);
  assert.equal(isRankable({ score: 80 }), false); // 旧形式（平均dB）の記録
});

test('thin: 間隔を空けて間引き、最後の点は残す', () => {
  const s = Array.from({ length: 11 }, (_, i) => [i * 50, i]);
  assert.deepEqual(thin(s, 100).map(([t]) => t), [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(thin([], 100), []);
  assert.deepEqual(thin([[0, 1], [30, 2]], 100), [[0, 1], [30, 2]]);
});
