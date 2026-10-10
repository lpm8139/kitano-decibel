// storage.js
// 設定・本日の記録の保存。
// 前半は純関数（日付キー・並べ替え・設定の正規化・CSV生成）でテスト対象。
// 後半は localStorage 読み書き（storage を引数で差し替え可能）。import しただけでは何も触らない。

export const STORAGE_PREFIX = 'kitano-decibel';
export const SETTINGS_KEY = `${STORAGE_PREFIX}:settings`;

// ---------------------------------------------------------------------------
// 日付キー
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** ローカル日付の YYYY-MM-DD（UTCではなく端末のローカル時刻）。 */
export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 記録の localStorage キー。 */
export function recordsKey(dateKey) {
  return `${STORAGE_PREFIX}:records:${dateKey}`;
}

/** ローカル時刻の 'YYYY-MM-DD HH:MM:SS'。 */
export function formatDateTime(ts) {
  const d = new Date(ts);
  return `${localDateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// ランキング（純関数）
// ---------------------------------------------------------------------------

/** スコア降順。同点は先に記録した方が上。元の配列は変更しない。 */
export function sortRecords(records) {
  return [...records].sort((a, b) => b.score - a.score || a.ts - b.ts);
}

/** 上位 n 件。 */
export function topN(records, n = 10) {
  return sortRecords(records).slice(0, n);
}

/** 本日ベスト（=ゴースト）。記録が無ければ null。 */
export function bestRecord(records) {
  return records.length ? sortRecords(records)[0] : null;
}

/** id の順位（1始まり）。見つからなければ 0。 */
export function rankOf(records, id) {
  const idx = sortRecords(records).findIndex((r) => r.id === id);
  return idx + 1;
}

/** 名前を更新した新しい配列を返す（updatedAt も更新。サーバーとのマージで新しい方が勝つため）。 */
export function renameRecord(records, id, name, now = Date.now()) {
  return records.map((r) => (r.id === id ? { ...r, name, updatedAt: now } : r));
}

/** 指定 id を除いた新しい配列を返す。 */
export function removeRecord(records, id) {
  return records.filter((r) => r.id !== id);
}

/**
 * 指定 id を「破棄済み」にした新しい配列を返す（tombstone）。
 * 配列から消すと、サーバーや別タブとのマージで復活してしまうため、印を付けて残す。
 * ファイル上にも残るので、誤って破棄しても data/ から復旧できる。
 */
export function markDeleted(records, id, now = Date.now()) {
  return records.map((r) => (r.id === id ? { ...r, deleted: true, updatedAt: now } : r));
}

/** 全件を破棄済みにする（「本日の記録をリセット」用。ファイルからは消さない）。 */
export function markAllDeleted(records, now = Date.now()) {
  return records.map((r) => (r.deleted ? r : { ...r, deleted: true, updatedAt: now }));
}

/** 名前の正規化（前後空白除去・最大20文字）。 */
export function normalizeName(name) {
  return String(name ?? '').trim().slice(0, 20);
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  deviceId: '', // '' = 既定のマイク
  duration: 5, // 計測秒数
  threshold: 65, // 計測開始しきい値（表示dB）
  floor: 40, // progress の floor（表示dB）
  offset: 100, // 校正オフセット（仮値。dBFS + offset が表示dB）
  scoreMethod: 'mean', // 'mean' | 'leq'
});

export const SETTINGS_LIMITS = Object.freeze({
  duration: { min: 3, max: 10 },
  threshold: { min: 0, max: 140 },
  floor: { min: 0, max: 120 },
  offset: { min: -100, max: 200 },
});

function clampNumber(value, fallback, min, max, integer = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  let n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (integer) n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

/** 任意の入力から、範囲内に収まった完全な設定オブジェクトを作る。 */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const L = SETTINGS_LIMITS;
  const d = DEFAULT_SETTINGS;
  return {
    deviceId: typeof r.deviceId === 'string' ? r.deviceId : d.deviceId,
    duration: clampNumber(r.duration, d.duration, L.duration.min, L.duration.max, true),
    threshold: clampNumber(r.threshold, d.threshold, L.threshold.min, L.threshold.max),
    floor: clampNumber(r.floor, d.floor, L.floor.min, L.floor.max),
    offset: clampNumber(r.offset, d.offset, L.offset.min, L.offset.max),
    scoreMethod: r.scoreMethod === 'leq' ? 'leq' : 'mean',
  };
}

// ---------------------------------------------------------------------------
// CSV（純関数）
// ---------------------------------------------------------------------------

/** CSVセルのエスケープ（, " 改行を含むときだけ引用符で囲む）。 */
export function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel で数式として解釈される先頭文字(= + - @ タブ CR)を無効化する。名前欄用。 */
export function neutralizeFormula(text) {
  const s = String(text ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const METHOD_LABEL = { mean: '平均', leq: 'Leq' };

/**
 * 本日の記録 → CSV 文字列（先頭に BOM、改行 CRLF。Excel でそのまま開ける）。
 * 行はランキング順。
 */
export function buildCsv(records) {
  const header = ['順位', '名前', 'スコア', '方式', '計測秒数', '記録時刻', 'クリップ'];
  const rows = sortRecords(records).map((r, i) => [
    i + 1,
    neutralizeFormula(r.name || ''),
    Number(r.score).toFixed(1),
    METHOD_LABEL[r.method] ?? r.method ?? '',
    r.duration ?? '',
    formatDateTime(r.ts),
    r.clipped ? 'あり' : '',
  ]);
  const body = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  return `﻿${body}\r\n`;
}

// ---------------------------------------------------------------------------
// localStorage 読み書き（storage は差し替え可能）
// ---------------------------------------------------------------------------

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // プライベートモード等でアクセス自体が例外になる場合
  }
}

function isValidRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    Number.isFinite(r.score) &&
    Number.isFinite(r.ts) &&
    Array.isArray(r.series)
  );
}

/** この端末（ブラウザ）に設定が保存済みか。 */
export function hasSavedSettings(storage = defaultStorage()) {
  try {
    return Boolean(storage?.getItem(SETTINGS_KEY));
  } catch {
    return false;
  }
}

/** 設定を読む。壊れていれば既定値。 */
export function loadSettings(storage = defaultStorage()) {
  try {
    const text = storage?.getItem(SETTINGS_KEY);
    return normalizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return normalizeSettings(null);
  }
}

/** 設定を保存。成功したら true。 */
export function saveSettings(settings, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** 指定日の記録を読む。壊れていれば空配列。不正な要素は捨てる。 */
export function loadRecords(dateKey, storage = defaultStorage()) {
  try {
    const text = storage?.getItem(recordsKey(dateKey));
    const data = text ? JSON.parse(text) : [];
    return Array.isArray(data) ? data.filter(isValidRecord) : [];
  } catch {
    return [];
  }
}

/** 指定日の記録を保存。成功したら true（容量超過などは false）。 */
export function saveRecords(dateKey, records, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(recordsKey(dateKey), JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

/** 指定日の記録を全削除。 */
export function clearRecords(dateKey, storage = defaultStorage()) {
  try {
    storage?.removeItem(recordsKey(dateKey));
    return true;
  } catch {
    return false;
  }
}

/** 記録IDを作る。 */
export function newRecordId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
