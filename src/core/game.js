/**
 * Ядро PULSE: правила игры без DOM, браузерных API и таймеров.
 *
 * Симуляция идёт фиксированным шагом: сколько бы времени ни занял кадр рендера,
 * правила видят одинаковые шаги. Благодаря этому партия воспроизводима —
 * один сид и одна последовательность нажатий дают один и тот же результат,
 * что необходимо для ежедневного челленджа.
 */

import {
  CRUSH_RADIUS,
  DAILY_PROFILES,
  ESCAPE_REMOVE_RADIUS,
  MAX_FRAME_SEC,
  PLAYER_RADIUS,
  PULSE_REACH,
  SPAWN_INTERVAL_MIN_SEC,
  SPAWN_INTERVAL_START_SEC,
  SPAWN_INTERVAL_STEP_SEC,
} from './constants.js';
import { Player } from './player.js';
import { createRing, RING_KIND } from './ring.js';
import { dayIndex, mulberry32 } from './random.js';

/** Фиксированный шаг симуляции: 120 Гц — с запасом к 60 FPS на телефонах. */
export const STEP_SEC = 1 / 120;

/** Состояния партии. */
export const PHASE = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
});

/** Пресет по умолчанию: свободная игра без общего сида. */
export const DEFAULT_PROFILE = Object.freeze({
  name: 'СВОБОДНАЯ',
  doubleTimeSec: 60,
  jaggedTimeSec: 90,
  magnetTimeSec: 120,
});

/** Отставание второго слоя двойного кольца, в секундах. */
const DOUBLE_STAGGER_SEC = 0.55;

/** Игрок всегда стоит в центре; его угол задаёт только геометрию разрыва. */
const PLAYER_ANGLE = 0;

/**
 * Профиль ежедневного челленджа: ровно один на календарный день UTC.
 * Все игроки получают одинаковые пороги сложности, поэтому сравнение честное.
 * @param {number} [timestampMs]
 * @returns {{name: string, doubleTimeSec: number, jaggedTimeSec: number, magnetTimeSec: number}}
 */
export function dailyProfile(timestampMs = Date.now()) {
  return DAILY_PROFILES[dayIndex(timestampMs) % DAILY_PROFILES.length];
}

export class PulseGame {
  /**
   * @param {object} [options]
   * @param {string|number} [options.seed] сид партии
   * @param {typeof DEFAULT_PROFILE} [options.profile] пороги сложности
   * @param {boolean} [options.daily] отметить партию как ежедневную
   */
  constructor({ seed = 'pulse-free', profile = DEFAULT_PROFILE, daily = false } = {}) {
    this.seed = seed;
    this.profile = profile;
    this.daily = daily;

    this.random = mulberry32(seed);
    this.player = new Player();
    /** @type {import('./ring.js').Ring[]} */
    this.rings = [];
    this.phase = PHASE.READY;
    this.spawnIndex = 0;
    this.nextSpawnSec = 0;
    /** События шага: рендер и звук читают их, само ядро ничего не рисует. */
    this.events = [];
    /** Время, ещё не отыгранное целым шагом. */
    this.accumulatorSec = 0;
  }

  /** Секунды партии — то, что видит игрок в HUD. */
  get elapsedSec() {
    return this.player.elapsedSec;
  }

  /** Очки округляются только при чтении: копить дробь точнее. */
  get score() {
    return Math.floor(this.player.score);
  }

  /** Интервал появления колец: с ростом сложности укорачивается до предела. */
  get spawnIntervalSec() {
    const reduced = SPAWN_INTERVAL_START_SEC - Math.floor(this.elapsedSec / 20) * SPAWN_INTERVAL_STEP_SEC;
    return Math.max(SPAWN_INTERVAL_MIN_SEC, reduced);
  }

  /** Общий ускоритель: каждые 30 секунд кольца приходят на 10% быстрее. */
  get speedScale() {
    return 1 + Math.floor(this.elapsedSec / 30) * 0.1;
  }

  /** Уровень скорости для HUD: 1 на старте, +1 каждые 30 секунд. */
  get level() {
    return Math.floor(this.elapsedSec / 30) + 1;
  }

