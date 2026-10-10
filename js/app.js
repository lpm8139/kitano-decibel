// app.js
// 状態遷移（待機 → スタンバイ → 計測中 → 結果 → 待機）とイベント配線。
// 計算は scoring.js、保存は storage.js、音声は audio.js、描画は render.js に任せる。

import {
  CLIP_DBFS,
  computeScore,
  cumulativeProgress,
  laneScale,
  leadState,
  progressAt,
  referenceProgress,
  roundTo1,
  seriesToDbs,
  totalProgress,
} from './scoring.js';
import * as store from './storage.js';
import { MicMeter, listAudioInputs } from './audio.js';
import { createRenderer } from './render.js';
import { SyncClient, activeRecords, mergeRecords, sameRecords } from './sync.js';

/** スタンバイ中に反応がなければ待機へ戻るまでの時間（ms）。 */
const STANDBY_TIMEOUT_MS = 15000;
/** クリップ警告を出し続ける時間（ms）。 */
const CLIP_HOLD_MS = 2000;
/** 逆転演出を出す最小差（レーン満タン基準の割合）。序盤の揺らぎで連発しないため。 */
const ANNOUNCE_MIN_DIFF_RATIO = 0.03;
/** 保存サーバーの死活確認の間隔（ms）。つながっていない間は短く。 */
const HEALTH_ONLINE_MS = 10000;
const HEALTH_OFFLINE_MS = 5000;

const S = { IDLE: 'idle', STANDBY: 'standby', MEASURING: 'measuring', RESULT: 'result' };

const ui = createRenderer(document);

let settings = store.loadSettings();
let dateKey = store.localDateKey();
// allRecords: 破棄済み（deleted）も含む全記録。保存・同期はこちら。
// records   : 表示・ランキング・ゴーストに使う有効な記録だけ。
let allRecords = store.loadRecords(dateKey);
let records = activeRecords(allRecords);

let state = S.IDLE;
let currentDb = null; // 直近の表示dB
let standbyStart = 0;
let run = null; // 計測中のデータ { startAt, duration, samples, ghost, clipped, lastLead, reference }
let lastRecordId = null; // 直近に保存した記録（結果画面で名前を付ける対象）
let clipUntil = 0;
let micOk = false;
let micMessage = 'マイクを準備しています…';
let initialSynced = false; // サーバーと最初の突き合わせが済んだか
let settingsDirty = false; // 最初の突き合わせ前にこの画面で設定を変えたか（変えていればこちらを優先）

// ---------------------------------------------------------------------------
// 記録まわり
// ---------------------------------------------------------------------------

/** 日付をまたいだら（深夜0時など）、その日の記録に切り替える。計測中・結果表示中は触らない。 */
function syncDate() {
  const key = store.localDateKey();
  if (key !== dateKey) {
    dateKey = key;
    setAll(store.loadRecords(dateKey));
    refreshBoard();
    if (sync.online) pullDay(dateKey).catch(() => {});
  }
}

function setAll(next) {
  allRecords = next;
  records = activeRecords(next);
}

function refreshBoard(highlightId = null) {
  ui.renderTop10(records, highlightId);
  ui.renderBest(store.bestRecord(records));
}

