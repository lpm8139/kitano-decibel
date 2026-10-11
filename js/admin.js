// admin.js
// 管理者画面（Ctrl+Shift+A ＋ 暗証番号）。当日の状況に合わせて機能のオン/オフ・難易度・音・マイクを変える。
// 画面の部品は下の表（SCHEMA）から作る。保存すると app.js の onSave に「入力された値」を渡す（正規化は app.js 側）。

import { SETTINGS_LIMITS } from './storage.js';

const L = SETTINGS_LIMITS;
const num = (key, label, unit, note = '', step = 1) => ({ type: 'num', key, label, unit, note, step, min: L[key]?.min, max: L[key]?.max });
const sw = (key, label, note = '') => ({ type: 'sw', key, label, note });
const range = (key, label) => ({ type: 'range', key, label });

const SCHEMA = [
  {
    title: 'ゲーム',
    rows: [
      sw('nameInput', '名前入力', 'オフ：結果のあと そのまま次の人へ'),
      sw('booster', 'ブースター（月までワープ）', 'オフ：時間内に月に届かなければそこで終了'),
      sw('cheerBoost', 'おうえんメーター', 'ブースター中の会場の声をメーターに表示（記録には入らない）'),
      sw('divisions', '部門わけ', 'ようちえん・1〜3ねん・4〜6ねん・おとな ごとにランキングとゴースト'),
      sw('ghost', 'チャンピオン ゴースト', '部門（部門わけオフなら全員）の今日の1位'),
      sw('ghostAvg', 'へいきん ゴースト', '部門のみんなの平均の飛び方（3人そろってから出る）'),
      num('stage1Sec', 'ステージ1の時間', '秒'),
      num('endlessMaxSec', 'エンドレスの最長', '秒'),
      num('silenceEndSec', '声がとぎれたら終了', '秒', 'エンドレス中、開始しきい値未満がこの秒数続いたら終わり', 0.1),
    ],
  },
  {
    title: '難易度',
    rows: [
      num('kmRate', 'のびやすさ', 'km/秒/dB', 'floor を 1dB こえるごとに 1秒で何km 上がるか', 0.5),
      num('floor', 'のびはじめ（floor）', 'dB', 'これ以下の声では ロケットがのびない'),
      num('goal1Km', 'もくひょう1「うちゅう」', 'km'),
      num('goal2Km', 'もくひょう2「つき」', 'km', 'かせい(800km)より手前'),
      { type: 'preview' },
    ],
  },
  {
    title: 'マイク・計測',
    rows: [
      { type: 'device', key: 'deviceId', label: '入力デバイス' },
      { type: 'live', label: 'いまの入力' },
      num('threshold', '開始しきい値', 'dB', 'これを超えたら計測スタート'),
      num('offset', '校正オフセット', 'dB', '表示dB = dBFS + オフセット（スマホ騒音計と見比べて合わせる）', 0.5),
      { type: 'theme', key: 'theme', label: '背景', note: '暗い会場なら「宇宙（暗い）」も選べる' },
    ],
  },
];

