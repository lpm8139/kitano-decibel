import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateKey,
  recordsKey,
  formatDateTime,
  sortRecords,
  topN,
  bestRecord,
  rankOf,
  renameRecord,
  removeRecord,
  normalizeName,
  normalizeSettings,
  DEFAULT_SETTINGS,
  csvEscape,
  neutralizeFormula,
  buildCsv,
  loadRecords,
  saveRecords,
  loadSettings,
  saveSettings,
  clearRecords,
} from '../js/storage.js';

// テスト用のメモリ storage
function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

const rec = (id, score, ts, extra = {}) => ({ id, name: id, score, ts, series: [[0, score]], ...extra });

// ---- 日付キー ----

test('localDateKey: ローカル日付で 0 埋めされる', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 9, 3)), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
});

test('localDateKey: 深夜0時直後も同じローカル日付（UTC換算にならない）', () => {
  assert.equal(localDateKey(new Date(2026, 9, 10, 0, 0, 1)), '2026-10-10');
  assert.equal(localDateKey(new Date(2026, 9, 9, 23, 59, 59)), '2026-10-09');
});

test('recordsKey / formatDateTime', () => {
  assert.equal(recordsKey('2026-10-09'), 'kitano-decibel:records:2026-10-09');
  assert.equal(formatDateTime(new Date(2026, 9, 9, 7, 5, 3).getTime()), '2026-10-09 07:05:03');
});

// ---- ランキング ----

test('sortRecords: スコア降順、同点は先に記録した方が上、元配列は不変', () => {
  const input = [rec('a', 70, 3), rec('b', 80, 5), rec('c', 70, 1), rec('d', 90, 9)];
  const copy = [...input];
  const sorted = sortRecords(input);
  assert.deepEqual(sorted.map((r) => r.id), ['d', 'b', 'c', 'a']);
  assert.deepEqual(input, copy);
});

test('topN / bestRecord / rankOf', () => {
  const rs = Array.from({ length: 12 }, (_, i) => rec(`r${i}`, 50 + i, i));
  assert.equal(topN(rs, 10).length, 10);
  assert.equal(topN(rs, 10)[0].id, 'r11');
  assert.equal(bestRecord(rs).id, 'r11');
  assert.equal(bestRecord([]), null);
  assert.equal(rankOf(rs, 'r11'), 1);
  assert.equal(rankOf(rs, 'r0'), 12);
  assert.equal(rankOf(rs, 'nothing'), 0);
  assert.deepEqual(topN([], 10), []);
});

test('renameRecord / removeRecord / normalizeName', () => {
  const rs = [rec('a', 1, 1), rec('b', 2, 2)];
  assert.equal(renameRecord(rs, 'a', 'たろう')[0].name, 'たろう');
  assert.equal(rs[0].name, 'a'); // 元は不変
  assert.deepEqual(removeRecord(rs, 'a').map((r) => r.id), ['b']);
  assert.equal(normalizeName('  山田  '), '山田');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName('あ'.repeat(30)).length, 20);
});

// ---- 設定 ----

test('normalizeSettings: 既定値・範囲クランプ・不正値・知らない項目は捨てる', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  const s = normalizeSettings({ stage1Sec: 99, threshold: -5, floor: '58', offset: 'abc', deviceId: 3, kmRate: 5, duration: 5, scoreMethod: 'leq' });
  assert.equal(s.stage1Sec, 10);
  assert.equal(s.threshold, 0);
  assert.equal(s.floor, 58);
  assert.equal(s.offset, DEFAULT_SETTINGS.offset);
  assert.equal(s.deviceId, '');
  assert.equal('duration' in s, false); // 旧設定は捨てる
  assert.equal('scoreMethod' in s, false);
  assert.equal(normalizeSettings({ stage1Sec: 6.6 }).stage1Sec, 7);
  assert.equal(normalizeSettings({ floor: '' }).floor, DEFAULT_SETTINGS.floor); // 空欄は既定値
  assert.equal(normalizeSettings({ endlessMaxSec: 1 }).endlessMaxSec, 3);
  assert.equal(normalizeSettings({ bgmVolume: 7 }).bgmVolume, 1);
});