/** ブラウザ内（localStorage）とPCのファイル（保存サーバー経由）の両方に保存する。 */
function persist() {
  store.saveRecords(dateKey, allRecords); // 失敗してもファイル側に送るので止めない
  sync.queueRecords(dateKey, allRecords);
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

function idleMessage() {
  if (!micOk) return { text: micMessage, tone: 'error' };
  const best = store.bestRecord(records);
  return {
    text: best
      ? `Space でスタンバイ ／ 本日ベスト ${best.score.toFixed(1)} を超えろ！`
      : 'Space でスタンバイ ／ 最初のチャレンジャーを待っています',
    tone: '',
  };
}

function goIdle(notice = '') {
  syncDate();
  state = S.IDLE;
  run = null;
  lastRecordId = null;
  ui.hideResult();
  ui.setState(S.IDLE);
  ui.resetRace();
  ui.setGhost(store.bestRecord(records));
  ui.setTimerText(`計測 ${settings.duration} 秒`);
  const m = idleMessage();
  ui.setMessage(notice && micOk ? notice : m.text, notice && micOk ? '' : m.tone);
}

function enterStandby() {
  if (!micOk) {
    ui.toast(micMessage || 'マイクが使えません');
    return;
  }
  syncDate();
  ui.hideResult();
  state = S.STANDBY;
  standbyStart = performance.now();
  run = null;
  ui.setState(S.STANDBY);
  ui.resetRace();
  ui.setGhost(store.bestRecord(records));
  ui.setMessage(`声を出すとスタート！（${settings.threshold} dB を超えたら計測開始）`);
}

function startMeasuring(now, db) {
  const best = store.bestRecord(records);
  let ghost = null;
  if (best) {
    const cum = cumulativeProgress(best.series, settings.floor);
    ghost = { record: best, cum, total: totalProgress(cum) };
  }
  run = {
    startAt: now,
    duration: settings.duration,
    samples: [],
    ghost,
    clipped: false,
    lastLead: null,
    reference: referenceProgress(settings.floor, settings.duration),
  };
  state = S.MEASURING;
  ui.setState(S.MEASURING);
  ui.setMessage('声を出し続けろ！');
  ui.setGhost(best);
  pushSample(now, db);
}

function pushSample(now, db) {
  const t = Math.max(0, Math.round(now - run.startAt));
  if (t > run.duration * 1000) return; // 規定時間を超えたサンプルは記録しない
  run.samples.push([t, roundTo1(db)]);
  updateRace();
}

/** 挑戦者とゴーストを「挑戦者の最新サンプル時刻」で比較して描画する。 */
function updateRace() {
  const cum = cumulativeProgress(run.samples, settings.floor);
  const last = cum[cum.length - 1];
  const you = last.p;
  const ghostP = run.ghost ? progressAt(run.ghost.cum, last.t) : null;
  const scale = laneScale({
    ghostTotal: run.ghost ? run.ghost.total : null,
    current: you,
    reference: run.reference,
  });
  const lead = ghostP === null ? 'solo' : leadState(you, ghostP);
  ui.renderRace({ you, ghost: ghostP, scale, lead });

  if (ghostP !== null && Math.abs(you - ghostP) > scale * ANNOUNCE_MIN_DIFF_RATIO) {
    if (run.lastLead === 'behind' && lead === 'lead') ui.announce('逆転！', 'lead');
    else if (run.lastLead === 'lead' && lead === 'behind') ui.announce('抜かれた！', 'behind');
    run.lastLead = lead;
  }
}

function finishMeasuring() {
  const samples = run.samples;
  const score = computeScore(seriesToDbs(samples), settings.scoreMethod);
  if (score === null) {
    goIdle('計測に失敗しました');
    return;
  }
  const prevBest = store.bestRecord(records);
  const ts = Date.now();
  const record = {
    id: store.newRecordId(),
    name: '',
    score,
    method: settings.scoreMethod,
    duration: run.duration,
    ts,
    updatedAt: ts,
    clipped: run.clipped,
    series: samples,
  };
  setAll([...allRecords, record]);
  persist(); // 名前入力前に先に保存（途中で閉じても記録が残る）
  lastRecordId = record.id;
  run = null;

  state = S.RESULT;
  const isNewRecord = !prevBest || score > prevBest.score;
  ui.setState(S.RESULT);
  ui.showResult({
    score,
    rank: store.rankOf(records, record.id),
    total: records.length,
    isNewRecord,
  });
  refreshBoard(record.id);
  if (isNewRecord) ui.flash();
}

/** 結果画面を閉じる前に、入力された名前を保存する。 */
function commitResult() {
  const name = store.normalizeName(ui.getResultName());
  if (lastRecordId && name) {
    setAll(store.renameRecord(allRecords, lastRecordId, name));
    persist();
    refreshBoard();
  }
  ui.hideResult();
}

function abort() {
  if (state === S.STANDBY || state === S.MEASURING) goIdle('中断しました');
}

// ---------------------------------------------------------------------------
// マイク
// ---------------------------------------------------------------------------

const mic = new MicMeter({ onSample, onStatus: onMicStatus });

function onSample({ dbfs, peakDbfs, now }) {
  const db = dbfs + settings.offset;
  currentDb = db;
  ui.setDb(db, dbfs);

  if (peakDbfs >= CLIP_DBFS) {
    clipUntil = now + CLIP_HOLD_MS;
    ui.setClip(true);
    if (run) run.clipped = true;
  }

  if (state === S.STANDBY) {
    if (db >= settings.threshold) startMeasuring(now, db); // しきい値を超えた瞬間に開始
  } else if (state === S.MEASURING) {
    pushSample(now, db);
    if (now - run.startAt >= run.duration * 1000) finishMeasuring(); // rAF が止まっても終わらせる
  }
}

function onMicStatus({ status, message, label, fellBack }) {
  if (status === 'running') {
    micOk = true;
    micMessage = '';
    ui.setMicStatus(`マイク: ${label || '既定のデバイス'}`, 'ok');
    if (fellBack) ui.toast('選んだマイクが見つからないため、既定のマイクを使っています', 5000);
  } else if (status === 'suspended') {
    micOk = false;
    micMessage = '画面をクリックするか、何かキーを押すとマイクが始まります';
    ui.setMicStatus('マイク待機中（クリックで開始）', 'warn');
  } else {
    micOk = false;
    currentDb = null;
    micMessage = message || 'マイクが使えません';
    ui.setMicStatus('マイクエラー', 'error');
    ui.setDb(null);
  }
  if (state !== S.RESULT) goIdle(); // 結果表示中は結果を消さない
}

async function refreshDevices() {
  try {
    ui.fillDevices(await listAudioInputs(), settings.deviceId);
  } catch {
    /* 一覧が取れなくても動作には影響しない */
  }
}

async function startMic() {
  ui.setMicStatus('マイク準備中…', 'pending');
  await mic.start(settings.deviceId);
  await refreshDevices(); // 権限取得後でないとデバイス名が取れない
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function openSettings() {
  if (state !== S.IDLE) {
    ui.toast('設定は待機中に開けます（Esc で中断してから）');
    return;
  }
  ui.fillSettings(settings);
  refreshDevices();
  ui.openSettings();
}

function applySettings() {
  const next = store.normalizeSettings(ui.readSettings());
  const deviceChanged = next.deviceId !== settings.deviceId;
  settings = next;
  if (!initialSynced) settingsDirty = true;
  store.saveSettings(settings);
  sync.queueSettings(settings);
  ui.fillSettings(settings); // 範囲外の値を丸めた結果を入力欄に反映
  if (deviceChanged) startMic();
}

function closeSettings() {
  applySettings();
  ui.closeSettings();
  goIdle();
}

// ---------------------------------------------------------------------------
// 操作（CSV・リセット・全画面）
// ---------------------------------------------------------------------------

function exportCsv() {
  if (records.length === 0) {
    ui.toast('出力する記録がありません');
    return;
  }
  const blob = new Blob([store.buildCsv(records)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kitano-decibel_${dateKey}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ui.toast(`CSV を出力しました（${records.length} 件）`);
}

async function resetRecords() {
  if (state !== S.IDLE && state !== S.RESULT) {
    ui.toast('リセットは待機中に行えます');
    return;
  }
  const ok = await ui.confirm({
    title: '本日の記録をリセット',
    message: `本日（${dateKey}）の記録 ${records.length} 件をランキングから外します。PCの data フォルダのファイルには残るので、あとから復旧できます。`,
    okLabel: 'リセットする',
  });
  if (!ok) return;
  setAll(store.markAllDeleted(allRecords));
  persist();
  refreshBoard();
  goIdle('本日の記録をリセットしました');
}

async function discardResult() {
  if (state !== S.RESULT || !lastRecordId) return;
  const ok = await ui.confirm({
    title: 'この記録を破棄',
    message: '今回の記録をランキングから外します（PCのファイルには破棄済みとして残ります）。よろしいですか？',
    okLabel: '破棄する',
  });
  if (!ok) return;
  setAll(store.markDeleted(allRecords, lastRecordId));
  persist();
  refreshBoard();
  goIdle('記録を破棄しました');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
      // 全画面中も Esc をアプリ（中断）に届ける。全画面解除は F キー。
      try {
        await navigator.keyboard?.lock?.(['Escape']);
      } catch {
        /* 非対応ブラウザでは Esc で全画面が解除される */
      }
    }
  } catch {
    ui.toast('全画面にできませんでした');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
});

// ---------------------------------------------------------------------------
// キー・ボタン
// ---------------------------------------------------------------------------

function onSpace() {
  switch (state) {
    case S.IDLE:
      enterStandby();
      break;
    case S.STANDBY:
      startMeasuring(performance.now(), currentDb ?? 0); // 手動で即開始
      break;
    case S.RESULT:
      commitResult();
      enterStandby();
      break;
    default:
      break; // 計測中は無視
  }
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (ui.isModalOpen()) return; // モーダルが自前で処理する
  mic.resume(); // 自動再生ポリシーで止まっていたマイクをユーザー操作で再開

  const target = e.target;
  const inField = target instanceof HTMLElement && target.matches('input, select, textarea');

  if (ui.isSettingsOpen()) {
    if (e.code === 'Escape' || (!inField && e.code === 'KeyS')) {
      e.preventDefault();
      closeSettings();
    }
    return;
  }
  if (e.repeat) return;

  switch (e.code) {
    case 'Escape':
      if (state === S.RESULT) {
        commitResult();
        goIdle();
      } else {
        abort();
      }
      break;
    case 'Space':
      if (inField) return; // 名前入力中のスペースはそのまま入力
      e.preventDefault();
      onSpace();
      break;
    case 'KeyF':
      if (inField) return;
      toggleFullscreen();
      break;
    case 'KeyS':
      if (inField) return;
      openSettings();
      break;
    default:
      break;
  }
});

document.addEventListener('pointerdown', () => mic.resume());

// ボタンにフォーカスが残ると Space で再クリックされるので、クリック後に外す
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (btn) btn.blur();
});

