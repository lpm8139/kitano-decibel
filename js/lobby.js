// lobby.js
// 受付（スマホで登録した順番待ち・最近の結果）を保存サーバーと同期する。PC 側から使う。
// サーバーの /api/lobby を 1 秒ごとに見に行き、変わったら onChange(lobby) を呼ぶ。

const POLL_MS = 1000;
const TIMEOUT_MS = 4000;

export class LobbyClient {
  constructor({ onChange = () => {}, fetchImpl } = {}) {
    this.onChange = onChange;
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.lobby = { rev: -1, queue: [], recent: [] };
    this.timer = null;
    this.online = false;
  }

  async request(body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch('/api/lobby', {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lb = await res.json();
      this.online = true;
      this.accept(lb);
      return lb;
    } finally {
      clearTimeout(t);
    }
  }

  accept(lb) {
    if (!lb || typeof lb !== 'object' || !Array.isArray(lb.queue)) return;
    if (lb.rev === this.lobby.rev) return;
    this.lobby = { rev: lb.rev, queue: lb.queue, recent: Array.isArray(lb.recent) ? lb.recent : [] };
    this.onChange(this.lobby);
  }

  start() {
    const tick = async () => {
      try {
        await this.request();
      } catch {
        this.online = false;
      }
      this.timer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  get queue() {
    return this.lobby.queue;
  }

  /** 順番待ちから外す（呼んだとき・取り消し）。画面はすぐ更新し、サーバーには後から送る。 */
  remove(id) {
    const before = this.lobby.queue;
    this.lobby = { ...this.lobby, queue: before.filter((x) => x.id !== id) };
    this.onChange(this.lobby);
    return this.request({ op: 'remove', id }).catch(() => {});
  }

  add(name, division) {
    return this.request({ op: 'add', name, division });
  }

  clear() {
    return this.request({ op: 'clear' });
  }

  /** 結果をスマホに見せる（スマホから名前・部門を後から付けられる）。 */
  pushResult(entry) {
    return this.request({ op: 'result', entry }).catch(() => {});
  }
}
