import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rmsOf,
  peakOf,
  rmsToDbfs,
  peakToDbfs,
  samplesToDbfs,
  MIN_DBFS,
  averageDb,
  leqDb,
  computeScore,
  roundTo1,
  cumulativeProgress,
  progressAt,
  totalProgress,
  leadState,
  laneScale,
  referenceProgress,
} from '../js/scoring.js';

const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} は ${expected} ±${eps} の範囲外`);

// ---- RMS → dBFS ----

test('rmsOf: 定数・正弦波・空配列', () => {
  assert.equal(rmsOf([]), 0);
  near(rmsOf([0.5, -0.5, 0.5, -0.5]), 0.5);
  const sine = Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * i) / 48));
  near(rmsOf(sine), Math.SQRT1_2, 1e-6);
});

test('rmsToDbfs: 基準値と無音の下限', () => {
  near(rmsToDbfs(1), 0);
  near(rmsToDbfs(0.5), -6.0206, 1e-3);
  near(rmsToDbfs(0.1), -20, 1e-9);
  assert.equal(rmsToDbfs(0), MIN_DBFS);
  assert.equal(rmsToDbfs(NaN), MIN_DBFS);
  assert.equal(rmsToDbfs(-1), MIN_DBFS);
});

test('samplesToDbfs: フルスケール正弦波は約 -3.01 dBFS', () => {
  const sine = Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * i) / 48));
  near(samplesToDbfs(sine), -3.0103, 1e-3);
});

test('peakOf / peakToDbfs: クリップ判定用', () => {
  assert.equal(peakOf([]), 0);
  assert.equal(peakOf([0.1, -0.9, 0.3]), 0.9);
  near(peakToDbfs(0.9), -0.9151, 1e-3);
  assert.ok(peakToDbfs(0.95) >= -1);
});

// ---- 平均 / Leq / スコア ----

test('averageDb: 算術平均、空は null', () => {
  near(averageDb([60, 70, 80]), 70);
  assert.equal(averageDb([]), null);
  near(averageDb([60, NaN, 80]), 70); // 非有限値は無視
});

test('leqDb: 同値ならその値、差があると算術平均より大きい', () => {
  near(leqDb([70, 70, 70]), 70);
  near(leqDb([60, 80]), 10 * Math.log10((1e6 + 1e8) / 2), 1e-9);
  assert.ok(leqDb([60, 80]) > averageDb([60, 80]));
  assert.equal(leqDb([]), null);
});

test('computeScore: 小数1桁・方式切替・空', () => {
  assert.equal(computeScore([60, 70, 75], 'mean'), 68.3);
  assert.equal(computeScore([70, 70, 70], 'leq'), 70);
  assert.equal(computeScore([60, 80], 'leq'), roundTo1(10 * Math.log10((1e6 + 1e8) / 2)));
  assert.equal(computeScore([], 'mean'), null);
  assert.equal(computeScore([50], undefined), 50); // 既定は mean
});

// ---- 累積 progress ----

test('cumulativeProgress: floor 以下は加算されない（20Hz想定）', () => {
  const series = [
    [0, 60],
    [50, 60],
    [100, 40], // floor ちょうど → 0
    [150, 30], // floor 未満 → 0
    [200, 50],
  ];
  const cum = cumulativeProgress(series, 40);
  assert.deepEqual(
    cum.map((c) => c.p),
    [0, 20, 20, 20, 30],
  );
  assert.deepEqual(
    cum.map((c) => c.t),
    [0, 50, 100, 150, 200],
  );
});

test('cumulativeProgress: 間隔が揺らぐと時間重みで補正される', () => {
  // 100ms 空いたサンプルは 2 サンプル分として扱う
  const cum = cumulativeProgress(
    [
      [0, 50],
      [100, 50],
    ],
    40,
  );
  near(cum[1].p, 20);
  assert.deepEqual(cumulativeProgress([], 40), []);
});

test('progressAt: 線形補間・範囲外', () => {
  const cum = cumulativeProgress(
    [
      [0, 60],
      [50, 60],
      [100, 60],
    ],
    40,
  ); // p: 0, 20, 40
  near(progressAt(cum, 25), 10);
  near(progressAt(cum, 50), 20);
  near(progressAt(cum, 75), 30);
  assert.equal(progressAt(cum, 0), 0);
  assert.equal(progressAt(cum, -10), 0);
  assert.equal(progressAt(cum, 100), 40);
  assert.equal(progressAt(cum, 9999), 40); // ゴースト終了後は最終値で止まる
  assert.equal(progressAt([], 100), 0);
});

test('progressAt: 先頭サンプルが t>0 のとき原点から補間する', () => {
  const cum = [{ t: 100, p: 10 }];
  near(progressAt(cum, 50), 5);
});

test('totalProgress', () => {
  assert.equal(totalProgress([]), 0);
  assert.equal(totalProgress([{ t: 0, p: 0 }, { t: 50, p: 12 }]), 12);
});

// ---- ゴースト比較 ----

test('leadState: リード / 逆転 / 同点', () => {
  assert.equal(leadState(110, 100), 'lead');
  assert.equal(leadState(90, 100), 'behind');
  assert.equal(leadState(100, 100), 'even');
  assert.equal(leadState(100.2, 100), 'even');
});

test('ゴーストを同時刻で再生して比較できる', () => {
  const ghost = cumulativeProgress(
    [
      [0, 60],
      [50, 60],
      [100, 60],
      [150, 60],
    ],
    40,
  ); // 0,20,40,60
  const you = cumulativeProgress(
    [
      [0, 80],
      [50, 80],
    ],
    40,
  ); // 0,40
  const t = 50;
  assert.equal(leadState(totalProgress(you), progressAt(ghost, t)), 'lead');
  const youLater = cumulativeProgress(
    [
      [0, 45],
      [50, 45],
      [100, 45],
      [150, 45],
    ],
    40,
  ); // 0,5,10,15
  assert.equal(leadState(progressAt(youLater, 150), progressAt(ghost, 150)), 'behind');
});

test('laneScale / referenceProgress', () => {
  near(referenceProgress(40, 5, 90), 50 * 100);
  assert.ok(referenceProgress(200, 5) >= 1);
  near(laneScale({ ghostTotal: 1000, current: 500, reference: 5000 }), 1050);
  near(laneScale({ ghostTotal: 1000, current: 2000, reference: 5000 }), 2100); // 挑戦者が超えたら追従
  near(laneScale({ ghostTotal: null, current: 100, reference: 5000 }), 5250);
});
