// meter-worklet.js
// AudioWorklet（音声スレッド）で 50ms ごとに RMS とピークを集計してメインスレッドへ送る。
//
// なぜ Worklet か: setInterval はタブが裏に回ったり、ウィンドウが最小化・完全に隠れたりすると
// Chrome によって 1 秒に 1 回まで間引かれる。そうなると 5 秒の計測が 5 サンプルしか取れず、
// スコアが粗くなる。音声スレッドの処理は間引かれないので、常に約 20Hz で測れる。

class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ms = options?.processorOptions?.intervalMs ?? 50;
    this.framesPerReport = Math.max(128, Math.round((sampleRate * ms) / 1000));
    this.sumSquares = 0;
    this.peak = 0;
    this.frames = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i];
        this.sumSquares += v * v;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
      }
      this.frames += channel.length;
    } else {
      this.frames += 128; // 入力が無い（無音）ブロックも時間は進める
    }
    if (this.frames >= this.framesPerReport) {
      const rms = Math.sqrt(this.sumSquares / this.frames);
      this.port.postMessage({ rms, peak: this.peak, frames: this.frames });
      this.sumSquares = 0;
      this.peak = 0;
      this.frames = 0;
    }
    return true; // マイクが繋がっている間はずっと動かす
  }
}

registerProcessor('meter-processor', MeterProcessor);