test('normalizeSettings: オン/オフ・背景・暗証番号・目標の高さの前後関係', () => {
  assert.equal(normalizeSettings({ nameInput: false }).nameInput, false);
  assert.equal(normalizeSettings({ nameInput: 'false' }).nameInput, false);
  assert.equal(normalizeSettings({ nameInput: 'x' }).nameInput, true); // 不正値は既定
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeSettings({ theme: 'neon' }).theme, 'light');
  assert.equal(normalizeSettings({ adminPin: '1234' }).adminPin, '1234');
  assert.equal(normalizeSettings({ adminPin: '12' }).adminPin, '0000');
  assert.equal(normalizeSettings({ adminPin: 1234 }).adminPin, '0000');
  const g = normalizeSettings({ goal1Km: 300, goal2Km: 200 });
  assert.ok(g.goal2Km > g.goal1Km, `つき(${g.goal2Km}) は うちゅう(${g.goal1Km}) より上`);
  assert.equal(normalizeSettings({ goal2Km: 5000 }).goal2Km, 790); // かせいより手前
});

test('normalizeSettings: 旧版の設定ファイルは floor を既定に戻し、校正オフセットなどは引き継ぐ', () => {
  const old = { deviceId: 'mic-1', duration: 5, threshold: 70, floor: 40, offset: 98.5, scoreMethod: 'mean' };
  const s = normalizeSettings(old);
  assert.equal(s.floor, DEFAULT_SETTINGS.floor);
  assert.equal(s.offset, 98.5);
  assert.equal(s.threshold, 70);
  assert.equal(s.deviceId, 'mic-1');
  assert.equal(normalizeSettings({ ...s, floor: 40 }).floor, 40); // ロケット版の設定なら floor はそのまま
});

test('部門: 名前・正規化・絞り込み', async () => {
  const { DIVISIONS, divisionName, normalizeDivision, inDivision } = await import('../js/storage.js');
  assert.deepEqual(DIVISIONS.map((d) => d.key), ['k', 'low', 'high', 'adult']);
  assert.equal(divisionName('k'), 'ようちえん');
  assert.equal(divisionName('high', true), '4〜6ねん');
  assert.equal(divisionName(''), '');
  assert.equal(normalizeDivision('low'), 'low');
  assert.equal(normalizeDivision('adult'), 'adult');
  assert.equal(normalizeDivision('teen'), '');
  const rs = [rec('a', 1, 1, { division: 'k' }), rec('b', 2, 2), rec('c', 3, 3, { division: 'k' })];
  assert.deepEqual(inDivision(rs, 'k').map((r) => r.id), ['a', 'c']);
  assert.deepEqual(inDivision(rs, '').map((r) => r.id), ['b']);
  assert.equal(inDivision(rs, null).length, 3);
});

// ---- CSV ----

