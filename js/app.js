// app.js
// 状態遷移とイベント配線。
//   待機(idle) → スタンバイ(standby) → ステージ1(stage1) → [ブースター(booster)] → エンドレス(endless) → 結果(result)
// ゲームのルールは game.js、保存は storage.js / sync.js、音声入力は audio.js、
// 画面は render.js / world.js、音は sound.js、管理者画面は admin.js に任せる。

import { CLIP_DBFS } from './scoring.js';
import * as store from './storage.js';
import { MicMeter, listAudioInputs } from './audio.js';
import { createRenderer } from './render.js';
import { SyncClient, activeRecords, mergeRecords, recordStamp, sameRecords } from './sync.js';
import { RocketRun, altitudeAt, isRankable, landmarksFor, nextLandmark, reachedLandmark } from './game.js';
import { SoundSystem } from './sound.js';
import { createAdmin } from './admin.js';

/** スタンバイ中に反応がなければ待機へ戻るまでの時間（ms）。 */
const STANDBY_TIMEOUT_MS = 15000;
/** スタンバイ直後はしきい値を見ない時間（ms）。スタンバイ音や BGM の消え残りで誤って始まらないように。 */
const ARM_DELAY_MS = 500;
/** クリップ警告を出し続ける時間（ms）。 */
const CLIP_HOLD_MS = 2000;
/** マイクのサンプルがこれ以上来ないときは、時間だけ進める（ms）。 */
const STALL_MS = 250;
/** 保存サーバーの死活確認の間隔（ms）。つながっていない間は短く。 */
const HEALTH_ONLINE_MS = 10000;
const HEALTH_OFFLINE_MS = 5000;

const S = { IDLE: 'idle', STANDBY: 'standby', STAGE1: 'stage1', BOOSTER: 'booster', ENDLESS: 'endless', RESULT: 'result' };
const RUNNING = new Set([S.STAGE1, S.BOOSTER, S.ENDLESS]);

const C = { yellow: '#FFD166', cyan: '#8ED6FF', white: '#FFFFFF', green: '#7CF29C', lilac: '#E2A7FF', pink: '#FF7AE0' };
const fmtKm = (n) => Math.round(n).toLocaleString('ja-JP');

const ui = createRenderer(document);
const sound = new SoundSystem();

let settings = store.loadSettings();
let dateKey = store.localDateKey();
// allRecords: 破棄済み（deleted）・リハーサル・旧形式も含む全記録。保存・同期はこちら。
// records   : ランキング・ゴーストに使う記録だけ（isRankable）。
let allRecords = [];
let records = [];
setAll(store.loadRecords(dateKey));

let state = S.IDLE;
let currentDb = null;
let standbyStart = 0;
let run = null; // RocketRun
let ctx = null; // 1回分の表示用の情報 { ghost, clipped, lastSampleAt, dispAlt, leading, wasBehind, passed }
let lastRecord = null; // 直近の記録（結果画面で名前を付ける対象）
let clipUntil = 0;
let micOk = false;
let micMessage = 'マイクを準備しています…';
let initialSynced = false;
let settingsDirty = false; // 最初の突き合わせ前にこの画面で設定を変えたか（変えていればこちらを優先）
let lastFrame = performance.now();
let snapCamera = true;

// ---------------------------------------------------------------------------
// 記録まわり
// ---------------------------------------------------------------------------

function setAll(next) {
  allRecords = next;
  records = activeRecords(next).filter(isRankable);
}

function refreshBoard(highlightId = null) {
  ui.renderRanking(records, highlightId);
}

/** ブラウザ内の控え。入りきらなければ、1位以外の履歴を省いた軽い形で残す（本体は PC のファイル）。 */
function mirrorLocal() {
  if (store.saveRecords(dateKey, allRecords)) return;
  const best = store.bestRecord(records);
  const compact = allRecords.map((r) => (best && r.id === best.id ? r : { ...r, series: [], alt: [] }));
  store.saveRecords(dateKey, compact);
}

/** 変わった記録を、ブラウザ内（localStorage）と PC のファイル（保存サーバー経由）の両方に保存する。 */
function persist(changed) {
  mirrorLocal();
  sync.queueRecords(dateKey, changed);
}

