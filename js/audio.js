// audio.js
// マイク入力（getUserMedia）から、約20Hzで dBFS を通知する。
// 加工系（エコーキャンセル・ノイズ抑制・自動ゲイン）はすべて OFF にして生の音量を測る。
//
// 集計は AudioWorklet（js/meter-worklet.js、音声スレッド）で行う。setInterval だと
// タブが裏に回る・ウィンドウが隠れると 1 秒 1 回に間引かれ、計測が粗くなるため。
// AudioWorklet が使えないブラウザだけ、従来の AnalyserNode + setInterval にフォールバックする。

import { samplesToDbfs, peakOf, peakToDbfs, rmsToDbfs } from './scoring.js';

/** 通知間隔（ms）。20Hz。 */
export const SAMPLE_INTERVAL_MS = 50;

/** 入力デバイス一覧（音声入力のみ）。権限取得前はラベルが空になる。 */
export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `マイク ${i + 1}`,
    }));
}

/** getUserMedia のエラーを、現場で読める日本語に直す。 */
export function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されていません。アドレスバー左のアイコンからマイクを「許可」にして、ページを再読み込みしてください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'マイクが見つかりません。レシーバーのUSB接続を確認し、設定(S)で入力デバイスを選び直してください。';
    case 'NotReadableError':
    case 'AbortError':
      return 'マイクを開けません。他のアプリ（Zoom等）が使用中でないか確認してください。';
    default:
      return `マイクを開始できません（${err?.name || err?.message || '不明なエラー'}）。`;
  }
}

/**
 * マイクメーター。
 *   const mic = new MicMeter({ onSample, onStatus });
 *   await mic.start(deviceId);
 *
 * onSample({ dbfs, peakDbfs, now })  now は performance.now()
 * onStatus({ status, message, label })  status: 'running' | 'suspended' | 'error' | 'stopped'
 */
export class MicMeter {
  constructor({ onSample = () => {}, onStatus = () => {} } = {}) {
    this.onSample = onSample;
    this.onStatus = onStatus;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.timer = null;
    this.worklet = null;
    this.mute = null;
    this.mode = null; // 'worklet' | 'interval'
    this.status = 'stopped';
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this.onStatus({ status, ...extra });
  }

  /** deviceId が空なら既定のマイク。指定デバイスが無ければ既定にフォールバックする。 */
  async start(deviceId = '') {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      this._setStatus('error', { message: 'このブラウザはマイク入力に対応していません（localhost または https で開いてください）。' });
      return false;
    }

    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };

    let stream = null;
    let fellBack = false;
    try {
      try {
        const audio = deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: base });
          fellBack = true;
        } else {
          throw err;
        }
      }
    } catch (err) {
      this._setStatus('error', { message: describeMicError(err) });
      return false;
    }

    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    // USB 抜けなどでトラックが終了したらエラー扱いにする
    track.addEventListener('ended', () => {
      if (this.stream === stream) {
        this._teardown();
        this._setStatus('error', { message: 'マイクが切断されました。USBを挿し直し、設定(S)でデバイスを選択してください。' });
      }
    });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(stream);

    if (await this._startWorklet(ctx, source)) {
      this.mode = 'worklet';
    } else {
      if (this.ctx !== ctx) return false; // 準備中に stop/start された
      // フォールバック: AnalyserNode を setInterval で読む（裏タブでは間引かれる）
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048; // 48kHz で約43ms。20Hz(50ms)間隔にほぼ重ならず隙間も小さい
      this.analyser.smoothingTimeConstant = 0;
      source.connect(this.analyser); // 出力には繋がない（ハウリング防止）
      this.buffer = new Float32Array(this.analyser.fftSize);
      this.timer = setInterval(() => this._tick(), SAMPLE_INTERVAL_MS);
      this.mode = 'interval';
    }

    ctx.addEventListener('statechange', () => this._reportContextState());

    this._setStatus(this.ctx.state === 'running' ? 'running' : 'suspended', {
      label: track.label,
      fellBack,
    });
    this.resume();
    return true;
  }

  _reportContextState() {
    if (!this.ctx) return;
    this._setStatus(this.ctx.state === 'running' ? 'running' : 'suspended', {
      label: this.stream?.getAudioTracks()[0]?.label,
    });
  }

  /** 自動再生ポリシーで suspended のときは、ユーザー操作内で呼ぶと再開できる。 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** AudioWorklet で集計を始める。使えなければ false。 */
  async _startWorklet(ctx, source) {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    try {
      await ctx.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url));
      if (this.ctx !== ctx) return false;
      const node = new AudioWorkletNode(ctx, 'meter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { intervalMs: SAMPLE_INTERVAL_MS },
      });
      node.port.onmessage = (e) => this._report(e.data.rms, e.data.peak);
      // 確実に処理させるため destination まで繋ぐが、音量0なのでスピーカーからは何も出ない（ハウリング防止）
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      this.worklet = node;
      this.mute = mute;
      return true;
    } catch {
      return false;
    }
  }

  _report(rms, peak) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.onSample({ dbfs: rmsToDbfs(rms), peakDbfs: peakToDbfs(peak), now: performance.now() });
  }

  _tick() {
    if (!this.analyser || this.ctx.state !== 'running') return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    this.onSample({
      dbfs: samplesToDbfs(this.buffer),
      peakDbfs: peakToDbfs(peakOf(this.buffer)),
      now: performance.now(),
    });
  }

  _teardown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      try {
        this.worklet.disconnect();
        this.mute?.disconnect();
      } catch {
        /* 既に切断済み */
      }
    }
    this.worklet = null;
    this.mute = null;
    this.mode = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }

  stop() {
    this._teardown();
    this.status = 'stopped';
  }
}