ui.els.btnCsv.addEventListener('click', exportCsv);
ui.els.btnSettings.addEventListener('click', openSettings);
ui.els.btnReset.addEventListener('click', resetRecords);
ui.els.btnSettingsClose.addEventListener('click', closeSettings);
ui.els.btnResultDiscard.addEventListener('click', discardResult);
ui.els.resultForm.addEventListener('submit', (e) => {
  e.preventDefault(); // Enter または「決定」ボタン
  if (state !== S.RESULT) return;
  commitResult();
  goIdle();
});
for (const el of [
  ui.els.setDevice,
  ui.els.setDuration,
  ui.els.setThreshold,
  ui.els.setFloor,
  ui.els.setOffset,
  ui.els.setMethod,
]) {
  el.addEventListener('change', applySettings);
}
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

// ---------------------------------------------------------------------------
// フレームループ（残り時間表示・タイムアウト・クリップ表示解除）
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);

  if (state === S.STANDBY) {
    const left = STANDBY_TIMEOUT_MS - (now - standbyStart);
    if (left <= 0) {
      goIdle('スタンバイが時間切れになりました');
    } else {
      ui.setTimerText(`計測 ${settings.duration} 秒 ／ あと ${Math.ceil(left / 1000)} 秒で待機に戻ります`);
    }
  } else if (state === S.MEASURING) {
    const elapsed = now - run.startAt;
    const total = run.duration * 1000;
    ui.setTimerText(`残り ${Math.max(0, (total - elapsed) / 1000).toFixed(1)} 秒`);
    if (elapsed >= total) finishMeasuring();
  }

  if (clipUntil && now > clipUntil) {
    clipUntil = 0;
    ui.setClip(false);
  }
}