  /** Сложность, достигнутая за партию — для HUD и для эмодзи-сетки. */
  get difficulty() {
    return {
      level: this.level,
      speed: this.speedScale,
      spawnIntervalSec: this.spawnIntervalSec,
      double: this.profile.doubleTimeSec,
      jagged: this.profile.jaggedTimeSec,
      magnet: this.profile.magnetTimeSec,
    };
  }

  /** Начать новую партию с тем же сидом. */
  start() {
    this.random = mulberry32(this.seed);
    this.player = new Player();
    this.rings = [];
    this.spawnIndex = 0;
    this.nextSpawnSec = 0;
    this.accumulatorSec = 0;
    this.events = [];
    this.phase = PHASE.PLAYING;
  }

  /** Пауза: время просто не идёт, состояние колец сохраняется. */
  pause() {
    if (this.phase === PHASE.PLAYING) this.phase = PHASE.PAUSED;
  }

  resume() {
    if (this.phase === PHASE.PAUSED) this.phase = PHASE.PLAYING;
  }

  togglePause() {
    if (this.phase === PHASE.PLAYING) this.pause();
    else if (this.phase === PHASE.PAUSED) this.resume();
  }

  /**
   * Игрок нажал единственную кнопку.
   * @returns {boolean} ушёл ли импульс; false — энергии не хватило
   */
  pulse() {
    if (this.phase !== PHASE.PLAYING) return false;
    if (!this.player.spendPulse()) {
      this.events.push({ type: 'weak', energy: this.player.energy });
      return false;
    }

    let pushed = 0;
    // Геометрия разрушенных колец уезжает в событие: рендер рисует взрыв,
    // не заглядывая в живые кольца и не влияя на правила.
    const burst = [];

    for (const ring of this.rings) {
      if (ring.radius > PULSE_REACH) continue;
      if (ring.push() !== 'pushed') continue;

      pushed += 1;
      burst.push({
        id: ring.id,
        kind: ring.kind,
        radius: ring.radius,
        angle: ring.angle,
        gapAngle: ring.gapAngle,
        thickness: ring.thickness,
      });
    }

    this.events.push({
      type: 'pulse',
      pushed,
      burst,
      energy: this.player.energy,
      multiplier: this.player.multiplier,
    });
    return true;
  }

  /**
   * Прогнать симуляцию за прошедшее время.
   *
   * Длинные пропуски (вкладка была свёрнута) ограничиваются, чтобы игра не
   * проскочила кольца рывком и не убила игрока без его участия.
   *
   * @param {number} deltaSec время с предыдущего вызова
   * @returns {Array<object>} события, случившиеся за это время
   */
  advance(deltaSec) {
    if (this.phase !== PHASE.PLAYING) return [];

    this.accumulatorSec += Math.min(Math.max(deltaSec, 0), MAX_FRAME_SEC);

    let guard = 0;
    while (this.accumulatorSec >= STEP_SEC && this.phase === PHASE.PLAYING && guard < 60) {
      this.accumulatorSec -= STEP_SEC;
      this.step(STEP_SEC);
      guard += 1;
    }

    const events = this.events;
    this.events = [];
    return events;
  }

  /**
   * Один фиксированный шаг правил.
   * @param {number} dt
   */
  step(dt) {
    this.player.update(dt);
    if (!this.player.alive) {
      this.finish();
      return;
    }

    for (const ring of this.rings) ring.update(dt);

    this.nextSpawnSec -= dt;
    if (this.nextSpawnSec <= 0) {
      this.spawn();
      this.nextSpawnSec = this.spawnIntervalSec;
    }

    this.resolveContacts();

    // Отбитое кольцо удаляется, едва покинув кадр: держать его в массиве
    // до центра незачем — оно уже не угроза и только копило бы объекты.
    this.rings = this.rings.filter((ring) => {
      if (ring.pushed) return ring.radius < ESCAPE_REMOVE_RADIUS;
      return ring.radius > -0.08;
    });
  }