/** 日付をまたいだら（深夜0時など）、その日の記録に切り替える。計測中・結果表示中は呼ばない。 */
function syncDate() {
  const key = store.localDateKey();
  if (key === dateKey) return;
  dateKey = key;
  setAll(store.loadRecords(dateKey));
  refreshBoard();
  if (sync.online) {
    pullDay(dateKey)
      .then(() => store.pruneOtherDays(dateKey))
      .catch(() => {});
  }
}

/** 今日の1位（ゴースト）。高さの履歴を持つ記録だけ。 */
function ghostRecord() {
  if (!settings.ghost) return null;
  const best = store.bestRecord(records);
  return best && Array.isArray(best.alt) && best.alt.length > 1 ? best : null;
}

// ---------------------------------------------------------------------------
// 見た目の設定を反映
// ---------------------------------------------------------------------------

function applyLook() {
  ui.setTheme(settings.theme);
  ui.setRehearsal(settings.rehearsal);
  ui.setThresholdMark(settings.threshold);
  ui.world.build(settings);
  sound.configure(settings);
}

const placeName = (key) => landmarksFor(settings).find((m) => m.key === key)?.name ?? '';

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

function goIdle(notice = '') {
  syncDate();
  state = S.IDLE;
  run = null;
  ctx = null;
  lastRecord = null;
  ui.hideResult();
  ui.clearEffects();
  ui.setState(S.IDLE);
  ui.setSide('howto', 'あそびかた');
  ui.setTitles({ main: 'メインモニター：ロケット', status: 'マイク チェック' });
  ui.setStageTimer(null);
  ui.setEndlessBadge(false);
  ui.world.resetGoals();
  ui.setGhostOn(Boolean(ghostRecord()));
  snapCamera = true;
  sound.setRunActive(false);
  refreshBoard();
  if (!micOk) ui.setStrip(micMessage, 'error');
  else ui.setStrip(notice || 'つぎの うちゅうひこうし、まってるよ！', notice ? 'yellow' : '');
}

function enterStandby() {
  if (!micOk) {
    ui.toast(micMessage || 'マイクが使えません');
    return;
  }
  syncDate();
  ui.hideResult();
  ui.clearEffects();
  state = S.STANDBY;
  standbyStart = performance.now();
  run = null;
  ctx = null;
  ui.setState(S.STANDBY);
  ui.setSide('db', 'こえパワー（エンジン出力）');
  ui.setTitles({ main: 'メインモニター：ロケット', status: 'スタンバイ' });
  ui.world.resetGoals();
  ui.setGhostOn(Boolean(ghostRecord()));
  snapCamera = true;
  sound.setRunActive(true); // BGM を消す
  sound.se('standby');
  ui.setStrip('こえを だすと はっしゃ！');
}

function startRun(now, db) {
  const ghost = ghostRecord();
  run = new RocketRun(settings);
  ctx = { ghost, clipped: false, lastSampleAt: now, dispAlt: 0, leading: false, wasBehind: false, passed: new Set() };
  state = S.STAGE1;
  ui.setState(S.STAGE1);
  ui.setGhostOn(Boolean(ghost));
  ui.world.setGhostName(ghost ? `チャンピオン ${(ghost.name || 'ななし').slice(0, 8)}` : '');
  ui.setSide('db', 'こえパワー（エンジン出力）');
  ui.setTitles({ main: 'メインモニター：ロケット', status: 'ミッション じょうきょう' });
  ui.setStrip('ステージ1：うちゅうへ むかって いるよ！');
  seRun('launch');
  handleEvents(run.start(now, db));
}

/** 計測中の効果音（マイクに入って dB が上がるので、設定でオンのときだけ）。 */
function seRun(name) {
  if (settings.seDuringRun) sound.se(name);
}

