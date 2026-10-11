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
import { RocketRun, altitudeAt, averageSeries, isRankable, landmarksFor, nextLandmark, reachedLandmark } from './game.js';
import { SoundSystem } from './sound.js';
import { createAdmin } from './admin.js';
import { LobbyClient } from './lobby.js';

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

/** へいきんゴーストに使うには、何人分の記録が要るか。 */
const AVG_MIN_RECORDS = 3;
const avgCache = new Map(); // 部門 → 平均の高さの履歴（記録が変わったら作り直す）

const C = { yellow: '#FFD166', cyan: '#8ED6FF', white: '#FFFFFF', green: '#7CF29C', lilac: '#E2A7FF', pink: '#FF7AE0' };
const fmtKm = (n) => Math.round(n).toLocaleString('ja-JP');

const ui = createRenderer(document);
{
  const setState = ui.setState;
  ui.setState = (st) => {
    setState(st);
    pushStatusSoon(); // スマホにすぐ知らせる
  };
}
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
let player = null; // いま飛んでいる（スタンバイ中の）人 { name, division, queueId }
let heldPlayer = null; // 中断で戻ってきた人（次の Space でもう一度）
let nextDivision = ''; // 受付に登録していない人の部門（待機中に 1/2/3 キーで選ぶ）
let celebrated = false; // この結果で「しんきろく」の演出をもうしたか
let askName = false; // この結果で名前を聞いているか（名前入力オフ・スマホで登録済みなら聞かない）
let phoneInfo = { lan: false, urls: [], key: '' };
const lobby = new LobbyClient({ onChange: (lb) => onLobbyChange(lb), onCommands: (cmds) => cmds.forEach(onRemoteCommand) });

// ---------------------------------------------------------------------------
// 記録まわり
// ---------------------------------------------------------------------------

function setAll(next) {
  allRecords = next;
  records = activeRecords(next).filter(isRankable);
  avgCache.clear();
}

/** いま注目している部門（結果画面ならその記録、それ以外は次に飛ぶ人）。 */
function activeDivision() {
  if (state === S.RESULT && lastRecord) return lastRecord.division || '';
  return player?.division || nextPlayer()?.division || '';
}

function refreshBoard(highlightId = null) {
  ui.renderRanking(records, highlightId, { divisions: settings.divisions, active: activeDivision() });
}

/** 比べる相手のグループ（部門わけがオンで部門が決まっていればその部門、それ以外は全員）。 */
function groupOf(division) {
  return settings.divisions && division ? store.inDivision(records, division) : records;
}

/** ブラウザ内の控え。入りきらなければ、1位以外の履歴を省いた軽い形で残す（本体は PC のファイル）。 */
function mirrorLocal() {
  if (store.saveRecords(dateKey, allRecords)) return;
  const keep = new Set(['', ...store.DIVISIONS.map((d) => d.key)].map((d) => store.bestRecord(store.inDivision(records, d))?.id));
  keep.add(store.bestRecord(records)?.id);
  const compact = allRecords.map((r) => (keep.has(r.id) ? r : { ...r, series: [], alt: [] }));
  store.saveRecords(dateKey, compact);
}

/** 変わった記録を、ブラウザ内（localStorage）と PC のファイル（保存サーバー経由）の両方に保存する。 */
function persist(changed) {
  mirrorLocal();
  sync.queueRecords(dateKey, changed);
}

