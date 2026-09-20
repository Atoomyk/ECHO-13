/**
 * Ядро PULSE: правила игры без DOM, браузерных API и таймеров.
 *
 * Симуляция идёт фиксированным шагом: сколько бы времени ни занял кадр рендера,
 * правила видят одинаковые шаги. Благодаря этому партия воспроизводима —
 * один сид и одна последовательность нажатий дают один и тот же результат,
 * что необходимо для ежедневного челленджа.
 *
 * Режим DUAL: два независимых центра (L/R), свои кольца и спавн-потоки,
 * общая энергия игрока.
 */

import {
  CRUSH_RADIUS,
  DAILY_PROFILES,
  DUAL_CENTER_X,
  ESCAPE_REMOVE_RADIUS,
  FIELD_RINGS_MAX,
  GAME_MODE,
  MAX_FRAME_SEC,
  MIN_RING_GAP,
  PLAYER_RADIUS,
  PULSE_REACH,
  SIDE,
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

/** Мировые центры dual. */
export const DUAL_CENTERS = Object.freeze({
  [SIDE.L]: Object.freeze({ x: -DUAL_CENTER_X, y: 0 }),
  [SIDE.R]: Object.freeze({ x: DUAL_CENTER_X, y: 0 }),
});

/**
 * Профиль ежедневного челленджа: ровно один на календарный день UTC.
 * Все игроки получают одинаковые пороги сложности, поэтому сравнение честное.
 * @param {number} [timestampMs]
 * @returns {{name: string, jaggedTimeSec: number, magnetTimeSec: number}}
 */
export function dailyProfile(timestampMs = Date.now()) {
  return DAILY_PROFILES[dayIndex(timestampMs) % DAILY_PROFILES.length];
}

/**
 * Локальное состояние одной стороны dual (или единственной «полосы» single).
 * @param {string|number} seed
 * @returns {object}
 */
function createLane(seed) {
  return {
    random: mulberry32(seed),
    spawnIndex: 0,
    nextSpawnSec: 0,
    fieldTarget: 1,
    targetLevel: 1,
    jaggedStreak: 0,
  };
}

export class PulseGame {
  /**
   * @param {object} [options]
   * @param {string|number} [options.seed] сид партии
   * @param {typeof DEFAULT_PROFILE} [options.profile] пороги сложности
   * @param {boolean} [options.daily] отметить партию как ежедневную
   * @param {string} [options.mode] GAME_MODE.SINGLE | GAME_MODE.DUAL
   */
  constructor({
    seed = 'pulse-free',
    profile = DEFAULT_PROFILE,
    daily = false,
    mode = GAME_MODE.SINGLE,
  } = {}) {
    this.seed = seed;
    this.profile = profile;
    this.daily = daily;
    this.mode = mode === GAME_MODE.DUAL ? GAME_MODE.DUAL : GAME_MODE.SINGLE;

    this.player = new Player();
    /** @type {import('./ring.js').Ring[]} */
    this.rings = [];
    this.phase = PHASE.READY;
    /** События шага: рендер и звук читают их, само ядро ничего не рисует. */
    this.events = [];
    /** Время, ещё не отыгранное целым шагом. */
    this.accumulatorSec = 0;

    /** Single: одна полоса. Dual: L и R. */
    this.lanes = this.buildLanes();
  }

  get isDual() {
    return this.mode === GAME_MODE.DUAL;
  }

  /** @returns {Record<string, object>} */
  buildLanes() {
    if (this.isDual) {
      return {
        [SIDE.L]: createLane(`${this.seed}|L`),
        [SIDE.R]: createLane(`${this.seed}|R`),
      };
    }
    return { _: createLane(this.seed) };
  }

  /** Совместимость: PRNG single (и тесты, читающие game.random). */
  get random() {
    return this.lanes._?.random ?? this.lanes[SIDE.L].random;
  }

  set random(value) {
    if (this.lanes._) this.lanes._.random = value;
  }

  get spawnIndex() {
    return this.lanes._?.spawnIndex ?? 0;
  }

  set spawnIndex(value) {
    if (this.lanes._) this.lanes._.spawnIndex = value;
  }

  get nextSpawnSec() {
    return this.lanes._?.nextSpawnSec ?? 0;
  }

  set nextSpawnSec(value) {
    if (this.lanes._) this.lanes._.nextSpawnSec = value;
  }

  get fieldTarget() {
    return this.lanes._?.fieldTarget ?? this.lanes[SIDE.L]?.fieldTarget ?? 1;
  }

  set fieldTarget(value) {
    if (this.lanes._) this.lanes._.fieldTarget = value;
  }

  get targetLevel() {
    return this.lanes._?.targetLevel ?? this.lanes[SIDE.L]?.targetLevel ?? 1;
  }

  set targetLevel(value) {
    if (this.lanes._) this.lanes._.targetLevel = value;
  }

  get jaggedStreak() {
    return this.lanes._?.jaggedStreak ?? 0;
  }

  set jaggedStreak(value) {
    if (this.lanes._) this.lanes._.jaggedStreak = value;
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
   * @param {string} [laneKey]
   * @returns {number}
   */
  rollSpawnDelay(laneKey = '_') {
    const lane = this.lanes[laneKey] ?? this.lanes._;
    const factor = rangeBetween(lane.random, SPAWN_INTERVAL_JITTER_MIN, SPAWN_INTERVAL_JITTER_MAX);
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

  /**
   * Мировой центр стороны (или origin для single).
   * @param {string|null|undefined} side
   * @returns {{x: number, y: number}}
   */
  centerOf(side) {
    if (!this.isDual || !side) return { x: 0, y: 0 };
    return DUAL_CENTERS[side] ?? { x: 0, y: 0 };
  }

  /**
   * Живые угрозы (отбитые улетают отдельно и не считаются).
   * @param {string|null} [side] фильтр стороны dual
   */
  activeRings(side = null) {
    return this.rings.filter((ring) => {
      if (ring.pushed) return false;
      if (side && ring.side !== side) return false;
      return true;
    });
  }

  /**
   * Случайная цель заполнения поля: целое от 1 до maxFieldRings.
   * @param {string} [laneKey]
   */
  rollFieldTarget(laneKey = '_') {
    const lane = this.lanes[laneKey] ?? this.lanes._;
    const max = this.maxFieldRings;
    return Math.min(max, Math.floor(rangeBetween(lane.random, 1, max + 1)));
  }

  /**
   * Можно ли добавить кольцо с края: есть слот и внешнее уже ушло внутрь на MIN_RING_GAP.
   * @param {string|null} [side]
   * @returns {boolean}
   */
  canSpawnRing(side = null) {
    const laneKey = this.isDual ? side : '_';
    const lane = this.lanes[laneKey];
    if (!lane) return false;

    const active = this.activeRings(this.isDual ? side : null);
    if (active.length >= lane.fieldTarget) return false;
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
      mode: this.mode,
    };
  }

  /** Начать новую партию с тем же сидом (и режимом). */
  start() {
    this.lanes = this.buildLanes();
    this.player = new Player();
    this.rings = [];
    this.accumulatorSec = 0;
    this.events = [];

    if (this.isDual) {
      for (const key of [SIDE.L, SIDE.R]) {
        this.lanes[key].fieldTarget = this.rollFieldTarget(key);
      }
    } else {
      this.lanes._.fieldTarget = this.rollFieldTarget('_');
    }

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
   * Импульс. В single — все кольца в reach; в dual — только сторона `side`.
   * @param {string} [side] 'L' | 'R' (обязателен в dual)
   * @returns {boolean} ушёл ли импульс; false — энергии не хватило / неверная сторона
   */
  pulse(side) {
    if (this.phase !== PHASE.PLAYING) return false;

    if (this.isDual) {
      if (side !== SIDE.L && side !== SIDE.R) return false;
    }

    if (!this.player.spendPulse()) {
      this.events.push({ type: 'weak', energy: this.player.energy, side: side ?? null });
      return false;
    }

    let pushed = 0;
    const burst = [];
    const center = this.centerOf(side);

    for (const ring of this.rings) {
      if (this.isDual && ring.side !== side) continue;
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
        side: ring.side,
        ox: center.x,
        oy: center.y,
      });
    }

    this.events.push({
      type: 'pulse',
      pushed,
      burst,
      energy: this.player.energy,
      multiplier: this.player.multiplier,
      side: side ?? null,
      ox: center.x,
      oy: center.y,
    });

    if (this.isDual) {
      const lane = this.lanes[side];
      lane.nextSpawnSec = 0;
      if (pushed > 0 && this.activeRings(side).length < FIELD_RINGS_MAX) {
        this.spawn(side);
        lane.nextSpawnSec = this.rollSpawnDelay(side);
      } else if (this.activeRings(side).length === 0) {
        this.refillField(1, side);
      }
    } else {
      this.nextSpawnSec = 0;
      if (pushed > 0 && this.activeRings().length < FIELD_RINGS_MAX) {
        this.spawn();
        this.nextSpawnSec = this.rollSpawnDelay('_');
      } else if (this.activeRings().length === 0) {
        this.refillField(1);
      }
    }
    return true;
  }

  /**
   * Прогнать симуляцию за прошедшее время.
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

    if (this.isDual) {
      for (const side of [SIDE.L, SIDE.R]) {
        this.lanes[side].nextSpawnSec -= dt;
        this.refillField(FIELD_RINGS_MAX, side);
      }
    } else {
      this.nextSpawnSec -= dt;
      this.refillField();
    }

    this.resolveContacts();

    this.rings = this.rings.filter((ring) => {
      if (ring.pushed) return ring.radius < ESCAPE_REMOVE_RADIUS;
      return ring.radius > -0.08;
    });

    if (this.phase === PHASE.PLAYING) {
      if (this.isDual) {
        for (const side of [SIDE.L, SIDE.R]) {
          if (this.activeRings(side).length === 0) {
            this.lanes[side].nextSpawnSec = 0;
            this.refillField(1, side);
          }
        }
      } else if (this.activeRings().length === 0) {
        this.nextSpawnSec = 0;
        this.refillField(1);
      }
    }
  }

  /** При смене LV перебрасываем цель заполнения под новый потолок. */
  updateFieldTarget() {
    if (this.isDual) {
      for (const side of [SIDE.L, SIDE.R]) {
        const lane = this.lanes[side];
        if (this.level === lane.targetLevel) continue;
        lane.targetLevel = this.level;
        lane.fieldTarget = this.rollFieldTarget(side);
      }
      return;
    }
    if (this.level === this.targetLevel) return;
    this.targetLevel = this.level;
    this.fieldTarget = this.rollFieldTarget('_');
  }

  /**
   * Добить поле до цели / гарантировать ≥1 угрозу.
   * @param {number} [maxSpawns] лимит за вызов (после импульса — одно)
   * @param {string|null} [side] сторона dual
   */
  refillField(maxSpawns = FIELD_RINGS_MAX, side = null) {
    const laneKey = this.isDual ? side : '_';
    const lane = this.lanes[laneKey];
    if (!lane) return;

    let spawned = 0;
    while (spawned < maxSpawns && this.canSpawnRing(this.isDual ? side : null)) {
      const active = this.activeRings(this.isDual ? side : null).length;
      if (active > 0 && lane.nextSpawnSec > 0) break;
      this.spawn(this.isDual ? side : null);
      spawned += 1;
      lane.nextSpawnSec = this.rollSpawnDelay(laneKey);
    }
  }

  /**
   * Добавить одно одиночное кольцо с края.
   * @param {string|null} [side]
   */
  spawn(side = null) {
    const laneKey = this.isDual ? side : '_';
    const lane = this.lanes[laneKey];
    if (!lane) return;

    if (this.activeRings(this.isDual ? side : null).length === 0) {
      lane.fieldTarget = this.rollFieldTarget(laneKey);
    }

    const ring = createRing({
      random: lane.random,
      index: lane.spawnIndex,
      elapsedSec: this.elapsedSec,
      speedScale: this.speedScale,
      profile: this.profile,
      side: this.isDual ? side : null,
    });

    const inJaggedPhase =
      this.elapsedSec >= this.profile.jaggedTimeSec &&
      this.elapsedSec < this.profile.magnetTimeSec;
    if (inJaggedPhase && ring.kind === RING_KIND.JAGGED && lane.jaggedStreak >= 2) {
      ring.kind = RING_KIND.PLAIN;
      ring.gapAngle = null;
      ring.spin = 0;
      lane.jaggedStreak = 0;
    } else if (ring.kind === RING_KIND.JAGGED) {
      lane.jaggedStreak += 1;
    } else {
      lane.jaggedStreak = 0;
    }

    this.rings.push(ring);
    lane.spawnIndex += 1;
    this.events.push({ type: 'spawn', kind: ring.kind, id: ring.id, side: ring.side });
  }

  /** Разобраться с кольцами у центра: рваные всегда безопасны, plain бьёт. */
  resolveContacts() {
    for (const ring of this.rings) {
      if (ring.resolved) continue;
      if (ring.radius > CRUSH_RADIUS) continue;

      ring.resolved = true;
      const throughGap = ring.kind === RING_KIND.JAGGED || ring.isCleanPass(PLAYER_ANGLE);
      const result = this.player.resolvePass(throughGap);
      const center = this.centerOf(ring.side);

      if (result === 'clean') {
        this.events.push({
          type: 'clean',
          id: ring.id,
          multiplier: this.player.multiplier,
          kind: ring.kind,
          side: ring.side,
          ox: center.x,
          oy: center.y,
        });
      } else if (result === 'crushed') {
        this.events.push({
          type: 'hit',
          id: ring.id,
          energy: this.player.energy,
          kind: ring.kind,
          side: ring.side,
          ox: center.x,
          oy: center.y,
        });
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

  /**
   * Подсказка разрыва по сторонам (dual HUD/рендер).
   * @returns {{L: boolean, R: boolean}|boolean}
   */
  get gapAlignedBySide() {
    if (!this.isDual) return this.gapAligned;
    const result = { [SIDE.L]: false, [SIDE.R]: false };
    for (const side of [SIDE.L, SIDE.R]) {
      for (const ring of this.rings) {
        if (ring.side !== side) continue;
        if (ring.gapAngle === null) continue;
        if (ring.radius > PULSE_REACH * 1.5) continue;
        result[side] = ring.isCleanPass(PLAYER_ANGLE);
        break;
      }
    }
    return result;
  }

  /** Партия окончена: энергия кончилась. */
  finish() {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    this.player.energy = 0;
    this.player.alive = false;
    this.events.push({
      type: 'gameover',
      score: this.score,
      hits: this.player.hits,
      cleanDodges: this.player.cleanDodges,
      elapsedSec: this.elapsedSec,
      mode: this.mode,
    });
  }

  /**
   * Снимок состояния для рендера и HUD.
   * @returns {object}
   */
  snapshot() {
    const centers = this.isDual
      ? {
          [SIDE.L]: { ...DUAL_CENTERS[SIDE.L] },
          [SIDE.R]: { ...DUAL_CENTERS[SIDE.R] },
        }
      : { C: { x: 0, y: 0 } };

    return {
      phase: this.phase,
      mode: this.mode,
      centers,
      elapsedSec: this.elapsedSec,
      score: this.score,
      level: this.level,
      energyRatio: this.player.energyRatio,
      multiplier: this.player.multiplier,
      invulnerable: this.player.invulnerable,
      cleanDodges: this.player.cleanDodges,
      hits: this.player.hits,
      gapAligned: this.gapAligned,
      gapAlignedBySide: this.gapAlignedBySide,
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
        side: ring.side,
      })),
    };
  }
}

/** Радиус точки игрока — используется тестами геометрии столкновений. */
export const PLAYER_HIT_RADIUS = PLAYER_RADIUS;