// ---------------------------------------------------------------------------
// 保存サーバーとの同期（PCのファイルに保存）
// ---------------------------------------------------------------------------

const sync = new SyncClient({ onStatus: onSyncStatus, onRecordsMerged });

function onSyncStatus({ online, pending, dataDir }) {
  if (online && !initialSynced) {
    // つながった直後、保存ファイルの設定・記録を読み込み終わるまでは「保存済み」と出さない
    ui.setServerBanner(null);
    ui.setSync('保存ファイルを読み込み中…', 'pending');
  } else if (online) {
    ui.setServerBanner(null);
    ui.setSync(pending ? 'ファイルに保存中…' : 'ファイルに保存済み ✓', pending ? 'pending' : 'ok');
  } else {
    ui.setServerBanner(
      '保存サーバーにつながりません。start.bat の黒いウィンドウが開いているか確認してください（計測は続けられます。つながったら自動で保存します）',
    );
    ui.setSync(pending ? '未保存あり・再送中' : '保存サーバー未接続', 'error');
  }
  ui.setDataDir(dataDir);
}

/** サーバー側でマージされた結果に、こちらに無い記録があれば取り込む。 */
function onRecordsMerged(key, merged) {
  if (key !== dateKey) return;
  const next = mergeRecords(allRecords, merged);
  if (sameRecords(next, allRecords)) return;
  setAll(next);
  store.saveRecords(dateKey, allRecords);
  refreshBoard();
}