function handleEvents(events) {
  for (const e of events) {
    if (!run) return;
    switch (e.type) {
      case 'goal1':
        ui.world.markGoalDone(1);
        if (!e.boosted) {
          ui.goalCard(1, placeName('space'));
          seRun('goal');
          ui.setStrip('つぎは ★つきを めざせ！', 'green');
        }
        break;
      case 'goal2':
        ui.world.markGoalDone(2);
        break;
      case 'booster':
        state = S.BOOSTER;
        ui.setState(S.BOOSTER);
        ui.boosterPill(2800);
        if (settings.cheerBoost) ui.setSide('cheer', 'おうえん メーター');
        else ui.setSide('warp', 'ブースター');
        ui.setCheer(null);
        ui.setStrip('このあと ∞エンドレスモード！', 'pink');
        sound.se('booster'); // ブースター中の声は記録に入らないので鳴らしてよい
        break;
      case 'endless':
        state = S.ENDLESS;
        ui.setState(S.ENDLESS);
        ui.endlessPill(run.boosted ? '∞ エンドレスモード スタート！' : 'つきに とうちゃく！ ∞エンドレスへ！');
        ui.setEndlessBadge(true);
        ui.setSide('db', 'こえパワー（エンジン出力）');
        ui.setTitles({ main: 'メインモニター：エンドレス' });
        ui.setStrip('こえが とぎれたら おわり！ とびつづけろ！', 'pink');
        seRun('endless');
        break;
      case 'end':
        finishRun();
        return;
      default:
        break;
    }
  }
}

function finishRun() {
  const res = run.result();
  const prevBest = store.bestRecord(records);
  const ts = Date.now();
  const record = {
    id: store.newRecordId(),
    name: '',
    ts,
    updatedAt: ts,
    clipped: ctx.clipped,
    rehearsal: settings.rehearsal,
    // その回の難易度（あとで調整の参考にする）
    cfg: {
      offset: settings.offset,
      floor: settings.floor,
      kmRate: settings.kmRate,
      threshold: settings.threshold,
      goal1Km: settings.goal1Km,
      goal2Km: settings.goal2Km,
      stage1Sec: settings.stage1Sec,
      endlessMaxSec: settings.endlessMaxSec,
      silenceEndSec: settings.silenceEndSec,
      booster: settings.booster,
    },
    ...res,
  };
  const reached = { ...run.reached };
  setAll([...allRecords, record]);
  persist([record]); // 名前を入れる前に先に保存（途中で閉じても記録が残る）
  lastRecord = record;
  run = null;

  const rankable = isRankable(record);
  const isNewRecord = rankable && (!prevBest || record.score > prevBest.score);
  const rank = rankable ? store.rankOf(records, record.id) : 0;
  const place = reachedLandmark(record.score, landmarksFor(settings));

  state = S.RESULT;
  ui.setState(S.RESULT);
  ui.setStageTimer(null);
  ui.setEndlessBadge(false);
  ui.clearEffects();
  sound.setRunActive(false);
  sound.se(isNewRecord ? 'newRecord' : 'result');
  ui.showResult({
    score: record.score,
    place,
    reached,
    boosted: record.boosted,
    beyondMoon: place.km > settings.goal2Km,
    isNewRecord,
  });
  ui.setTitles({ main: isNewRecord ? 'ミッション だいせいこう！！' : 'ミッション せいこう！', status: 'けっか' });
  ui.setCells([
    { k: 'とどいた たかさ', v: `${fmtKm(record.score)} km`, color: C.yellow, size: 56 },
    { k: 'へいきんの こえ', v: Number.isFinite(record.meanDb) ? `${record.meanDb.toFixed(1)} dB` : '--', color: C.cyan, size: 50 },
    { k: 'きょうの じゅんい', v: rankable ? `${rank} い` : 'リハーサル', color: isNewRecord ? C.yellow : C.white, size: rankable ? 56 : 40 },
  ]);
  if (settings.nameInput) {
    ui.setSide('name', 'なまえ にゅうりょく');
    ui.focusName('');
  } else {
    ui.setSide('score', isNewRecord ? 'しんきろく' : 'けっか');
  }
  ui.setStrip(isNewRecord ? '「しんきろく、かくにん！！」' : 'ミッション せいこう！ おつかれさま！', isNewRecord ? 'yellow' : 'green');
  if (isNewRecord) {
    ui.flash();
    ui.confetti();
  }
  refreshBoard(record.id);
}

/** 結果画面を閉じる前に、入力された名前を保存する。 */
function commitResult() {
  if (!lastRecord) return;
  const name = settings.nameInput ? store.normalizeName(ui.getResultName()) : '';
  if (name) {
    setAll(store.renameRecord(allRecords, lastRecord.id, name));
    const renamed = allRecords.find((r) => r.id === lastRecord.id);
    if (renamed) persist([renamed]);
    refreshBoard();
  }
  lastRecord = null;
}