const SCHEMA2 = [
  {
    title: 'サウンド',
    rows: [
      { type: 'swrange', key: 'bgm', rangeKey: 'bgmVolume', label: 'BGM' },
      sw('muteBgmDuringRun', '計測中は BGM を消す', 'スピーカーの音で dB が上がらないように'),
      { type: 'swrange', key: 'se', rangeKey: 'seVolume', label: '効果音' },
      sw('seDuringRun', '計測中の効果音', 'ゴール音などを計測中にも鳴らす（dB に影響）'),
      { type: 'sounds', label: 'BGM ファイル' },
      { type: 'test', label: '試し再生' },
    ],
  },
  {
    title: '記録',
    rows: [
      { type: 'datadir', label: '保存先' },
      { type: 'records', label: '本日の記録' },
    ],
  },
  {
    title: '運用',
    rows: [
      sw('rehearsal', 'リハーサルモード', 'オン中の記録はランキング・ゴーストに入れない'),
      { type: 'phone', label: 'スマホ受付' },
      { type: 'queue', label: '順番待ち' },
      { type: 'pin', key: 'adminPin', label: '暗証番号の変更', note: '4〜8桁の数字。空欄なら変更しない' },
      { type: 'info', label: 'キー操作', html: 'Space スタンバイ/開始 ・ Esc 中断 ・ F 全画面<br>結果画面: Enter 決定 ・ Esc 名前なし ・ Delete 破棄' },
    ],
  },
];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** 難易度の目安（何dBでうちゅう・つきまで何秒か）。テストしやすいよう純関数。 */
export function difficultyPreview(s) {
  const lines = [];
  for (const db of [65, 75, 85, 95]) {
    const speed = Math.max(0, db - s.floor) * s.kmRate; // km/秒
    const t1 = speed > 0 ? s.goal1Km / speed : Infinity;
    const t2 = speed > 0 ? s.goal2Km / speed : Infinity;
    const fmt = (t) => (Number.isFinite(t) ? `${t.toFixed(1)}秒` : 'とどかない');
    const boost = t2 > s.stage1Sec ? (s.booster ? '→ ブースター' : '→ 時間切れ') : '';
    const endless = speed * s.endlessMaxSec;
    lines.push(`${db}dB: うちゅう ${fmt(t1)} / つき ${fmt(t2)} ${boost}　エンドレス最大 +${Math.round(endless).toLocaleString('ja-JP')}km`);
  }
  return lines;
}