  /** Добавить очередное кольцо — и второй слой, если сложность уже двойная. */
  spawn() {
    const ring = createRing({
      random: this.random,
      index: this.spawnIndex,
      elapsedSec: this.elapsedSec,
      speedScale: this.speedScale,
      profile: this.profile,
    });

    this.rings.push(ring);

    if (ring.kind === RING_KIND.DOUBLE) {
      const partner = createRing({
        random: this.random,
        index: this.spawnIndex + 15,
        elapsedSec: this.elapsedSec,
        speedScale: this.speedScale,
        profile: this.profile,
      });
      // Второй слой отстаёт по радиусу, но сохраняет собственный разрыв:
      // два разрыва подряд не должны открывать бесплатный коридор.
      partner.radius = ring.radius + ring.speed * DOUBLE_STAGGER_SEC;
      partner.kind = RING_KIND.DOUBLE;
      partner.gapAngle = ring.gapAngle === null ? null : ring.gapAngle + Math.PI / 2;
      partner.spin = ring.spin;
      this.rings.push(partner);
    }

    this.spawnIndex += 1;
    this.events.push({ type: 'spawn', kind: ring.kind, id: ring.id });
  }

  /** Разобраться с кольцами, дошедшими до центра: пролёт сквозь разрыв или удар. */
  resolveContacts() {
    for (const ring of this.rings) {
      // Каждое кольцо обрабатывается ровно один раз: без метки оно успевало
      // ударить второй раз после окончания неуязвимости, пока оставалось в центре.
      if (ring.resolved) continue;
      if (ring.radius > CRUSH_RADIUS) continue;

      ring.resolved = true;
      const throughGap = ring.isInGap(PLAYER_ANGLE);
      const result = this.player.resolvePass(throughGap);

      if (result === 'clean') {
        this.events.push({ type: 'clean', id: ring.id, multiplier: this.player.multiplier, kind: ring.kind });
      } else if (result === 'crushed') {
        this.events.push({ type: 'hit', id: ring.id, energy: this.player.energy, kind: ring.kind });
      }
    }

    if (!this.player.alive) this.finish();
  }

  /** Партия окончена: энергия кончилась. */
  finish() {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    // Смерть фиксируется ровно на нуле: иначе между ударом и сменой фазы
    // успевает набежать восстановление и HUD показывает остаток.
    this.player.energy = 0;
    this.player.alive = false;
    this.events.push({
      type: 'gameover',
      score: this.score,
      hits: this.player.hits,
      cleanDodges: this.player.cleanDodges,
      elapsedSec: this.elapsedSec,
    });
  }

  /**
   * Разрыв ближайшего рваного кольца смотрит в центр — подсказка для новичка.
   * @returns {boolean}
   */
  get gapAligned() {
    for (const ring of this.rings) {
      if (ring.gapAngle === null) continue;
      if (ring.radius > PULSE_REACH * 1.5) continue;
      return ring.isInGap(PLAYER_ANGLE);
    }
    return false;
  }

  /**
   * Снимок состояния для рендера и HUD.
   *
   * Возвращаются копии примитивов, а не ссылки на живые кольца: рендер
   * не может случайно повлиять на правила.
   *
   * @returns {object}
   */
  snapshot() {
    return {
      phase: this.phase,
      elapsedSec: this.elapsedSec,
      score: this.score,
      level: this.level,
      energyRatio: this.player.energyRatio,
      multiplier: this.player.multiplier,
      invulnerable: this.player.invulnerable,
      cleanDodges: this.player.cleanDodges,
      hits: this.player.hits,
      gapAligned: this.gapAligned,
      rings: this.rings.map((ring) => ({
        id: ring.id,
        kind: ring.kind,
        radius: ring.radius,
        angle: ring.angle,
        gapAngle: ring.gapAngle,
        spin: ring.spin,
        spinning: ring.spin !== 0,
        pulling: ring.pulling,
        pushed: ring.pushed,
        thickness: ring.thickness,
      })),
    };
  }
}

/** Радиус точки игрока — используется тестами геометрии столкновений. */
export const PLAYER_HIT_RADIUS = PLAYER_RADIUS;