function abortRun() {
  if (state === S.STANDBY || RUNNING.has(state)) {
    sound.se('abort');
    goIdle(state === S.STANDBY ? '' : 'ちゅうだん しました（きろくは のこりません）');
  }
}

async function discardResult() {
  if (state !== S.RESULT || !lastRecord) return;
  const id = lastRecord.id;
  const ok = await ui.confirm({
    title: 'この記録を破棄',
    message: '今回の記録をランキングから外します（PCのファイルには破棄済みとして残ります）。よろしいですか？',
    okLabel: '破棄する',
  });
  if (!ok) {
    if (settings.nameInput) ui.els.resultName.focus();
    return;
  }
  setAll(store.markDeleted(allRecords, id));
  const deleted = allRecords.find((r) => r.id === id);
  if (deleted) persist([deleted]);
  lastRecord = null;
  goIdle('きろくを はき しました');
}

// ---------------------------------------------------------------------------
// マイク
// ---------------------------------------------------------------------------

const mic = new MicMeter({ onSample, onStatus: onMicStatus });

function onSample({ dbfs, peakDbfs, now }) {
  const db = dbfs + settings.offset;
  currentDb = db;
  ui.setDb(db);
  admin.setLive(dbfs);

  if (peakDbfs >= CLIP_DBFS) {
    clipUntil = now + CLIP_HOLD_MS;
    ui.setClip(true);
    if (ctx) ctx.clipped = true;
  }

  if (state === S.STANDBY) {
    if (now - standbyStart >= ARM_DELAY_MS && db >= settings.threshold) startRun(now, db); // しきい値を超えた瞬間に開始
  } else if (run && RUNNING.has(state)) {
    ctx.lastSampleAt = now;
    if (state === S.BOOSTER) ui.setCheer(db);
    handleEvents(run.update(now, db));
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
  if (state !== S.RESULT && !admin.isOpen()) goIdle(); // 結果表示中は結果を消さない
}

async function refreshDevices() {
  try {
    admin.setInfo({ devices: await listAudioInputs() });
  } catch {
    /* 一覧が取れなくても動作には影響しない */
  }
}

async function startMic() {
  ui.setMicStatus('マイク準備中…', 'pending');
  await mic.start(settings.deviceId);
  if (admin.isOpen()) await refreshDevices(); // 権限取得後でないとデバイス名が取れない
}

// ---------------------------------------------------------------------------
// 管理者画面
// ---------------------------------------------------------------------------

const admin = createAdmin(ui.els.admin, {
  onSave: saveAdmin,
  onCancel: closeAdmin,
  onCsv: exportCsv,
  onReset: resetRecords,
  onTestSe: (name) => {
    sound.unlock();
    if (!sound.se(name)) ui.toast('効果音がオフか、まだ鳴らせません');
  },
  onNextBgm: () => {
    sound.unlock();
    if (!sound.files.length) ui.toast('sound フォルダに音楽ファイルがありません');
    else if (!settings.bgm) ui.toast('BGM がオフです（オンにして保存すると流れます）');
    else sound.next();
  },
});

async function requestAdmin() {
  if (admin.isOpen() || ui.isModalOpen()) return;
  if (state === S.STANDBY || RUNNING.has(state)) {
    ui.toast('計測中は開けません（Esc で中断してから）');
    return;
  }
  if (state === S.RESULT) {
    commitResult();
    goIdle();
  }
  const ok = await ui.askPin(settings.adminPin);
  if (!ok || state !== S.IDLE) return;
  admin.open(settings, {
    dataDir: sync.dataDir,
    syncText: syncText(),
    recordCount: records.length,
    sounds: sound.files,
  });
  refreshDevices();
  sound.loadPlaylist().then((files) => admin.setInfo({ sounds: files }));
}

function saveAdmin(raw) {
  const next = store.normalizeSettings({ ...settings, ...raw });
  const deviceChanged = next.deviceId !== settings.deviceId;
  const pinChanged = next.adminPin !== settings.adminPin;
  settings = next;
  if (!initialSynced) settingsDirty = true;
  store.saveSettings(settings);
  sync.queueSettings(settings);
  admin.close();
  applyLook();
  if (deviceChanged) startMic();
  goIdle();
  ui.toast(pinChanged ? '設定を保存しました（暗証番号を変更しました）' : '設定を保存しました');
}

function closeAdmin() {
  admin.close();
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
  const ok = await ui.confirm({
    title: '本日の記録をリセット',
    message: `本日（${dateKey}）の記録 ${records.length} 件をランキングから外します。PCの data フォルダのファイルには残るので、あとから復旧できます。`,
    okLabel: 'リセットする',
  });
  if (!ok) return;
  const before = new Set(allRecords.filter((r) => !r.deleted).map((r) => r.id));
  setAll(store.markAllDeleted(allRecords));
  persist(allRecords.filter((r) => before.has(r.id)));
  refreshBoard();
  admin.setInfo({ recordCount: records.length });
  ui.toast('本日の記録をリセットしました');
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
      startRun(performance.now(), currentDb ?? settings.threshold); // 手動で即開始
      break;
    case S.RESULT:
      commitResult();
      enterStandby();
      break;
    default:
      break; // 計測中は無視
  }
}