export function createAdmin(root, handlers) {
  const inputs = {}; // key -> input element
  let liveEl = null;
  let previewEl = null;
  let deviceSel = null;
  let soundsEl = null;
  let dataDirEl = null;
  let recordsEl = null;
  let phoneEl = null;
  let queueEl = null;
  let open = false;
  let current = null;

  function row(def) {
    const label = h('div', {}, h('div', { class: 'row-label' }, def.label ?? ''), def.note ? h('div', { class: 'row-note' }, def.note) : null);
    let ctrl;
    switch (def.type) {
      case 'sw': {
        const inp = h('input', { type: 'checkbox', 'data-key': def.key, onchange: refreshPreview });
        inputs[def.key] = inp;
        ctrl = h('label', { class: 'sw' }, inp, h('span'));
        break;
      }
      case 'swrange': {
        const inp = h('input', { type: 'checkbox', 'data-key': def.key });
        const r = h('input', { type: 'range', min: 0, max: 1, step: 0.05, 'data-key': def.rangeKey });
        inputs[def.key] = inp;
        inputs[def.rangeKey] = r;
        ctrl = [h('label', { class: 'sw' }, inp, h('span')), r];
        break;
      }
      case 'num': {
        const inp = h('input', { type: 'number', step: def.step, min: def.min, max: def.max, 'data-key': def.key, oninput: refreshPreview });
        inputs[def.key] = inp;
        ctrl = [inp, h('span', { class: 'unit' }, def.unit)];
        break;
      }
      case 'device':
        deviceSel = h('select', { 'data-key': 'deviceId' });
        inputs.deviceId = deviceSel;
        ctrl = deviceSel;
        break;
      case 'theme': {
        const sel = h('select', { 'data-key': 'theme' }, h('option', { value: 'light' }, '明るい管制室'), h('option', { value: 'dark' }, '宇宙（暗い）'));
        inputs.theme = sel;
        ctrl = sel;
        break;
      }
      case 'live':
        liveEl = h('span', { class: 'live' }, '--');
        ctrl = liveEl;
        break;
      case 'preview':
        previewEl = h('div', { class: 'hint-box' });
        return h('div', { class: 'row', style: 'display:block' }, h('div', { class: 'row-label' }, 'めやす（保存前の値で計算）'), previewEl);
      case 'sounds':
        soundsEl = h('div', { class: 'row-note', style: 'max-width:360px;white-space:normal;text-align:right' });
        ctrl = soundsEl;
        break;
      case 'test':
        ctrl = [
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => handlers.onNextBgm?.() }, '♪ 次の曲'),
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => handlers.onTestSe?.('goal') }, 'ゴール音'),
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => handlers.onTestSe?.('booster') }, 'ブースター'),
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => handlers.onTestSe?.('newRecord') }, 'しんきろく'),
        ];
        break;
      case 'datadir':
        dataDirEl = h('div', { class: 'mono', style: 'max-width:780px;text-align:right' });
        ctrl = dataDirEl;
        break;
      case 'records':
        recordsEl = h('span', { class: 'live', style: 'color:#1f2a44' });
        ctrl = [
          recordsEl,
          h('button', { type: 'button', class: 'btn btn-small', onclick: () => handlers.onCsv?.() }, 'CSV出力'),
          h('button', { type: 'button', class: 'btn btn-small btn-soft-danger', onclick: () => handlers.onReset?.() }, '本日の記録をリセット'),
        ];
        break;
      case 'phone':
        phoneEl = h('div', { class: 'phone-box' });
        return h('div', { class: 'row', style: 'display:block' },
          h('div', { class: 'row-label' }, 'スマホ受付（同じ Wi-Fi・PC のテザリングで、QR を読む）'), phoneEl);
      case 'queue':
        queueEl = h('span', { class: 'live', style: 'color:#1f2a44' }, '0 人');
        ctrl = [queueEl, h('button', { type: 'button', class: 'btn btn-small btn-soft-danger', onclick: () => handlers.onClearQueue?.() }, '全部けす')];
        break;
      case 'pin': {
        const inp = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: '変更しない', autocomplete: 'new-password', 'data-key': 'adminPin' });
        inputs.adminPin = inp;
        ctrl = inp;
        break;
      }
      case 'info':
        ctrl = h('div', { class: 'row-note', html: def.html, style: 'text-align:right' });
        break;
      default:
        ctrl = null;
    }
    return h('div', { class: 'row' }, label, h('div', { class: 'row-ctrl' }, ctrl));
  }

  const card = (c) => h('section', { class: 'card' }, h('h2', {}, c.title), c.rows.map(row));

  root.append(
    h(
      'div',
      { class: 'admin-head' },
      h('h1', {}, '管理者画面', h('small', {}, '保存すると PC のファイル（data/settings.json）にも残ります ／ Esc でキャンセル')),
      h(
        'div',
        { class: 'admin-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => handlers.onCancel?.() }, 'キャンセル'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => handlers.onSave?.(read()) }, '保存して戻る'),
      ),
    ),
    h('div', { class: 'admin-grid' }, SCHEMA.map(card)),
    h('div', { class: 'admin-grid', style: 'margin-top:20px' }, SCHEMA2.map(card)),
  );

  let phoneKeyShown = '';
  /** スマホ受付の QR コードと URL。 */
  function renderPhone(phone) {
    const sig = JSON.stringify(phone);
    if (sig === phoneKeyShown) return; // 変わっていなければ作り直さない（毎回 QR を作ると重い）
    phoneKeyShown = sig;
    phoneEl.textContent = '';
    if (!phone || !phone.lan) {
      phoneEl.append(h('div', { class: 'row-note' },
        'いまは使えません。Python 版の保存サーバー（start.bat）で起動すると使えます。PowerShell 版は「管理者として実行」したときだけ使えます。'));
      return;
    }
    if (!phone.urls?.length) {
      phoneEl.append(h('div', { class: 'row-note' }, 'ネットワークにつながっていません。PC の「モバイル ホットスポット」をオンにするか、Wi-Fi につないでください（10秒ほどで出ます）。'));
      return;
    }
    const url = phone.urls[0];
    const qrBox = h('div', { class: 'phone-qr' });
    try {
      const qr = globalThis.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      qrBox.textContent = '（QR を作れませんでした）';
    }
    const list = h('div', { class: 'phone-urls' },
      h('div', {}, 'スマホのカメラで読む。読めないときは下のアドレスを入力:'),
      ...phone.urls.map((u) => h('div', { class: 'mono' }, u)),
      h('div', { style: 'margin-top:6px' }, '合言葉 ', h('b', {}, phone.key || '')),
      h('div', { class: 'row-note' }, 'スマホは PC と同じネットワークに。PC のテザリングなら 192.168.137.x が先頭に出ます。'));
    phoneEl.append(qrBox, list);
  }

  function read() {
    const out = {};
    for (const [k, el] of Object.entries(inputs)) {
      if (el.type === 'checkbox') out[k] = el.checked;
      else if (k === 'adminPin') out[k] = el.value.trim() || current?.adminPin;
      else out[k] = el.value;
    }
    return out;
  }

  function fill(s) {
    for (const [k, el] of Object.entries(inputs)) {
      if (k === 'deviceId') continue;
      if (el.type === 'checkbox') el.checked = Boolean(s[k]);
      else if (k === 'adminPin') el.value = '';
      else el.value = s[k];
    }
    refreshPreview();
  }

  function refreshPreview() {
    if (!previewEl || !current) return;
    const v = read();
    const s = {
      floor: Number(v.floor),
      kmRate: Number(v.kmRate),
      goal1Km: Number(v.goal1Km),
      goal2Km: Number(v.goal2Km),
      stage1Sec: Number(v.stage1Sec),
      endlessMaxSec: Number(v.endlessMaxSec),
      booster: Boolean(v.booster),
    };
    if (![s.floor, s.kmRate, s.goal1Km, s.goal2Km, s.stage1Sec, s.endlessMaxSec].every(Number.isFinite)) {
      previewEl.textContent = '数値を入れてください';
      return;
    }
    previewEl.innerHTML = '';
    for (const line of difficultyPreview(s)) previewEl.append(h('div', {}, line));
  }

  return {
    isOpen: () => open,
    open(settings, info = {}) {
      current = settings;
      fill(settings);
      this.setInfo(info);
      root.hidden = false;
      open = true;
      root.scrollTop = 0;
    },
    close() {
      root.hidden = true;
      open = false;
      if (root.contains(document.activeElement)) document.activeElement.blur();
    },
    read,
    /** 情報欄（デバイス一覧・保存先・記録件数・BGM ファイル）を更新。 */
    setInfo({ devices, dataDir, syncText, recordCount, sounds, phone, queueCount } = {}) {
      if (devices && deviceSel) {
        const selected = current?.deviceId ?? '';
        deviceSel.textContent = '';
        deviceSel.append(h('option', { value: '' }, '（既定のマイク）'));
        for (const d of devices) deviceSel.append(h('option', { value: d.deviceId }, d.label));
        deviceSel.value = devices.some((d) => d.deviceId === selected) ? selected : '';
      }
      if (dataDirEl && (dataDir !== undefined || syncText !== undefined)) {
        dataDirEl.textContent = `${dataDir || '（保存サーバー未接続）'}${syncText ? `　${syncText}` : ''}`;
      }
      if (recordsEl && recordCount !== undefined) recordsEl.textContent = `${recordCount} 件`;
      if (queueEl && queueCount !== undefined) queueEl.textContent = `${queueCount} 人`;
      if (phoneEl && phone !== undefined) renderPhone(phone);
      if (soundsEl && sounds !== undefined) {
        soundsEl.textContent = sounds.length
          ? sounds.join(' ／ ')
          : 'sound フォルダに mp3 などを入れると流れます（いまは なし）';
      }
    },
    /** いまのマイク入力。dB は入力欄の校正オフセット（保存前でも）で計算して、合わせやすくする。 */
    setLive(dbfs) {
      if (!open || !liveEl) return;
      const off = Number(inputs.offset?.value);
      const offset = Number.isFinite(off) && inputs.offset.value !== '' ? off : current?.offset ?? 0;
      liveEl.textContent = Number.isFinite(dbfs) ? `${dbfs.toFixed(1)} dBFS → ${(dbfs + offset).toFixed(1)} dB` : '--';
    },
  };
}