/** 1件の記録を書き換えて保存（名前・部門）。書き換えた記録を返す。 */
function updateRecord(id, patch, stamp = Date.now()) {
  let changed = null;
  setAll(
    allRecords.map((r) => {
      if (r.id !== id) return r;
      changed = { ...r, ...patch, updatedAt: stamp };
      return changed;
    }),
  );
  if (changed) persist([changed]);
  if (lastRecord && lastRecord.id === id && changed) lastRecord = changed;
  return changed;
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


/**
 * その部門のゴースト（チャンピオン＝1位、へいきん＝みんなの平均の飛び方）。
 * 部門わけがオフ、または部門が決まっていない人は全員の中で比べる。
 */
function ghostsFor(division) {
  const group = groupOf(division).filter((r) => Array.isArray(r.alt) && r.alt.length > 1);
  const champ = settings.ghost ? store.bestRecord(group) : null;
  let avg = null;
  if (settings.ghostAvg && group.length >= AVG_MIN_RECORDS) {
    const key = settings.divisions ? division || '*' : '*';
    if (!avgCache.has(key)) avgCache.set(key, averageSeries(group.map((r) => r.alt)));
    avg = avgCache.get(key);
  }
  return { champ, avg };
}

// ---------------------------------------------------------------------------
// 受付（スマホの順番待ち）
// ---------------------------------------------------------------------------

/** 次に飛ぶ人（中断で戻ってきた人 → 順番待ちの先頭 → 部門だけ選んだ人）。 */
function nextPlayer() {
  if (heldPlayer) return heldPlayer;
  const head = lobby.queue[0];
  if (head) return { name: head.name || '', division: store.normalizeDivision(head.division), queueId: head.id };
  if (nextDivision) return { name: '', division: nextDivision, queueId: null };
  return null;
}

function playerLabel(p) {
  if (!p) return '';
  const dv = settings.divisions && p.division ? `（${store.divisionName(p.division, true)}）` : '';
  return `${p.name || 'ななし'} さん${dv}`;
}

/** 待機中の右上（順番待ちがあればリスト、なければあそびかた）と卓の案内。 */
function renderIdleSide(notice = '') {
  if (state !== S.IDLE) return;
  const queue = heldPlayer ? [{ id: 'held', name: heldPlayer.name, division: heldPlayer.division }, ...lobby.queue] : lobby.queue;
  if (queue.length) {
    ui.renderQueue(queue);
    ui.setSide('queue', `じゅんばん まち（${queue.length} にん）`);
  } else {
    ui.setSide('howto', 'あそびかた');
  }
  if (!micOk) {
    ui.setStrip(micMessage, 'error');
    return;
  }
  const np = nextPlayer();
  if (notice) ui.setStrip(notice, 'yellow');
  else if (np && (np.name || np.division)) ui.setStrip(`つぎは ${playerLabel(np)} の ばん！`, 'green');
  else ui.setStrip('つぎの うちゅうひこうし、まってるよ！');
}

/** 結果を受付（スマホ）に見せる形。 */
function lobbyEntry(r) {
  return { recordId: r.id, score: r.score, reached: r.reached, name: r.name || '', division: r.division || '', ts: r.ts, updatedAt: r.updatedAt };
}

/** 受付の内容が変わったとき（スマホで登録・取り消し・後から名前）。 */
function onLobbyChange(lb) {
  // スマホで付けた名前・部門を記録に反映（新しい方が勝つ）
  for (const e of lb.recent) {
    const rec = allRecords.find((r) => r.id === e.recordId);
    if (!rec || rec.deleted || !(e.updatedAt > (rec.updatedAt ?? 0))) continue;
    const name = store.normalizeName(e.name);
    const division = store.normalizeDivision(e.division);
    if (name === (rec.name || '') && division === (rec.division || '')) continue;
    updateRecord(rec.id, { name, division }, e.updatedAt);
    if (state === S.RESULT && lastRecord?.id === rec.id) {
      if (ui.els.resultName.value !== name) ui.els.resultName.value = name;
      showResultRank();
    } else {
      refreshBoard();
    }
    ui.toast(`スマホから: ${name || 'ななし'}${division ? `（${store.divisionName(division, true)}）` : ''} を とうろく`, 2500);
  }
  if (state === S.IDLE) {
    renderIdleSide();
    refreshBoard();
  }
  admin.setInfo({ queueCount: lb.queue.length });
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
// スマホからの操作（スタンバイ・スタート・中断・結果を閉じる・設定）と、スマホに見せる PC の様子
// ---------------------------------------------------------------------------

/** スマホの操作は、送ってから時間がたったものは実行しない（PC が止まっていて、あとからまとめて届いたとき用）。 */
const REMOTE_MAX_AGE_MS = 15000;
/** スマホにも見せてよい設定（暗証番号・マイクの選択は見せない・変えさせない）。 */
const REMOTE_SETTING_KEYS = Object.keys(store.DEFAULT_SETTINGS).filter((k) => k !== 'adminPin' && k !== 'deviceId');

function remoteStatus() {
  const np = nextPlayer();
  const cur = state === S.RESULT ? lastRecord : null;
  return {
    state,
    player: player ? { name: player.name || '', division: player.division || '' } : null,
    next: np ? { name: np.name || '', division: np.division || '' } : null,
    result: cur ? { id: cur.id, score: cur.score, name: cur.name || '', division: cur.division || '', reached: cur.reached } : null,
    db: currentDb === null ? null : Math.round(currentDb * 10) / 10,
    micOk,
    busy: admin.isOpen() || ui.isModalOpen(), // PC で管理者画面・確認を開いている間は操作できない
    settings: Object.fromEntries(REMOTE_SETTING_KEYS.map((k) => [k, settings[k]])),
  };
}

let statusTimer = null;
function pushStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => lobby.pushStatus(remoteStatus()), 50);
}