function backToIdleFromResult() {
  commitResult();
  goIdle();
}

document.addEventListener('keydown', (e) => {
  sound.unlock();
  mic.resume(); // 自動再生ポリシーで止まっていたマイクをユーザー操作で再開
  if (ui.isModalOpen()) return; // ダイアログが自前で処理する

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyA') {
    e.preventDefault();
    requestAdmin();
    return;
  }
  if (admin.isOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAdmin();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中

  const nameField = ui.els.resultName;
  if (state === S.RESULT && e.target === nameField) {
    if (e.key === 'Enter') {
      e.preventDefault();
      backToIdleFromResult();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      nameField.value = '';
      backToIdleFromResult();
    } else if (nameField.value === '' && e.code === 'Space') {
      e.preventDefault(); // 名前が空なら Space で次の人へ
      onSpace();
    } else if (nameField.value === '' && e.key === 'Delete') {
      e.preventDefault();
      discardResult();
    }
    return; // それ以外は名前の入力
  }
  if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;
  if (e.repeat) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      onSpace();
      break;
    case 'Escape':
      if (state === S.RESULT) backToIdleFromResult();
      else abortRun();
      break;
    case 'Enter':
    case 'NumpadEnter':
      if (state === S.RESULT) backToIdleFromResult();
      break;
    case 'Delete':
      if (state === S.RESULT) discardResult();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    default:
      break;
  }
});

document.addEventListener('pointerdown', () => {
  sound.unlock();
  mic.resume();
});

// ボタンにフォーカスが残ると Space で再クリックされるので、クリック後に外す
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (btn) btn.blur();
});

ui.els.btnAdmin.addEventListener('click', requestAdmin);
ui.els.btnDiscard.addEventListener('click', discardResult);
window.addEventListener('resize', () => ui.fit());
navigator.mediaDevices?.addEventListener?.('devicechange', () => admin.isOpen() && refreshDevices());

