/**
 * Звук без внешних файлов: всё синтезируется через Web Audio.
 *
 * Ни одного запроса за ассетом — игра остаётся лёгкой и работает офлайн.
 * Контекст создаётся только после первого действия пользователя: браузеры
 * не разрешают запускать звук до жеста.
 */

/** Пентатоника: импульс всегда звучит в строю, но по-разному. */
const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0];
/** Частота «тика» пульсации по ступеням сложности. */
const TICK_BASE_HZ = 92;

export class Sound {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.step = 0;
    this.ambientNodes = null;
  }

  /** Разбудить звук после первого действия игрока. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      this.enabled = false;
      return;
    }

    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  /** Общий выключатель звука из настроек. */
  setEnabled(value) {
    this.enabled = Boolean(value);
    if (this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.5 : 0, this.ctx.currentTime, 0.05);
    }
    if (!this.enabled) this.stopAmbient();
  }

  /**
   * Короткий тон с огибающей: база для всех эффектов.
   * @param {object} options
   * @param {number} options.freq герц
   * @param {number} [options.duration] секунды
   * @param {number} [options.gain] амплитуда
   * @param {OscillatorType} [options.type]
   * @param {number} [options.slideTo] конечная частота (для падающего тона)
   */
  tone({ freq, duration = 0.09, gain = 0.25, type = 'sine', slideTo = 0 }) {
    if (!this.ctx || !this.enabled) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo > 0) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Шумовой всплеск — резкий звук касания кольца. */
  noise({ duration = 0.18, gain = 0.3 } = {}) {
    if (!this.ctx || !this.enabled) return;

    const now = this.ctx.currentTime;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < frames; i += 1) {
      // Затухающий шум: энергия падает к концу буфера.
      const decay = 1 - i / frames;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }

    const source = this.ctx.createBufferSource();
    const env = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(160, now + duration);

    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    source.start(now);
  }

  /** Низкий гул на фоне: синусоида 46 Гц плюс тихая квинта. */
  startAmbient() {
    if (!this.ctx || !this.enabled || this.ambientNodes) return;

    const now = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 1.2);
    gain.connect(this.master);

    const base = this.ctx.createOscillator();
    base.type = 'sine';
    base.frequency.value = 46;

    const fifth = this.ctx.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 69;
    const fifthGain = this.ctx.createGain();
    fifthGain.gain.value = 0.35;
    fifth.connect(fifthGain);
    fifthGain.connect(gain);
    base.connect(gain);

    base.start(now);
    fifth.start(now);

    this.ambientNodes = { base, fifth, gain };
  }

  /** Убрать гул: пауза, меню, выключенный звук. */
  stopAmbient() {
    if (!this.ambientNodes) return;
    const { base, fifth, gain } = this.ambientNodes;

    const now = this.ctx.currentTime;
    gain.gain.setTargetAtTime(0.0001, now, 0.2);
    base.stop(now + 0.8);
    fifth.stop(now + 0.8);
    this.ambientNodes = null;
  }

  /** Импульс: короткий blip, нота идёт по пентатонике вверх вместе с точностью. */
  pulse(combo = 0) {
    const note = PENTATONIC[this.step % PENTATONIC.length];
    this.step = (this.step + 1) % 64;

    this.tone({ freq: note * 2, duration: 0.085, gain: 0.2, type: 'triangle' });
    if (combo > 0) {
      this.tone({ freq: note * 3, duration: 0.05, gain: 0.07, type: 'sine' });
    }
  }

  /** Нажатие без энергии: глухой отказ. */
  weak() {
    this.tone({ freq: 110, duration: 0.12, gain: 0.12, type: 'square', slideTo: 70 });
  }

  /**
   * Разрушение кольца: короткий сухой щелчок поверх падающего тона.
   * @param {number} count сколько колец разбито одним импульсом — двойное звучит плотнее
   */
  shatter(count = 1) {
    const heavy = count > 1;
    this.noise({ duration: heavy ? 0.16 : 0.1, gain: heavy ? 0.2 : 0.13 });
    this.tone({
      freq: heavy ? 320 : 260,
      duration: heavy ? 0.16 : 0.11,
      gain: 0.1,
      type: 'triangle',
      slideTo: 90,
    });
  }

  /** Чистое уклонение: чистый высокий тон. */
  clean(multiplier = 1) {
    const note = PENTATONIC[Math.min(PENTATONIC.length - 1, Math.floor(multiplier)) - 1] ?? PENTATONIC[0];
    this.tone({ freq: note * 3, duration: 0.12, gain: 0.14, type: 'sine' });
  }

  /** Касание кольца: шум с падающим тоном. */
  hit() {
    this.noise({ duration: 0.22, gain: 0.34 });
    this.tone({ freq: 220, duration: 0.3, gain: 0.22, type: 'sawtooth', slideTo: 60 });
  }

  /** Проигрыш: затихающий минорный аккорд. */
  gameOver() {
    const now = this.ctx?.currentTime ?? 0;
    const chord = [146.83, 174.61, 220.0];
    chord.forEach((freq, index) => {
      if (!this.ctx || !this.enabled) return;
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(0.16, now + 0.05 + index * 0.06);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);

      osc.connect(env);
      env.connect(this.master);
      osc.start(now);
      osc.stop(now + 2.4);
    });
  }

  /** Тик пульсации: тихий щелчок, частота растёт с набором очков. */
  tick(bpm = 60) {
    const freq = TICK_BASE_HZ + (bpm - 60) * 0.6;
    this.tone({ freq, duration: 0.035, gain: 0.055, type: 'sine' });
  }
}