function onRemoteCommand(c) {
  if (!c || Date.now() - (c.ts ?? 0) > REMOTE_MAX_AGE_MS) return;
  if (c.cmd === 'settings') {
    applyRemoteSettings(c.settings);
    return;
  }
  if (admin.isOpen() || ui.isModalOpen()) {
    ui.toast('スマホの操作: PC で管理者画面などを開いているので、閉じてからもう一度');
    return;
  }
  sound.unlock();
  mic.resume();
  switch (c.cmd) {
    case 'standby':
      if (state === S.IDLE) enterStandby();
      else if (state === S.RESULT) {
        commitResult();
        enterStandby();
      }
      break;
    case 'start':
      // スタンバイ中だけ。スマホの表示が古くて待機中に届いたときは、まずスタンバイにする（いきなり飛ばない）
      if (state === S.STANDBY) startRun(performance.now(), currentDb ?? settings.threshold);
      else if (state === S.IDLE) enterStandby();
      break;
    case 'abort':
      abortRun();
      break;
    case 'close':
      if (state === S.RESULT) backToIdleFromResult();
      break;
    default:
      break;
  }
  pushStatusSoon();
}

/** スマホの管理者画面から来た設定（暗証番号はサーバーで確認済み）。飛んでいる最中の回には影響しない。 */
function applyRemoteSettings(patch) {
  if (!patch || typeof patch !== 'object') return;
  const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => REMOTE_SETTING_KEYS.includes(k)));
  const next = store.normalizeSettings({ ...settings, ...allowed, adminPin: settings.adminPin, deviceId: settings.deviceId });
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  settings = next;
  if (!initialSynced) settingsDirty = true;
  store.saveSettings(settings);
  sync.queueSettings(settings);
  applyLook();
  if (admin.isOpen()) admin.open(settings); // PC で開いていれば表示をそろえる
  if (state === S.IDLE) goIdle();
  else refreshBoard(state === S.RESULT ? lastRecord?.id : null);
  ui.toast('スマホから設定を変更しました');
  pushStatusSoon();
}

// ---------------------------------------------------------------------------
// 状態遷移
// ---------------------------------------------------------------------------

function goIdle(notice = '') {
  syncDate();
  state = S.IDLE;
  run = null;
  ctx = null;
  lastRecord = null;
  player = null;
  ui.hideResult();
  ui.clearEffects();
  ui.setState(S.IDLE);
  ui.setTitles({ main: 'メインモニター：ロケット', status: 'マイク チェック' });
  ui.setStageTimer(null);
  ui.setEndlessBadge(false);
  ui.setSpeed(null);
  ui.world.resetGoals();
  snapCamera = true;
  sound.setRunActive(false);
  refreshBoard();
  renderIdleSide(notice);
}

