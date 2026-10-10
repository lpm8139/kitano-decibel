// sync.js
// 保存サーバー（server.py / server.ps1）との同期。
// 前半: 純関数（マージ・有効記録の抽出）。テスト対象で、server.py の merge_records と同じ規則。
// 後半: SyncClient … 送信キュー。届かなければ保持して一定間隔で再送する。計測は止めない。

/** 記録の更新時刻。updatedAt が無い古い記録は ts。 */
export function recordStamp(r) {
  if (Number.isFinite(r?.updatedAt)) return r.updatedAt;
  if (Number.isFinite(r?.ts)) return r.ts;
  return 0;
}

/**
 * ID ごとに新しい方（updatedAt が大きい方）を残す。同時刻なら破棄済み(deleted)を優先。
 * ts 昇順で返す。元の配列は変更しない。
 */
export function mergeRecords(a = [], b = []) {
  const byId = new Map();
  for (const r of [...(a ?? []), ...(b ?? [])]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    const cur = byId.get(r.id);
    if (!cur) {
      byId.set(r.id, r);
      continue;
    }
    const sr = recordStamp(r);
    const sc = recordStamp(cur);
    if (sr > sc || (sr === sc && r.deleted && !cur.deleted)) byId.set(r.id, r);
  }
  return [...byId.values()].sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** 破棄・リセットされていない記録だけ。 */
export function activeRecords(all) {
  return (all ?? []).filter((r) => !r.deleted);
}

/** 2つの記録配列が同じ内容か（ID と更新時刻と削除状態で比較）。 */
export function sameRecords(a, b) {
  if (a.length !== b.length) return false;
  const key = (r) => `${r.id}|${recordStamp(r)}|${r.deleted ? 1 : 0}|${r.name ?? ''}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// SyncClient
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 4000;

export class SyncClient {
  /**
   * @param {object} opt
   * @param {(s:{online:boolean,pending:number,dataDir:string|null,lastError:string|null})=>void} [opt.onStatus]
   * @param {(dateKey:string, merged:object[])=>void} [opt.onRecordsMerged] サーバー側マージ結果
   * @param {number} [opt.retryMs]
   * @param {typeof fetch} [opt.fetchImpl]
   */
  constructor({ onStatus = () => {}, onRecordsMerged = () => {}, retryMs = 5000, fetchImpl } = {}) {
    this.onStatus = onStatus;
    this.onRecordsMerged = onRecordsMerged;
    this.retryMs = retryMs;
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.pending = new Map(); // key -> { url, body, dateKey }
    this.online = false;
    this.dataDir = null;
    this.lastError = null;
    this.timer = null;
    this.flushing = false;
  }

  async request(path, { method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  emit() {
    this.onStatus({ online: this.online, pending: this.pending.size, dataDir: this.dataDir, lastError: this.lastError });
  }

  setOnline(online, err = null) {
    this.online = online;
    this.lastError = err ? String(err.message ?? err) : null;
    this.emit();
  }

  /** サーバーが生きているか。生きていれば保存先パスも取得。 */
  async health() {
    try {
      const h = await this.request('/api/health');
      this.dataDir = h?.dataDir ?? null;
      this.setOnline(Boolean(h?.ok));
      return h;
    } catch (e) {
      this.setOnline(false, e);
      return null;
    }
  }

  async loadRecords(dateKey) {
    const data = await this.request(`/api/records/${dateKey}`);
    return Array.isArray(data) ? data : [];
  }

  async loadSettings() {
    return this.request('/api/settings');
  }

  /** その日の全記録を送信キューへ（同じ日付は最新で上書き）。 */
  queueRecords(dateKey, records) {
    this.pending.set(`records:${dateKey}`, { url: `/api/records/${dateKey}`, body: records, dateKey });
    this.emit();
    return this.flush();
  }

  queueSettings(settings) {
    this.pending.set('settings', { url: '/api/settings', body: settings });
    this.emit();
    return this.flush();
  }

  scheduleRetry() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.retryMs);
  }

  /** キューを全部送る。失敗したものは残して再送予約。 */
  async flush() {
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.again = false;
        for (const [key, item] of [...this.pending]) {
          try {
            const res = await this.request(item.url, { method: 'POST', body: item.body });
            if (this.pending.get(key) === item) this.pending.delete(key); // 送信中に新しい内容が積まれていなければ完了
            if (!this.online) this.setOnline(true);
            if (item.dateKey && Array.isArray(res)) this.onRecordsMerged(item.dateKey, res);
          } catch (e) {
            this.setOnline(false, e);
            break;
          }
        }
      } while (this.again && this.online);
    } finally {
      this.flushing = false;
      this.emit();
      if (this.pending.size) this.scheduleRetry();
    }
  }
}