/** サーバーにある指定日の記録と突き合わせる。差があればお互いにそろえる。 */
async function pullDay(key) {
  const remote = await sync.loadRecords(key);
  if (key !== dateKey) return;
  const merged = mergeRecords(allRecords, remote);
  if (!sameRecords(merged, allRecords)) {
    setAll(merged);
    store.saveRecords(dateKey, allRecords);
    refreshBoard();
    if (state === S.IDLE) goIdle(); // ゴースト・案内文を読み込んだ記録で更新
  }
  if (!sameRecords(merged, remote)) await sync.queueRecords(key, allRecords);
}

/** 最初につながったとき: 設定と本日の記録をサーバーと突き合わせる。 */
async function initialSync() {
  const remote = await sync.loadSettings();
  if (remote && typeof remote === 'object' && !settingsDirty) {
    // サーバー（ファイル）の設定を優先。ポートやブラウザが変わっても校正値が戻る
    const next = store.normalizeSettings(remote);
    if (JSON.stringify(next) !== JSON.stringify(settings)) {
      const deviceChanged = next.deviceId !== settings.deviceId;
      settings = next;
      store.saveSettings(settings);
      ui.fillSettings(settings);
      if (deviceChanged) startMic();
      if (state === S.IDLE) goIdle();
    }
  } else {
    await sync.queueSettings(settings);
  }
  await pullDay(dateKey);
  initialSynced = true;
  sync.emit(); // 「読み込み中」→「保存済み」に表示を更新
  if (records.length) ui.toast(`保存ファイルから本日の記録 ${records.length} 件を読み込みました`, 3000);
}

async function healthLoop() {
  const h = await sync.health();
  if (h) {
    if (!initialSynced) {
      try {
        await initialSync();
      } catch {
        /* 次の確認で再試行 */
      }
    } else if (sync.pending.size) {
      sync.flush();
    }
  }
  setTimeout(healthLoop, sync.online ? HEALTH_ONLINE_MS : HEALTH_OFFLINE_MS);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

ui.setServerBanner(null); // JS が動いた = start.bat 経由で開けている（file:// 直開きならこの行まで来ない）
ui.setSync('保存サーバー確認中…', 'pending');
ui.fillSettings(settings);
refreshBoard();
goIdle();
requestAnimationFrame(frame);
startMic();
healthLoop();
