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
  FIELD_RINGS_MAX,
  MAX_FRAME_SEC,
  MIN_RING_GAP,
  PLAYER_RADIUS,
  PULSE_REACH,
  SPAWN_INTERVAL_JITTER_MAX,
  SPAWN_INTERVAL_JITTER_MIN,
  SPAWN_INTERVAL_MIN_SEC,
  SPAWN_INTERVAL_START_SEC,
  SPAWN_INTERVAL_STEP_SEC,
  SPAWN_RADIUS,
} from './constants.js';
import { Player } from './player.js';
import { createRing, RING_KIND } from './ring.js';
import { dayIndex, mulberry32, rangeBetween } from './random.js';

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
  jaggedTimeSec: 55,
  magnetTimeSec: 100,
});

/** Игрок всегда стоит в центре; его угол задаёт только геометрию разрыва. */
const PLAYER_ANGLE = 0;

/**
 * Профиль ежедневного челленджа: ровно один на календарный день UTC.
 * Все игроки получают одинаковые пороги сложности, поэтому сравнение честное.
 * @param {number} [timestampMs]
 * @returns {{name: string, jaggedTimeSec: number, magnetTimeSec: number}}
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
    /** Сколько угроз держим на поле (1…max); перебрасывается при пустом поле и смене LV. */
    this.fieldTarget = 1;
    this.targetLevel = 1;
    /** Подряд идущие jagged — чтобы не забить поле одними дырками. */
    this.jaggedStreak = 0;
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

  /**
   * Пауза до следующего спавна: база × разброс от сида.
   * @returns {number}
   */
  rollSpawnDelay() {
    const factor = rangeBetween(this.random, SPAWN_INTERVAL_JITTER_MIN, SPAWN_INTERVAL_JITTER_MAX);
    const floor = SPAWN_INTERVAL_MIN_SEC * 0.55;
    return Math.max(floor, this.spawnIntervalSec * factor);
  }

  /** Общий ускоритель: каждые 30 секунд кольца приходят на 10% быстрее. */
  get speedScale() {
    return 1 + Math.floor(this.elapsedSec / 30) * 0.1;
  }

  /** Уровень скорости для HUD: 1 на старте, +1 каждые 30 секунд. */
  get level() {
    return Math.floor(this.elapsedSec / 30) + 1;
  }

  /** Верхняя граница числа угроз на поле: LV1→2 … LV4+→5. */
  get maxFieldRings() {
    return Math.min(FIELD_RINGS_MAX, this.level + 1);
  }

  /** Живые угрозы (отбитые улетают отдельно и не считаются). */
  activeRings() {
    return this.rings.filter((ring) => !ring.pushed);
  }

  /** Случайная цель заполнения поля: целое от 1 до maxFieldRings. */
  rollFieldTarget() {
    const max = this.maxFieldRings;
    return Math.min(max, Math.floor(rangeBetween(this.random, 1, max + 1)));
  }

  /**
   * Можно ли добавить кольцо с края: есть слот и внешнее уже ушло внутрь на MIN_RING_GAP.
   * @returns {boolean}
   */
  canSpawnRing() {
    const active = this.activeRings();
    if (active.length >= this.fieldTarget) return false;
    if (active.length === 0) return true;
    const outer = Math.max(...active.map((ring) => ring.radius));
    return outer <= SPAWN_RADIUS - MIN_RING_GAP;
  }

  /** Сложность, достигнутая за партию — для HUD и для эмодзи-сетки. */
  get difficulty() {
    return {
      level: this.level,
      speed: this.speedScale,
      spawnIntervalSec: this.spawnIntervalSec,
      fieldTarget: this.fieldTarget,
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
    this.targetLevel = 1;
    this.fieldTarget = this.rollFieldTarget();
    this.jaggedStreak = 0;
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

    // Сразу следующее с края после отбоя — даже если слоты ещё «плотные».
    this.nextSpawnSec = 0;
    if (pushed > 0 && this.activeRings().length < FIELD_RINGS_MAX) {
      this.spawn();
      this.nextSpawnSec = this.rollSpawnDelay();
    } else if (this.activeRings().length === 0) {
      this.refillField(1);
    }
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

    this.updateFieldTarget();
    this.nextSpawnSec -= dt;
    this.refillField();

    this.resolveContacts();

    // Отбитое кольцо удаляется, едва покинув кадр: держать его в массиве
    // до центра незачем — оно уже не угроза и только копило бы объекты.
    this.rings = this.rings.filter((ring) => {
      if (ring.pushed) return ring.radius < ESCAPE_REMOVE_RADIUS;
      return ring.radius > -0.08;
    });

    // После удаления crush/escape снова добираем поле — экран не пустеет.
    if (this.activeRings().length === 0 && this.phase === PHASE.PLAYING) {
      this.nextSpawnSec = 0;
      this.refillField(1);
    }
  }

  /** При смене LV перебрасываем цель заполнения под новый потолок. */
  updateFieldTarget() {
    if (this.level === this.targetLevel) return;
    this.targetLevel = this.level;
    this.fieldTarget = this.rollFieldTarget();
  }

  /**
   * Добить поле до цели / гарантировать ≥1 угрозу.
   * @param {number} [maxSpawns] лимит за вызов (после импульса — одно)
   */
  refillField(maxSpawns = FIELD_RINGS_MAX) {
    let spawned = 0;
    while (spawned < maxSpawns && this.canSpawnRing()) {
      const active = this.activeRings().length;
      // Пустое поле — всегда сразу; иначе ждём интервал (ритм с джиттером).
      if (active > 0 && this.nextSpawnSec > 0) break;
      this.spawn();
      spawned += 1;
      this.nextSpawnSec = this.rollSpawnDelay();
    }
  }

  /** Добавить одно одиночное кольцо с края. */
  spawn() {
    if (this.activeRings().length === 0) {
      this.fieldTarget = this.rollFieldTarget();
    }

    const ring = createRing({
      random: this.random,
      index: this.spawnIndex,
      elapsedSec: this.elapsedSec,
      speedScale: this.speedScale,
      profile: this.profile,
    });

    // В фазе jagged не даём серии из 3+ рваных подряд — иначе на поле остаются одни дырки.
    const inJaggedPhase =
      this.elapsedSec >= this.profile.jaggedTimeSec &&
      this.elapsedSec < this.profile.magnetTimeSec;
    if (inJaggedPhase && ring.kind === RING_KIND.JAGGED && this.jaggedStreak >= 2) {
      ring.kind = RING_KIND.PLAIN;
      ring.gapAngle = null;
      ring.spin = 0;
      this.jaggedStreak = 0;
    } else if (ring.kind === RING_KIND.JAGGED) {
      this.jaggedStreak += 1;
    } else {
      this.jaggedStreak = 0;
    }

    this.rings.push(ring);
    this.spawnIndex += 1;
    this.events.push({ type: 'spawn', kind: ring.kind, id: ring.id });
  }

  /** Разобраться с кольцами у центра: рваные всегда безопасны, plain бьёт. */
  resolveContacts() {
    for (const ring of this.rings) {
      // Каждое кольцо обрабатывается ровно один раз: без метки оно успевало
      // ударить второй раз после окончания неуязвимости, пока оставалось в центре.
      if (ring.resolved) continue;
      if (ring.radius > CRUSH_RADIUS) continue;

      ring.resolved = true;
      // Рваное никогда не ранит — даже при «попадании в обод».
      const throughGap = ring.kind === RING_KIND.JAGGED || ring.isCleanPass(PLAYER_ANGLE);
      const result = this.player.resolvePass(throughGap);

      if (result === 'clean') {
        this.events.push({ type: 'clean', id: ring.id, multiplier: this.player.multiplier, kind: ring.kind });
      } else if (result === 'crushed') {
        this.events.push({ type: 'hit', id: ring.id, energy: this.player.energy, kind: ring.kind });
      }
    }

    if (!this.player.alive) this.finish();
  }

  /**
   * Разрыв ближайшего рваного кольца смотрит в центр — подсказка для новичка.
   * @returns {boolean}
   */
  get gapAligned() {
    for (const ring of this.rings) {
      if (ring.gapAngle === null) continue;
      if (ring.radius > PULSE_REACH * 1.5) continue;
      return ring.isCleanPass(PLAYER_ANGLE);
    }
    return false;
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
