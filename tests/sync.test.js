// sync.js（マージ・送信キュー）と storage.js の tombstone 関数のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient, activeRecords, mergeRecords, recordStamp, sameRecords } from '../js/sync.js';
import { markAllDeleted, markDeleted, renameRecord } from '../js/storage.js';

const rec = (id, ts, extra = {}) => ({ id, ts, updatedAt: ts, score: 80, series: [[0, 80]], ...extra });

test('recordStamp: updatedAt → ts → 0', () => {
  assert.equal(recordStamp({ ts: 5, updatedAt: 9 }), 9);
  assert.equal(recordStamp({ ts: 5 }), 5);
  assert.equal(recordStamp({}), 0);
});

test('mergeRecords: 和集合・ts 昇順・元配列は変えない', () => {
  const a = [rec('b', 2)];
  const b = [rec('a', 1), rec('c', 3)];
  const m = mergeRecords(a, b);
  assert.deepEqual(m.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(a.map((r) => r.id), ['b']);
});

test('mergeRecords: 新しい updatedAt が勝つ（どちら側にあっても）', () => {
  const old = rec('a', 1, { name: '' });
  const renamed = { ...old, name: 'たろう', updatedAt: 10 };
  assert.equal(mergeRecords([old], [renamed])[0].name, 'たろう');
  assert.equal(mergeRecords([renamed], [old])[0].name, 'たろう');
});

test('mergeRecords: 破棄（tombstone）は古い版で復活しない・同時刻なら破棄を優先', () => {
  const live = rec('a', 1);
  const dead = { ...live, deleted: true, updatedAt: 5 };
  assert.equal(mergeRecords([dead], [live])[0].deleted, true);
  assert.equal(mergeRecords([live], [dead])[0].deleted, true);
  const sameTime = { ...live, deleted: true };
  assert.equal(mergeRecords([live], [sameTime])[0].deleted, true);
  assert.equal(mergeRecords([sameTime], [live])[0].deleted, true);
});

test('mergeRecords: 不正な要素・null は無視', () => {
  assert.deepEqual(mergeRecords(null, [null, { noid: 1 }, rec('a', 1)]).map((r) => r.id), ['a']);
});

test('activeRecords / sameRecords', () => {
  const all = [rec('a', 1), rec('b', 2, { deleted: true })];
  assert.deepEqual(activeRecords(all).map((r) => r.id), ['a']);
  assert.equal(sameRecords(all, [...all].reverse()), true);
  assert.equal(sameRecords(all, [rec('a', 1)]), false);
  assert.equal(sameRecords([rec('a', 1)], [rec('a', 1, { name: 'x' })]), false);
});

test('storage: markDeleted / markAllDeleted / renameRecord は updatedAt を進める', () => {
  const rs = [rec('a', 1), rec('b', 2)];
  const d = markDeleted(rs, 'a', 100);
  assert.deepEqual(d.map((r) => [r.id, !!r.deleted, r.updatedAt]), [['a', true, 100], ['b', false, 2]]);
  const all = markAllDeleted(d, 200);
  assert.deepEqual(all.map((r) => [r.id, r.deleted, r.updatedAt]), [['a', true, 100], ['b', true, 200]]);
  assert.equal(renameRecord(rs, 'b', 'X', 300)[1].updatedAt, 300);
});

// ---- SyncClient（fetch を差し替えて検証） ----

function fakeServer() {
  const s = { up: true, store: {}, calls: 0 };
  s.fetch = async (url, opt = {}) => {
    s.calls++;
    if (!s.up) throw new TypeError('Failed to fetch');
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    let out;
    if (url === '/api/health') out = { ok: true, server: 'fake', dataDir: '/data' };
    else if (url.startsWith('/api/records/')) {
      const key = url.slice('/api/records/'.length);
      if (opt.method === 'POST') s.store[key] = mergeRecords(s.store[key], body);
      out = s.store[key] ?? [];
    } else if (url === '/api/settings') out = opt.method === 'POST' ? (s.settings = body, { ok: true }) : s.settings ?? null;
    return { ok: true, status: 200, json: async () => out };
  };
  return s;
}

test('SyncClient: 送信成功でキューが空になり、マージ結果が返る', async () => {
  const srv = fakeServer();
  srv.store['2026-10-10'] = [rec('server-only', 1)];
  const merged = [];
  const c = new SyncClient({ fetchImpl: srv.fetch, onRecordsMerged: (k, m) => merged.push([k, m]), retryMs: 10 });
  await c.queueRecords('2026-10-10', [rec('local', 2)]);
  assert.equal(c.pending.size, 0);
  assert.equal(c.online, true);
  assert.deepEqual(merged[0][1].map((r) => r.id), ['server-only', 'local']);
});

test('SyncClient: サーバー停止中は保持し、復帰後の再送で保存される', async () => {
  const srv = fakeServer();
  srv.up = false;
  const statuses = [];
  const c = new SyncClient({ fetchImpl: srv.fetch, onStatus: (s) => statuses.push(s), retryMs: 20 });
  await c.queueRecords('2026-10-10', [rec('a', 1)]);
  await c.queueRecords('2026-10-10', [rec('a', 1), rec('b', 2)]); // 同じ日付は最新で上書き
  assert.equal(c.pending.size, 1);
  assert.equal(c.online, false);
  srv.up = true;
  await new Promise((r) => setTimeout(r, 80)); // 自動再送を待つ
  assert.equal(c.pending.size, 0);
  assert.deepEqual(srv.store['2026-10-10'].map((r) => r.id), ['a', 'b']);
  assert.equal(statuses.at(-1).online, true);
});

test('SyncClient: health で保存先パスを取得', async () => {
  const srv = fakeServer();
  const c = new SyncClient({ fetchImpl: srv.fetch });
  const h = await c.health();
  assert.equal(h.ok, true);
  assert.equal(c.dataDir, '/data');
  srv.up = false;
  assert.equal(await c.health(), null);
  assert.equal(c.online, false);
});