// ---------------------------------------------------------------------------
// フレームループ（ロケットの位置・残り時間・状況表示）
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (state === S.STANDBY) {
    const left = STANDBY_TIMEOUT_MS - (now - standbyStart);
    if (left <= 0) {
      goIdle('スタンバイが じかんぎれに なりました');
    } else {
      ui.setCells([
        { k: 'いまの こえ', v: currentDb === null ? '--' : `${currentDb.toFixed(1)} dB`, color: C.cyan, size: 52 },
        { k: 'はっしゃ する こえ', v: `${settings.threshold} dB いじょう`, color: C.yellow, size: 40 },
        { k: 'たいきに もどるまで', v: `${Math.ceil(left / 1000)} びょう`, color: C.white, size: 44 },
      ]);
    }
  }

  if (run && RUNNING.has(state)) {
    // マイクのサンプルが途切れても（タブの一時停止など）時間は進める
    if (now - ctx.lastSampleAt > STALL_MS) {
      handleEvents(run.update(now, null));
    }
  }

  if (run && RUNNING.has(state)) {
    ctx.dispAlt += (run.alt - ctx.dispAlt) * (1 - Math.exp(-dt / 0.08));
    const alt = ctx.dispAlt;
    const ghostAlt = ctx.ghost ? altitudeAt(ctx.ghost.alt, now - run.t0) : null;
    const thrust = currentDb === null ? 0.3 : Math.min(1.6, Math.max(0.25, (currentDb - settings.floor) / 30));
    ui.world.update({ alt, ghostAlt, thrust, dt, snap: snapCamera });
    snapCamera = false;
    trackMoments(alt, ghostAlt);
    renderRunStatus(now, alt, ghostAlt);
  } else if (state === S.IDLE || state === S.STANDBY) {
    ui.world.update({ alt: 0, ghostAlt: null, thrust: 0.3, dt, snap: snapCamera });
    snapCamera = false;
    if (state === S.IDLE) {
      const best = store.bestRecord(records);
      ui.setCells([
        { k: 'いまの こえ', v: !micOk || currentDb === null ? '--' : `${currentDb.toFixed(1)} dB`, color: C.cyan, size: 56 },
        { k: 'もくひょう', v: 'うちゅう・つき', color: C.yellow, size: 40 },
        best ? { k: 'きょうの チャンピオン', v: `${fmtKm(best.score)} km`, color: C.lilac, size: 44 } : null,
      ]);
    }
  }

  if (clipUntil && now > clipUntil) {
    clipUntil = 0;
    ui.setClip(false);
  }
}

/** チャンピオンを抜いた・星を通りすぎた、の演出。 */
function trackMoments(alt, ghostAlt) {
  if (ghostAlt !== null) {
    if (alt < ghostAlt - 3) ctx.wasBehind = true;
    const leading = alt > ghostAlt + 3;
    if (leading && !ctx.leading && ctx.wasBehind) {
      ui.pop('チャンピオンを ぬいた！', 'lead');
      seRun('pass');
    }
    if (leading || alt < ghostAlt - 3) ctx.leading = leading;
  }
  if (state === S.ENDLESS) {
    for (const m of landmarksFor(settings)) {
      if (m.km > settings.goal2Km && alt >= m.km && !ctx.passed.has(m.key)) {
        ctx.passed.add(m.key);
        ui.pop(`${m.name} つうか！`);
        seRun('pass');
      }
    }
  }
}

function renderRunStatus(now, alt, ghostAlt) {
  const marks = landmarksFor(settings);
  if (state === S.STAGE1) {
    const left = run.stageLeft(now) ?? 0;
    ui.setStageTimer(left / settings.stage1Sec, `のこり ${left.toFixed(1)} びょう`);
    const target = run.reached.goal1 ? settings.goal2Km : settings.goal1Km;
    const targetName = run.reached.goal1 ? placeName('moon') : placeName('space');
    ui.setCells([
      { k: 'のこり', v: `${left.toFixed(1)} びょう`, color: C.cyan, size: 50 },
      { k: 'たかさ', v: `${fmtKm(alt)} km`, color: C.white, size: 52 },
      { k: `${targetName} まで`, v: `あと ${fmtKm(Math.max(0, target - alt))} km`, color: C.yellow, size: 46 },
    ]);
  } else if (state === S.BOOSTER) {
    ui.setStageTimer(null);
    ui.setCells([
      { k: placeName('space'), v: 'クリア ✓', color: C.green, size: 46 },
      { k: placeName('moon'), v: 'ワープちゅう', color: C.yellow, size: 46 },
      { k: 'たかさ', v: `${fmtKm(alt)} km`, color: C.white, size: 46 },
    ]);
  } else if (state === S.ENDLESS) {
    const el = run.endlessElapsed(now) ?? 0;
    const left = Math.max(0, settings.endlessMaxSec - el);
    ui.setStageTimer(left / settings.endlessMaxSec, `のこり ${left.toFixed(1)} びょう`);
    let second;
    if (ghostAlt !== null && ctx.ghost) {
      const finalGhost = ctx.ghost.score;
      second = alt > finalGhost
        ? { k: 'チャンピオン', v: 'ぬいた！', color: C.yellow, size: 50 }
        : { k: 'チャンピオンまで', v: `あと ${fmtKm(finalGhost - alt)} km`, color: C.lilac, size: 44 };
    } else {
      const next = nextLandmark(alt, marks);
      second = next
        ? { k: `${next.name} まで`, v: `あと ${fmtKm(next.km - alt)} km`, color: C.lilac, size: 44 }
        : { k: 'つぎの ほし', v: 'どこまでも！', color: C.lilac, size: 44 };
    }
    ui.setCells([
      { k: 'たかさ', v: `${fmtKm(alt)} km`, color: C.white, size: 54 },
      second,
      { k: 'のこり', v: `${left.toFixed(1)} びょう`, color: C.cyan, size: 44 },
    ]);
  }
}