test('csvEscape / neutralizeFormula', () => {
  assert.equal(csvEscape('abc'), 'abc');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(null), '');
  assert.equal(neutralizeFormula('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(neutralizeFormula('@foo'), "'@foo");
  assert.equal(neutralizeFormula('たろう'), 'たろう');
});

test('buildCsv: BOM・ヘッダ・高さ順・場所名・エスケープ', () => {
  const t = new Date(2026, 9, 9, 10, 0, 0).getTime();
  const csv = buildCsv([
    rec('a', 520, t, { name: 'A,B', meanDb: 72.25, reached: 'moon', boosted: true, division: 'low' }),
    rec('b', 1650.4, t + 1000, { name: '=evil', meanDb: 88.1, reached: 'saturn', clipped: true, division: 'high' }),
    rec('c', 600, t + 2000, { name: 'C', meanDb: 70, reached: 'moon', division: 'low' }),
  ]);
  assert.ok(csv.startsWith('\ufeff順位,名前,部門,部門内順位,高さ(km),とどいた場所,平均dB,ブースター,記録時刻,クリップ\r\n'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "1,'=evil,4〜6ねんせい,1,1650,どせい,88.1,,2026-10-09 10:00:01,あり");
  assert.equal(lines[2], '2,C,1〜3ねんせい,1,600,つき,70.0,,2026-10-09 10:00:02,');
  assert.equal(lines[3], `3,"A,B",1〜3ねんせい,2,520,つき,${(72.25).toFixed(1)},あり,2026-10-09 10:00:00,`);
  assert.equal(buildCsv([]).trim().split('\r\n').length, 1); // ヘッダのみ
});

// ---- localStorage 読み書き ----

test('saveRecords / loadRecords: 往復・日付ごとに分離・不正データ除去', () => {
  const st = memoryStorage();
  const a = [rec('a', 70, 1)];
  assert.equal(saveRecords('2026-10-09', a, st), true);
  assert.deepEqual(loadRecords('2026-10-09', st), a);
  assert.deepEqual(loadRecords('2026-10-10', st), []);

  st.setItem(recordsKey('2026-10-11'), JSON.stringify([rec('ok', 1, 1), { id: 'bad' }, null, 5]));
  assert.deepEqual(loadRecords('2026-10-11', st).map((r) => r.id), ['ok']);

  st.setItem(recordsKey('2026-10-12'), '{壊れたJSON');
  assert.deepEqual(loadRecords('2026-10-12', st), []);
  st.setItem(recordsKey('2026-10-13'), '{"a":1}');
  assert.deepEqual(loadRecords('2026-10-13', st), []);
});

test('clearRecords: その日だけ消える', () => {
  const st = memoryStorage();
  saveRecords('2026-10-09', [rec('a', 1, 1)], st);
  saveRecords('2026-10-10', [rec('b', 1, 1)], st);
  clearRecords('2026-10-09', st);
  assert.deepEqual(loadRecords('2026-10-09', st), []);
  assert.equal(loadRecords('2026-10-10', st).length, 1);
});

test('saveRecords: 容量超過などの例外は false', () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.equal(saveRecords('2026-10-09', [], full), false);
  assert.equal(saveRecords('2026-10-09', [], null), false);
});

test('saveSettings / loadSettings: 往復と壊れたデータ', () => {
  const st = memoryStorage();
  assert.deepEqual(loadSettings(st), { ...DEFAULT_SETTINGS });
  saveSettings({ ...DEFAULT_SETTINGS, stage1Sec: 8, deviceId: 'dev-1', nameInput: false }, st);
  const s = loadSettings(st);
  assert.equal(s.stage1Sec, 8);
  assert.equal(s.deviceId, 'dev-1');
  assert.equal(s.nameInput, false);
  st.setItem('kitano-decibel:settings', 'xx');
  assert.deepEqual(loadSettings(st), { ...DEFAULT_SETTINGS });
  assert.deepEqual(loadSettings(null), { ...DEFAULT_SETTINGS });
});

test('pruneOtherDays: 当日以外の記録だけ消え、設定は残る', async () => {
  const { pruneOtherDays, saveRecords, loadRecords, saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../js/storage.js');
  const mem = new Map();
  const st = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const r = [{ id: 'a', score: 80, ts: 1, series: [] }];
  saveRecords('2026-10-09', r, st);
  saveRecords('2026-10-10', r, st);
  saveRecords('2026-10-11', r, st);
  saveSettings({ ...DEFAULT_SETTINGS, offset: 98 }, st);
  const removed = pruneOtherDays('2026-10-10', st).sort();
  assert.deepEqual(removed, ['2026-10-09', '2026-10-11']);
  assert.equal(loadRecords('2026-10-10', st).length, 1);
  assert.equal(loadRecords('2026-10-09', st).length, 0);
  assert.equal(loadSettings(st).offset, 98);
});
