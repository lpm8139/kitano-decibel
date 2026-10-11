// render.js
// 画面の更新だけを担当する（状態管理・計算は app.js / game.js）。
// createRenderer(document) が返すオブジェクトのメソッドを app.js から呼ぶ。

import { DIVISIONS, divisionName, inDivision, topN } from './storage.js';
import { WorldView } from './world.js';
import { planetSvg, planetWidth, rocketSvg } from './art.js';

export const STAGE_W = 1920;
export const STAGE_H = 1080;

const km = (n) => `${Math.round(n).toLocaleString('ja-JP')}`;

export function createRenderer(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const els = {
    viewport: $('viewport'),
    stage: $('stage'),
    serverBanner: $('server-banner'),
    syncStatus: $('sync-status'),
    micStatus: $('mic-status'),
    clip: $('clip-warning'),
    rehearsal: $('rehearsal-badge'),
    mainTitle: $('main-title'),
    sideTitle: $('side-title'),
    statusTitle: $('status-title'),
    dbInt: $('db-int'),
    dbFrac: $('db-frac'),
    dbBar: $('db-bar'),
    dbThreshold: $('db-threshold'),
    cheerBar: $('cheer-bar'),
    scoreBig: $('score-big'),
    resultName: $('result-name'),
    btnDiscard: $('btn-discard'),
    btnAdmin: $('btn-admin'),
    rankList: $('rank-list'),
    queueList: $('queue-list'),
    divButtons: $('div-buttons'),
    strip: $('strip'),
    stageTimer: $('stage-timer'),
    stageTimerFill: $('stage-timer-fill'),
    stageTimerText: $('stage-timer-text'),
    endlessBadge: $('endless-badge'),
    pop: $('pop'),
    goalCard: $('goal-card'),
    goalCardSub: $('goal-card-sub'),
    goalCardPlace: $('goal-card-place'),
    boosterPill: $('booster-pill'),
    endlessPill: $('endless-pill'),
    resultView: $('result-view'),
    resultPlanet: $('result-planet'),
    resultRocket: $('result-rocket'),
    resultPlace: $('result-place'),
    resultBadges: $('result-badges'),
    newRecordPill: $('newrecord-pill'),
    confetti: $('confetti'),
    flash: $('flash'),
    toast: $('toast'),
    admin: $('admin'),
    pin: $('pin'),
    pinForm: $('pin-form'),
    pinInput: $('pin-input'),
    pinError: $('pin-error'),
    modal: $('modal'),
    modalTitle: $('modal-title'),
    modalMessage: $('modal-message'),
    modalOk: $('modal-ok'),
    modalCancel: $('modal-cancel'),
    cells: [0, 1, 2].map((i) => {
      const c = $(`cell-${i}`);
      return { el: c, k: c.querySelector('.cell-k'), v: c.querySelector('.cell-v'), key: '' };
    }),
  };
  const world = new WorldView($('world-screen'));

  /** テキストが変わったときだけ書き換える（毎フレーム呼んでも重くならないように）。 */
  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };
  const restartAnimation = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };
  const timers = new Map();
  /** 要素を ms だけ表示する。 */
  const showFor = (el, ms) => {
    el.hidden = false;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => (el.hidden = true), ms));
  };

  let modalOpen = false;
  let toastTimer = null;

  return {
    els,
    world,

    // ---- 舞台の大きさ（プロジェクターでも小さい画面でも 16:9 で全体が入る） ----
    fit() {
      const vw = els.viewport.clientWidth || window.innerWidth;
      const vh = els.viewport.clientHeight || window.innerHeight;
      const s = Math.min(vw / STAGE_W, vh / STAGE_H);
      const x = (vw - STAGE_W * s) / 2;
      const y = (vh - STAGE_H * s) / 2;
      els.stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    },

    // ---- 状態 ----
    setState(state) {
      els.stage.dataset.state = state;
    },
    setTheme(theme) {
      els.stage.dataset.theme = theme;
    },
    setGhostOn(on) {
      els.stage.dataset.ghost = on ? 'has' : 'none';
    },
    setSide(panel, title) {
      els.stage.dataset.side = panel;
      setText(els.sideTitle, title);
    },
    setTitles({ main, status }) {
      if (main) setText(els.mainTitle, main);
      if (status) setText(els.statusTitle, status);
    },
    /** 卓の案内表示。tone: '' | 'green' | 'pink' | 'yellow' | 'error' */
    setStrip(text, tone = '') {
      setText(els.strip, text);
      if (tone) els.strip.dataset.tone = tone;
      else delete els.strip.dataset.tone;
    },
    /** ミッション状況の3マス。cells: [{k, v, color, size}]（足りない分は隠す） */
    setCells(cells) {
      els.cells.forEach((c, i) => {
        const d = cells[i];
        if (!d) {
          c.el.dataset.empty = '1';
          return;
        }
        delete c.el.dataset.empty;
        setText(c.k, d.k);
        setText(c.v, d.v);
        const style = `color:${d.color || '#fff'};font-size:${d.size || 52}px`;
        if (c.key !== style) {
          c.v.setAttribute('style', style);
          c.key = style;
        }
      });
    },
    setMicStatus(text, kind = 'pending') {
      setText(els.micStatus, text);
      els.micStatus.dataset.kind = kind;
    },
    setSync(text, kind) {
      setText(els.syncStatus, text);
      els.syncStatus.dataset.kind = kind;
    },
    setServerBanner(text) {
      els.serverBanner.hidden = !text;
      if (text) els.serverBanner.textContent = text;
    },
    setClip(on) {
      els.clip.hidden = !on;
    },
    setRehearsal(on) {
      els.rehearsal.hidden = !on;
    },

    // ---- こえパワー ----
    /** db: 表示dB。null なら "--"。meter は 40〜110dB をバーの 0〜100% にする。 */
    setDb(db) {
      if (db === null || !Number.isFinite(db)) {
        setText(els.dbInt, '--');
        setText(els.dbFrac, '');
        els.dbBar.style.width = '0%';
        return;
      }
      const shown = Math.max(0, db);
      const [i, f] = shown.toFixed(1).split('.');
      setText(els.dbInt, i);
      setText(els.dbFrac, `.${f}`);
      els.dbBar.style.width = `${Math.min(100, Math.max(0, ((db - 40) / 70) * 100)).toFixed(1)}%`;
    },
    setThresholdMark(threshold) {
      els.dbThreshold.style.left = `${Math.min(100, Math.max(0, ((threshold - 40) / 70) * 100))}%`;
    },
    setCheer(db) {
      const p = db === null || !Number.isFinite(db) ? 0 : Math.min(100, Math.max(0, ((db - 50) / 50) * 100));
      els.cheerBar.style.width = `${p.toFixed(1)}%`;
    },

    // ---- ステージの残り時間バー ----
    setStageTimer(frac, text) {
      if (frac === null) {
        els.stageTimer.hidden = true;
        return;
      }
      els.stageTimer.hidden = false;
      els.stageTimerFill.style.width = `${(Math.min(1, Math.max(0, frac)) * 100).toFixed(1)}%`;
      setText(els.stageTimerText, text);
    },
    setEndlessBadge(on) {
      els.endlessBadge.hidden = !on;
    },

    // ---- 演出 ----
    goalCard(n, placeName) {
      setText(els.goalCardSub, `もくひょう${n}`);
      setText(els.goalCardPlace, `${placeName}に とうちゃく！`);
      showFor(els.goalCard, 1300);
      restartAnimation(els.goalCard, 'on');
    },
    boosterPill(ms = 2800) {
      showFor(els.boosterPill, ms);
    },
    endlessPill(text = '∞ エンドレスモード スタート！', ms = 1700) {
      els.goalCard.hidden = true;
      els.endlessPill.textContent = text;
      showFor(els.endlessPill, ms);
    },
    pop(text, tone = '') {
      els.pop.textContent = text;
      if (tone) els.pop.dataset.tone = tone;
      else delete els.pop.dataset.tone;
      restartAnimation(els.pop, 'on');
    },
    clearEffects() {
      for (const el of [els.goalCard, els.boosterPill, els.endlessPill, els.newRecordPill]) el.hidden = true;
      els.pop.classList.remove('on');
      els.confetti.textContent = '';
    },
    flash() {
      restartAnimation(els.flash, 'on');
    },
    confetti(n = 110) {
      const colors = ['#FFD166', '#FF5A8A', '#8ED6FF', '#7CF29C', '#FF7A1A', '#C3B5FF'];
      const frag = doc.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        const c = doc.createElement('i');
        c.style.left = `${Math.random() * 1920}px`;
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = `${2.2 + Math.random() * 2.2}s`;
        c.style.animationDelay = `${Math.random() * 0.9}s`;
        c.style.width = `${12 + Math.random() * 12}px`;
        frag.append(c);
      }
      els.confetti.textContent = '';
      els.confetti.append(frag);
      setTimeout(() => (els.confetti.textContent = ''), 6000);
    },

    // ---- 結果 ----
    /**
     * @param {{score:number, place:object, reached:{goal1:boolean, goal2:boolean}, boosted:boolean,
     *          beyondMoon:boolean, isNewRecord:boolean}} r
     */
    showResult({ place, reached, boosted, beyondMoon, isNewRecord, score }) {
      els.resultPlanet.innerHTML = '';
      if (place.planet) {
        const d = 560;
        els.resultPlanet.style.left = `${-planetWidth(place.planet, d) / 2 + 40}px`;
        els.resultPlanet.innerHTML = planetSvg(place.planet, d);
      }
      els.resultRocket.innerHTML = rocketSvg({ width: 150 });
      els.resultPlace.innerHTML = '';
      const line1 = doc.createElement('div');
      line1.textContent = place.key === 'earth' ? 'もうすこし！' : `${place.name} まで`;
      const line2 = doc.createElement('div');
      line2.textContent = place.key === 'earth' ? 'また ちょうせん してね' : 'いった！';
      els.resultPlace.append(line1, line2);
      const badges = [];
      if (reached.goal1) badges.push(['★', 'うちゅう', '']);
      if (reached.goal2) badges.push(['★', 'つき', boosted ? 'boost' : '']); // ワープで着いたときはオレンジ
      if (beyondMoon) badges.push(['∞', place.name.length > 6 ? place.name.slice(0, 6) : place.name, 'endless']);
      els.resultBadges.innerHTML = '';
      for (const [b, t, cls] of badges) {
        const el = doc.createElement('div');
        el.className = `badge ${cls}`;
        const bb = doc.createElement('b');
        bb.textContent = b;
        const sm = doc.createElement('small');
        sm.textContent = t;
        el.append(bb, sm);
        els.resultBadges.append(el);
      }
      els.newRecordPill.hidden = !isNewRecord;
      els.stage.dataset.newrecord = isNewRecord ? '1' : '0';
      setText(els.scoreBig, km(score));
      els.resultView.hidden = false;
    },
    /** しんきろくの演出（結果画面。部門があとから決まったときにも呼ぶ）。 */
    celebrate() {
      els.newRecordPill.hidden = false;
      els.stage.dataset.newrecord = '1';
      this.flash();
      this.confetti();
    },
    hideResult() {
      els.resultView.hidden = true;
      els.newRecordPill.hidden = true;
      els.stage.dataset.newrecord = '0';
      els.resultName.blur();
    },
    focusName(name = '') {
      els.resultName.value = name;
      els.resultName.focus();
    },
    getResultName() {
      return els.resultName.value;
    },

    // ---- ランキング ----
    /**
     * 部門なし: 上位6件を2列。部門あり: 4部門を横に並べて各上位3件。
     * @param {object[]} records ランキング対象（isRankable）の記録
     */
    renderRanking(records, highlightId = null, { divisions = false, active = '' } = {}) {
      els.rankList.textContent = '';
      const item = (r, i) => {
        const li = doc.createElement('li');
        if (r.id === highlightId) li.className = 'current';
        const rank = doc.createElement('span');
        rank.className = 'r';
        rank.textContent = String(i + 1);
        const name = doc.createElement('span');
        name.className = r.name ? 'n' : 'n anon';
        name.textContent = r.name || 'ななし';
        const score = doc.createElement('span');
        score.className = 's';
        score.textContent = divisions ? km(r.score) : `${km(r.score)} km`;
        li.append(rank, name, score);
        return li;
      };
      if (divisions) {
        const cols = doc.createElement('div');
        cols.className = 'rank-cols';
        for (const d of DIVISIONS) {
          const sec = doc.createElement('section');
          if (d.key === active) sec.className = 'active';
          const h = doc.createElement('h3');
          h.textContent = d.name;
          const ol = doc.createElement('ol');
          const top = topN(inDivision(records, d.key), 3);
          top.forEach((r, i) => ol.append(item(r, i)));
          if (!top.length) {
            const li = doc.createElement('li');
            li.className = 'empty';
            li.textContent = 'まだ いないよ';
            ol.append(li);
          }
          sec.append(h, ol);
          cols.append(sec);
        }
        els.rankList.append(cols);
        return;
      }
      const ol = doc.createElement('ol');
      const top = topN(records, 6);
      if (top.length === 0) {
        const li = doc.createElement('li');
        li.className = 'empty';
        li.textContent = 'まだ だれも とんでいないよ。さいしょの うちゅうひこうしに なろう！';
        ol.append(li);
      }
      top.forEach((r, i) => ol.append(item(r, i)));
      els.rankList.append(ol);
    },

    // ---- 順番待ち ----
    renderQueue(queue) {
      els.queueList.textContent = '';
      queue.slice(0, 4).forEach((q, i) => {
        const li = doc.createElement('li');
        const no = doc.createElement('span');
        no.className = 'no';
        no.textContent = String(i + 1);
        const nm = doc.createElement('span');
        nm.textContent = q.name || 'ななし';
        li.append(no, nm);
        if (q.division) {
          const dv = doc.createElement('span');
          dv.className = 'dv';
          dv.textContent = `（${divisionName(q.division, true)}）`;
          li.append(dv);
        }
        els.queueList.append(li);
      });
      if (queue.length > 4) {
        const li = doc.createElement('li');
        li.className = 'more';
        li.textContent = `ほか ${queue.length - 4} にん まってるよ`;
        els.queueList.append(li);
      }
    },

    /** 結果画面の部門ボタン。need = まだ選ばれていなくて選んでほしいとき点滅。 */
    setDivisionButtons(division, { visible = true, need = false } = {}) {
      els.divButtons.hidden = !visible;
      els.divButtons.dataset.need = need ? '1' : '0';
      for (const b of els.divButtons.querySelectorAll('button')) b.classList.toggle('on', b.dataset.div === division);
    },

    // ---- トースト ----
    toast(text, ms = 2500) {
      els.toast.textContent = text;
      els.toast.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => els.toast.classList.remove('on'), ms);
    },

    // ---- 暗証番号 ----
    isPinOpen() {
      return !els.pin.hidden;
    },
    /** @returns {Promise<boolean>} 正しい番号なら true、Esc なら false */
    askPin(expected) {
      return new Promise((resolve) => {
        modalOpen = true;
        els.pin.hidden = false;
        els.pinInput.value = '';
        els.pinError.textContent = '';
        els.pinInput.focus();
        const close = (ok) => {
          modalOpen = false;
          els.pin.hidden = true;
          els.pinInput.blur();
          els.pinForm.removeEventListener('submit', onSubmit);
          doc.defaultView.removeEventListener('keydown', onKey, true);
          resolve(ok);
        };
        const onSubmit = (e) => {
          e.preventDefault();
          if (els.pinInput.value === expected) {
            close(true);
          } else {
            els.pinError.textContent = '暗証番号が ちがいます';
            els.pinInput.value = '';
          }
        };
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close(false);
          } else {
            e.stopImmediatePropagation(); // 入力中のキーをアプリ側（Space=スタンバイなど）に渡さない
          }
        };
        els.pinForm.addEventListener('submit', onSubmit);
        doc.defaultView.addEventListener('keydown', onKey, true);
      });
    },

    // ---- 確認ダイアログ（alert/confirm の代替） ----
    isModalOpen() {
      return modalOpen;
    },
    /** @returns {Promise<boolean>} OK なら true */
    confirm({ title, message, okLabel = 'OK', cancelLabel = 'キャンセル' }) {
      return new Promise((resolve) => {
        modalOpen = true;
        const prevFocus = doc.activeElement;
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
          if (prevFocus && prevFocus !== doc.body && typeof prevFocus.focus === 'function') prevFocus.focus();
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
          } else if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopImmediatePropagation();
            (doc.activeElement === els.modalOk ? els.modalCancel : els.modalOk).focus();
          } else {
            e.stopImmediatePropagation(); // Enter/Space はフォーカス中ボタンの標準動作に任せる
          }
        };
        els.modalOk.addEventListener('click', onOk);
        els.modalCancel.addEventListener('click', onCancel);
        doc.defaultView.addEventListener('keydown', onKey, true);
      });
    },
  };
}