// ---------------------------------------------------------------------------
// 保存サーバーとの同期（PCのファイルに保存）
// ---------------------------------------------------------------------------

const sync = new SyncClient({ onStatus: onSyncStatus, onRecordsMerged });

function syncText() {
  if (!sync.online) return sync.pending.size ? '未保存あり・再送中' : '保存サーバー未接続';
  if (!initialSynced) return '保存ファイルを読み込み中…';
  return sync.pending.size ? 'ファイルに保存中…' : 'ファイルに保存済み ✓';
}

function onSyncStatus({ online, pending, dataDir }) {
  if (online && !initialSynced) {
    // つながった直後、保存ファイルの設定・記録を読み込み終わるまでは「保存済み」と出さない
    ui.setServerBanner(null);
    ui.setSync(syncText(), 'pending');
  } else if (online) {
    ui.setServerBanner(null);
    ui.setSync(syncText(), pending ? 'pending' : 'ok');
  } else {
    ui.setServerBanner(
      '保存サーバーにつながりません。start.bat の黒いウィンドウが開いているか確認してください（ゲームは続けられます。つながったら自動で保存します）',
    );
    ui.setSync(syncText(), 'error');
  }
  admin.setInfo({ dataDir, syncText: syncText() });
}

/**
 * サーバー側でマージされた結果（その日のファイルの全件）を受け取ったとき:
 *  ・こちらに無い記録があれば取り込む（別の画面で記録したものなど）
 *  ・ファイル側に無い／古い記録があれば送り直す（ファイルが壊れて作り直された場合など）
 */
function onRecordsMerged(key, merged) {
  if (key !== dateKey) return;
  const onFile = new Map(merged.map((r) => [r.id, recordStamp(r)]));
  const missing = allRecords.filter((r) => !onFile.has(r.id) || onFile.get(r.id) < recordStamp(r));
  if (missing.length) sync.queueRecords(key, missing);
  const next = mergeRecords(allRecords, merged);
  if (sameRecords(next, allRecords)) return;
  setAll(next);
  mirrorLocal();
  refreshBoard(state === S.RESULT ? lastRecord?.id : null);
}

/** サーバーにある指定日の記録と突き合わせる。差があればお互いにそろえる。 */
async function pullDay(key) {
  const remote = await sync.loadRecords(key);
  if (key !== dateKey) return;
  const merged = mergeRecords(allRecords, remote);
  if (!sameRecords(merged, allRecords)) {
    setAll(merged);
    mirrorLocal();
    refreshBoard(state === S.RESULT ? lastRecord?.id : null);
    if (state === S.IDLE) ui.setGhostOn(Boolean(ghostRecord()));
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
      applyLook();
      if (deviceChanged) startMic();
      if (state === S.IDLE) goIdle();
    }
  } else {
    await sync.queueSettings(settings);
  }
  await pullDay(dateKey);
  initialSynced = true;
  store.pruneOtherDays(dateKey); // ファイル側に保存済みなので、ブラウザの控えは当日分だけ残す
  sync.emit(); // 「読み込み中」→「保存済み」に表示を更新
  sound.loadPlaylist();
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
ui.fit();
applyLook();
goIdle();
requestAnimationFrame(frame);
startMic();
healthLoop();

// テスト（tests/e2e_scenarios.py）から状態を読むための窓口。ゲームの動きには関係しない。
window.__kitano = {
  get state() {
    return state;
  },
  get alt() {
    return run ? run.alt : null;
  },
  get settings() {
    return settings;
  },
  get records() {
    return allRecords;
  },
  get bgm() {
    return { playing: sound.bgmPlaying, files: sound.files, runActive: sound.runActive };
  },
};
