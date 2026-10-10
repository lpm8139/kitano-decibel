// render.js
// DOM 更新だけを担当する。状態管理・計算は app.js / scoring.js 側。
// createRenderer(document) が返すオブジェクトのメソッドを app.js から呼ぶ。

import { topN } from './storage.js';

const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
const fmtScore = (n) => Number(n).toFixed(1);

export function createRenderer(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const els = {
    app: $('app'),
    micStatus: $('mic-status'),
    clip: $('clip-warning'),
    stateLabel: $('state-label'),
    dbInt: $('db-int'),
    dbFrac: $('db-frac'),
    timer: $('timer'),
    message: $('message'),
    result: $('result'),
    resultBanner: $('result-banner'),
    resultScore: $('result-score'),
    resultRank: $('result-rank'),
    resultName: $('result-name'),
    resultForm: $('result-form'),
    btnResultDiscard: $('btn-result-discard'),
    leadBadge: $('lead-badge'),
    youName: $('you-name'),
    youValue: $('you-value'),
    youFill: $('you-fill'),
    ghostName: $('ghost-name'),
    ghostValue: $('ghost-value'),
    ghostFill: $('ghost-fill'),
    bestScore: $('best-score'),
    bestName: $('best-name'),
    top10: $('top10'),
    btnCsv: $('btn-csv'),
    btnSettings: $('btn-settings'),
    btnReset: $('btn-reset'),
    settings: $('settings'),
    btnSettingsClose: $('btn-settings-close'),
    liveDb: $('live-db'),
    liveDbfs: $('live-dbfs'),
    setDevice: $('set-device'),
    setDuration: $('set-duration'),
    setThreshold: $('set-threshold'),
    setFloor: $('set-floor'),
    setOffset: $('set-offset'),
    setMethod: $('set-method'),
    modal: $('modal'),
    modalTitle: $('modal-title'),
    modalMessage: $('modal-message'),
    modalOk: $('modal-ok'),
    modalCancel: $('modal-cancel'),
    flash: $('flash'),
    announce: $('announce'),
    toast: $('toast'),
    syncStatus: $('sync-status'),
    serverBanner: $('server-banner'),
    dataDir: $('data-dir'),
  };

  const stateLabels = {
    idle: '待機中',
    standby: 'スタンバイ',
    measuring: '計測中',
    result: '結果',
  };

  /** CSSアニメーションを最初から再生し直す。 */
  function restartAnimation(el, className) {
    el.classList.remove(className);
    void el.offsetWidth; // リフローを挟んで再生をリセット
    el.classList.add(className);
  }

  let toastTimer = null;
  let modalOpen = false;

  return {
    els,

    // ---- 状態・メッセージ ----
    setState(state) {
      els.app.dataset.state = state;
      els.stateLabel.textContent = stateLabels[state] ?? state;
    },
    setMessage(text, tone = '') {
      els.message.textContent = text;
      if (tone) els.message.dataset.tone = tone;
      else delete els.message.dataset.tone;
    },
    setTimerText(text) {
      els.timer.textContent = text;
    },
    setMicStatus(text, kind = 'pending') {
      els.micStatus.textContent = text;
      els.micStatus.dataset.kind = kind;
    },
    setClip(on) {
      els.clip.hidden = !on;
    },

    // ---- dB 表示 ----
    /** db: 表示dB（オフセット適用後）。null なら "--"。 */
    setDb(db, dbfs = null) {
      if (db === null || !Number.isFinite(db)) {
        els.dbInt.textContent = '--';
        els.dbFrac.textContent = '';
        els.liveDb.textContent = '--';
        els.liveDbfs.textContent = '--';
        return;
      }
      const shown = Math.max(0, db);
      const [i, f] = shown.toFixed(1).split('.');
      els.dbInt.textContent = i;
      els.dbFrac.textContent = `.${f}`;
      els.liveDb.textContent = db.toFixed(1);
      els.liveDbfs.textContent = dbfs === null ? '--' : dbfs.toFixed(1);
    },

    // ---- レース ----
    /** ゴーストのラベルと有無。record が null なら未登録表示。 */
    setGhost(record) {
      els.app.dataset.ghost = record ? 'has' : 'none';
      els.ghostName.textContent = record
        ? `ゴースト：${record.name || '名無し'}（${fmtScore(record.score)}）`
        : 'ゴースト：まだいません（最初の記録をつくろう）';
    },
    resetRace() {
      els.app.dataset.lead = 'none';
      els.leadBadge.textContent = '';
      els.youValue.textContent = '0';
      els.ghostValue.textContent = '0';
      els.youFill.style.width = '0%';
      els.ghostFill.style.width = '0%';
    },
    /**
     * @param {{you:number, ghost:number|null, scale:number, lead:'lead'|'behind'|'even'|'solo'}} s
     */
    renderRace({ you, ghost, scale, lead }) {
      const pct = (v) => `${Math.min(100, Math.max(0, (v / scale) * 100)).toFixed(2)}%`;
      els.youValue.textContent = fmtInt(you);
      els.youFill.style.width = pct(you);
      if (ghost !== null) {
        els.ghostValue.textContent = fmtInt(ghost);
        els.ghostFill.style.width = pct(ghost);
      }
      els.app.dataset.lead = lead === 'solo' ? 'none' : lead;
      if (lead === 'lead') {
        els.leadBadge.textContent = `リード中！  +${fmtInt(you - ghost)}`;
      } else if (lead === 'behind') {
        els.leadBadge.textContent = `追いかけろ！  -${fmtInt(ghost - you)}`;
      } else if (lead === 'even') {
        els.leadBadge.textContent = '互角！';
      } else {
        els.leadBadge.textContent = '';
      }
    },
    /** 逆転などの大文字演出。 */
    announce(text, tone) {
      els.announce.textContent = text;
      els.announce.dataset.tone = tone;
      restartAnimation(els.announce, 'on');
    },
    flash() {
      restartAnimation(els.flash, 'on');
    },

    // ---- ベスト・TOP10 ----
    renderBest(record) {
      els.bestScore.textContent = record ? fmtScore(record.score) : '--';
      els.bestName.textContent = record ? record.name || '名無し' : 'まだ記録がありません';
    },
    renderTop10(records, highlightId = null) {
      els.top10.textContent = '';
      const top = topN(records, 10);
      if (top.length === 0) {
        const li = doc.createElement('li');
        li.className = 'empty';
        li.textContent = 'まだ記録がありません';
        els.top10.append(li);
        return;
      }
      top.forEach((r, i) => {
        const li = doc.createElement('li');
        if (r.id === highlightId) li.className = 'current';
        const rank = doc.createElement('span');
        rank.className = 'rank';
        rank.textContent = String(i + 1);
        const name = doc.createElement('span');
        name.className = r.name ? 'name' : 'name anon';
        name.textContent = r.name || '名無し';
        const score = doc.createElement('span');
        score.className = 'score';
        score.textContent = fmtScore(r.score);
        li.append(rank, name, score);
        els.top10.append(li);
      });
    },

    // ---- 結果 ----
    showResult({ score, rank, total, isNewRecord, name = '' }) {
      els.resultScore.textContent = fmtScore(score);
      els.resultRank.textContent = `本日 ${rank} 位 / ${total} 人中`;
      els.resultBanner.hidden = !isNewRecord; // 表示に切り替わった時点で CSS の pop アニメが再生される
      els.resultName.value = name;
      els.result.hidden = false;
      els.resultName.focus();
    },
    hideResult() {
      els.result.hidden = true;
      els.resultBanner.hidden = true;
      els.resultName.blur();
    },
    getResultName() {
      return els.resultName.value;
    },

    // ---- ファイル保存の状態 ----
    setSync(text, kind) {
      els.syncStatus.textContent = text;
      els.syncStatus.dataset.kind = kind;
    },
    /** null で非表示。 */
    setServerBanner(text) {
      els.serverBanner.hidden = !text;
      if (text) els.serverBanner.textContent = text;
    },
    setDataDir(path) {
      els.dataDir.textContent = path || '（保存サーバー未接続）';
    },

    // ---- トースト ----
    toast(text, ms = 2500) {
      els.toast.textContent = text;
      els.toast.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
    },

    // ---- 設定パネル ----
    isSettingsOpen() {
      return !els.settings.hidden;
    },
    openSettings() {
      els.settings.hidden = false;
    },
    closeSettings() {
      els.settings.hidden = true;
      if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur();
    },
    fillSettings(s) {
      els.setDuration.value = s.duration;
      els.setThreshold.value = s.threshold;
      els.setFloor.value = s.floor;
      els.setOffset.value = s.offset;
      els.setMethod.value = s.scoreMethod;
    },
    readSettings() {
      return {
        deviceId: els.setDevice.value,
        duration: els.setDuration.value,
        threshold: els.setThreshold.value,
        floor: els.setFloor.value,
        offset: els.setOffset.value,
        scoreMethod: els.setMethod.value,
      };
    },
    fillDevices(devices, selectedId) {
      els.setDevice.textContent = '';
      const def = doc.createElement('option');
      def.value = '';
      def.textContent = '（既定のマイク）';
      els.setDevice.append(def);
      for (const d of devices) {
        const o = doc.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label;
        els.setDevice.append(o);
      }
      els.setDevice.value = devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
    },

    // ---- 確認モーダル（alert/confirm の代替） ----
    isModalOpen() {
      return modalOpen;
    },
    /** @returns {Promise<boolean>} OK なら true */
    confirm({ title, message, okLabel = 'OK', cancelLabel = 'キャンセル' }) {
      return new Promise((resolve) => {
        modalOpen = true;
        els.modalTitle.textContent = title;
        els.modalMessage.textContent = message;
        els.modalOk.textContent = okLabel;
        els.modalCancel.textContent = cancelLabel;
        els.modal.hidden = false;
        els.modalCancel.focus(); // 誤操作防止のためキャンセルが初期フォーカス

        const close = (result) => {
          modalOpen = false;
          els.modal.hidden = true;
          doc.defaultView.removeEventListener('keydown', onKey, true);
          els.modalOk.removeEventListener('click', onOk);
          els.modalCancel.removeEventListener('click', onCancel);
          resolve(result);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        // キャプチャ段階で受け、app.js のキー処理（Esc=中断など）に漏らさない
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close(false);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            (doc.activeElement === els.modalOk ? els.modalCancel : els.modalOk).focus();
          } else if (e.code === 'Space') {
            e.stopImmediatePropagation(); // フォーカス中ボタンの標準動作に任せ、アプリ側には渡さない
          }
        };
        els.modalOk.addEventListener('click', onOk);
        els.modalCancel.addEventListener('click', onCancel);
        doc.defaultView.addEventListener('keydown', onKey, true);
      });
    },
  };
}