function enterStandby() {
  if (!micOk) {
    ui.toast(micMessage || 'マイクが使えません');
    return;
  }
  syncDate();
  ui.hideResult();
  ui.clearEffects();
  // 次の人を決める（順番待ちから呼んだら、リストから外す）
  player = nextPlayer() ?? { name: '', division: '', queueId: null };
  heldPlayer = null;
  nextDivision = '';
  if (player.queueId) lobby.remove(player.queueId);
  state = S.STANDBY;
  standbyStart = performance.now();
  run = null;
  ctx = null;
  ui.setState(S.STANDBY);
  ui.setSide('db', 'こえパワー（エンジン出力）');
  ui.setTitles({ main: player.name ? `メインモニター：${player.name} さん` : 'メインモニター：ロケット', status: 'スタンバイ' });
  ui.world.resetGoals();
  snapCamera = true;
  sound.setRunActive(true); // BGM を消す
  sound.se('standby');
  ui.setStrip(player.name ? `${player.name} さん、こえを だすと はっしゃ！` : 'こえを だすと はっしゃ！');
  refreshBoard();
}

function startRun(now, db) {
  const ghosts = ghostsFor(player?.division || '');
  run = new RocketRun(settings);
  ctx = { ghosts, clipped: false, lastSampleAt: now, dispAlt: 0, speed: 0, leading: false, wasBehind: false, avgLeading: false, avgBehind: false, passed: new Set() };
  state = S.STAGE1;
  ui.setState(S.STAGE1);
  const dv = settings.divisions && player?.division ? store.divisionName(player.division, true) : '';
  ui.world.setGhostNames({
    champ: ghosts.champ ? `${dv ? `${dv} ` : ''}1い ${(ghosts.champ.name || 'ななし').slice(0, 6)}` : 'チャンピオン',
    avg: dv ? `${dv} へいきん` : 'みんなの へいきん',
  });
  ui.setSide('db', 'こえパワー（エンジン出力）');
  ui.setTitles({ status: 'ミッション じょうきょう' });
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

/** 記録がそのグループ（部門）で何位か・しんきろくか。部門わけがオンで部門が未定なら pending。 */
function rankInfo(rec) {
  if (!isRankable(rec)) return { rankable: false };
  if (settings.divisions && !rec.division) return { rankable: true, pending: true };
  const group = groupOf(rec.division);
  const others = group.filter((r) => r.id !== rec.id);
  const prevBest = store.bestRecord(others);
  return {
    rankable: true,
    pending: false,
    rank: store.rankOf(group, rec.id),
    isNew: !prevBest || rec.score > prevBest.score,
  };
}

/** 結果画面の順位・しんきろく・部門ボタンを、いまの記録の内容で表示し直す。 */
function showResultRank() {
  if (state !== S.RESULT || !lastRecord) return;
  const info = rankInfo(lastRecord);
  let v;
  let k = 'きょうの じゅんい';
  if (!info.rankable) v = 'リハーサル';
  else if (info.pending) v = 'ぶもんは？';
  else {
    v = `${info.rank} い`;
    if (settings.divisions) k = `${store.divisionName(lastRecord.division, true)}の じゅんい`;
  }
  ui.setCells([
    { k: 'とどいた たかさ', v: `${fmtKm(lastRecord.score)} km`, color: C.yellow, size: 56 },
    { k: 'へいきんの こえ', v: Number.isFinite(lastRecord.meanDb) ? `${lastRecord.meanDb.toFixed(1)} dB` : '--', color: C.cyan, size: 50 },
    { k, v, color: info.isNew ? C.yellow : C.white, size: !info.rankable || info.pending ? 40 : 56 },
  ]);
  ui.setDivisionButtons(lastRecord.division || '', { visible: settings.divisions, need: Boolean(info.pending) });
  if (info.isNew && !celebrated) {
    celebrated = true;
    ui.celebrate();
    ui.setTitles({ main: 'ミッション だいせいこう！！' });
    ui.setStrip('「しんきろく、かくにん！！」', 'yellow');
    if (!askName) ui.setSide('score', lastRecord.name ? `${lastRecord.name} さん しんきろく！` : 'しんきろく');
    sound.se('newRecord');
  }
  refreshBoard(lastRecord.id);
}

function finishRun() {
  const res = run.result();
  const ts = Date.now();
  const record = {
    id: store.newRecordId(),
    name: store.normalizeName(player?.name),
    division: store.normalizeDivision(player?.division),
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
  lobby.pushResult(lobbyEntry(record)); // スマホからも名前・部門を付けられるように
  lastRecord = record;
  celebrated = false;
  run = null;

  const info = rankInfo(record);
  const place = reachedLandmark(record.score, landmarksFor(settings));

  state = S.RESULT;
  ui.setState(S.RESULT);
  ui.setStageTimer(null);
  ui.setEndlessBadge(false);
  ui.setSpeed(null);
  ui.clearEffects();
  sound.setRunActive(false);
  if (!info.isNew) sound.se('result');
  ui.showResult({
    score: record.score,
    place,
    reached,
    boosted: record.boosted,
    beyondMoon: place.km > settings.goal2Km,
    isNewRecord: false,
  });
  ui.setTitles({ main: 'ミッション せいこう！', status: 'けっか' });
  // 名前を聞くのは、名前入力がオンで、まだ名前が無いとき（スマホ受付で登録済みならとばす）
  askName = settings.nameInput && !record.name;
  if (askName) {
    ui.setSide('name', 'なまえ にゅうりょく');
    ui.focusName(record.name);
  } else {
    ui.setSide('score', record.name ? `${record.name} さんの けっか` : 'けっか');
  }
  ui.setStrip(record.name ? `${record.name} さん、ミッション せいこう！` : 'ミッション せいこう！ おつかれさま！', 'green');
  showResultRank(); // 順位・しんきろく（部門が決まっていれば）
}

/** 結果画面で部門を選んだ（PC のボタン・1/2/3 キー）。 */
function setResultDivision(division) {
  if (state !== S.RESULT || !lastRecord || !settings.divisions) return;
  const d = store.normalizeDivision(division);
  if (d === (lastRecord.division || '')) return;
  const rec = updateRecord(lastRecord.id, { division: d });
  if (rec) lobby.pushResult(lobbyEntry(rec));
  showResultRank();
}

/** 結果画面を閉じる前に、入力された名前を保存する。 */
function commitResult() {
  if (!lastRecord) return;
  const name = askName ? store.normalizeName(ui.getResultName()) : lastRecord.name || '';
  if (name !== (lastRecord.name || '')) {
    const rec = updateRecord(lastRecord.id, { name });
    if (rec) lobby.pushResult(lobbyEntry(rec));
    refreshBoard();
  }
  lastRecord = null;
}

function abortRun() {
  if (state === S.STANDBY || RUNNING.has(state)) {
    sound.se('abort');
    // 呼んだ人は順番待ちの先頭に戻す（もう一度 Space で同じ人から）
    if (player && (player.name || player.division)) heldPlayer = player;
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
    if (askName) ui.els.resultName.focus();
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
  onClearQueue: async () => {
    const ok = await ui.confirm({
      title: '順番待ちを全部けす',
      message: `順番待ち ${lobby.queue.length} 人を全部消します。よろしいですか？`,
      okLabel: '全部けす',
    });
    if (!ok) return;
    heldPlayer = null;
    try {
      await lobby.clear();
      ui.toast('順番待ちを消しました');
    } catch {
      ui.toast('消せませんでした（保存サーバーを確認）');
    }
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
    phone: phoneInfo,
    queueCount: lobby.queue.length,
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

  // 部門: 結果画面では 1〜4 でその記録の部門、待機中は次の人（受付していない人）の部門
  const digit = { Digit1: 'k', Numpad1: 'k', Digit2: 'low', Numpad2: 'low', Digit3: 'high', Numpad3: 'high', Digit4: 'adult', Numpad4: 'adult' }[e.code];
  if (digit && settings.divisions && state === S.RESULT) {
    e.preventDefault();
    setResultDivision(digit);
    return;
  }
  if (digit && settings.divisions && state === S.IDLE && !(e.target instanceof HTMLElement && e.target.matches('input, select, textarea'))) {
    if (heldPlayer) heldPlayer = { ...heldPlayer, division: digit };
    else nextDivision = digit;
    renderIdleSide();
    refreshBoard();
    return;
  }

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
ui.els.divButtons.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button[data-div]') : null;
  if (b) setResultDivision(b.dataset.div);
  if (askName && state === S.RESULT) ui.els.resultName.focus();
});
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
    const before = ctx.dispAlt;
    ctx.dispAlt += (run.alt - ctx.dispAlt) * (1 - Math.exp(-dt / 0.08));
    // いきおい（km/秒）。表示がちらつかないよう少しならす
    if (dt > 0) ctx.speed += ((ctx.dispAlt - before) / dt - ctx.speed) * Math.min(1, dt / 0.3);
    ui.setSpeed(ctx.speed);
    const alt = ctx.dispAlt;
    const t = now - run.t0;
    const g = {
      champ: ctx.ghosts.champ ? altitudeAt(ctx.ghosts.champ.alt, t) : null,
      avg: ctx.ghosts.avg ? altitudeAt(ctx.ghosts.avg, t) : null,
    };
    const thrust = currentDb === null ? 0.3 : Math.min(1.6, Math.max(0.25, (currentDb - settings.floor) / 30));
    ui.world.update({ alt, ghosts: g, thrust, dt, snap: snapCamera, boosting: state === S.BOOSTER });
    snapCamera = false;
    trackMoments(alt, g);
    renderRunStatus(now, alt, g);
  } else if (state === S.IDLE || state === S.STANDBY) {
    ui.world.update({ alt: 0, ghosts: {}, thrust: 0.3, dt, snap: snapCamera });
    snapCamera = false;
    if (state === S.IDLE) {
      const np = nextPlayer();
      const best = store.bestRecord(groupOf(np?.division || ''));
      ui.setCells([
        { k: 'いまの こえ', v: !micOk || currentDb === null ? '--' : `${currentDb.toFixed(1)} dB`, color: C.cyan, size: 52 },
        np && (np.name || np.division)
          ? { k: 'つぎの ひと', v: playerLabel(np).replace(' さん', ''), color: C.yellow, size: 36 }
          : { k: 'もくひょう', v: 'うちゅう・つき', color: C.yellow, size: 40 },
        best ? { k: settings.divisions && np?.division ? `${store.divisionName(np.division, true)}の 1い` : 'きょうの 1い', v: `${fmtKm(best.score)} km`, color: C.lilac, size: 44 } : null,
      ]);
    }
  }

  if (clipUntil && now > clipUntil) {
    clipUntil = 0;
    ui.setClip(false);
  }
}

/** チャンピオン・へいきんを抜いた、星を通りすぎた、の演出。 */
function trackMoments(alt, g) {
  if (g.champ !== null) {
    if (alt < g.champ - 3) ctx.wasBehind = true;
    const leading = alt > g.champ + 3;
    if (leading && !ctx.leading && ctx.wasBehind) {
      ui.pop('チャンピオンを ぬいた！', 'lead');
      seRun('pass');
    }
    if (leading || alt < g.champ - 3) ctx.leading = leading;
  }
  if (g.avg !== null) {
    if (alt < g.avg - 3) ctx.avgBehind = true;
    const leading = alt > g.avg + 3;
    if (leading && !ctx.avgLeading && ctx.avgBehind) {
      ui.pop('へいきんを ぬいた！');
      seRun('pass');
    }
    if (leading || alt < g.avg - 3) ctx.avgLeading = leading;
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

function renderRunStatus(now, alt, g) {
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
    if (g.champ !== null && ctx.ghosts.champ) {
      const finalGhost = ctx.ghosts.champ.score;
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
    if (state === S.IDLE) renderIdleSide();
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
    phoneInfo = { lan: Boolean(h.lan), urls: Array.isArray(h.phoneUrls) ? h.phoneUrls : [], key: h.phoneKey || '' };
    admin.setInfo({ phone: phoneInfo });
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
lobby.start();
setInterval(() => lobby.pushStatus(remoteStatus()), 1000); // スマホの「いまの こえ」なども 1 秒ごとに

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
  get lobby() {
    return lobby.lobby;
  },
  get player() {
    return player;
  },
  get bgm() {
    return { playing: sound.bgmPlaying, files: sound.files, runActive: sound.runActive };
  },
};
