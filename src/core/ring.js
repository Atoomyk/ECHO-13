/**
 * Кольцо — единственный враг PULSE.
 *
 * Кольцо живёт в полярной системе: положение задаётся радиусом от центра,
 * форма — разрывом (дыркой) определённой ширины. Модуль не знает ни о рендере,
 * ни о вводе: обновляется чистой арифметикой и проверяется тестами.
 */

import {
  BASE_ESCAPE_SPEED,
  CLEAN_WINDOW_RAD,
  DANGER_RADIUS,
  EARLY_GAP_MIX_CHANCE,
  EARLY_GAP_MIX_SEC,
  GAP_AIM_LEAD_SEC,
  GAP_SPAN,
  GAP_SPIN_PER_SEC,
  JAGGED_PHASE_CHANCE,
  RING_THICKNESS_FAR,
  RING_THICKNESS_NEAR,
  SPAWN_RADIUS,
  TRAVEL_JITTER_MAX,
  TRAVEL_JITTER_MIN,
  TRAVEL_LEVEL_SEC,
  TRAVEL_MIN_SEC,
  TRAVEL_START_SEC,
  TRAVEL_STEP_SEC,
} from './constants.js';
import { rangeBetween } from './random.js';

/** Типы колец: включаются по мере роста сложности. */
export const RING_KIND = Object.freeze({
  PLAIN: 'plain',
  JAGGED: 'jagged',
  MAGNET: 'magnet',
});

/** Радиус, с которого магнит начинает тянуть: до него кольцо ведёт себя обычно. */
export const MAGNET_TURN_RADIUS = 0.45;
/** Ускорение притяжения: кольцо внутри зоны магнита идёт быстрее. */
export const MAGNET_PULL = 1.6;

let nextId = 1;

/** Сбросить счётчик идентификаторов (нужно тестам для стабильных снапшотов). */
export function resetRingIds() {
  nextId = 1;
}

/**
 * Привести угол к [0, 2π).
 * @param {number} angle
 * @returns {number}
 */
export function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

/**
 * Наименьшая угловая разница между двумя углами.
 * @param {number} a
 * @param {number} b
 * @returns {number} значение в [0, π]
 */
export function angleDistance(a, b) {
  const diff = normalizeAngle(a - b);
  return diff > Math.PI ? Math.PI * 2 - diff : diff;
}

/**
 * Длительность полёта кольца от края до центра по времени партии.
 * Ступени совпадают с LV (каждые TRAVEL_LEVEL_SEC): клики не разгоняют очередь.
 * @param {number} elapsedSec секунды с начала партии
 * @returns {number} секунд
 */
export function travelSecondsFor(elapsedSec) {
  const safe = Math.max(0, Number(elapsedSec) || 0);
  const step = Math.floor(safe / TRAVEL_LEVEL_SEC);
  return Math.max(TRAVEL_MIN_SEC, TRAVEL_START_SEC - step * TRAVEL_STEP_SEC);
}

/**
 * Толщина кольца в мировых единицах: у центра оно толще — визуальный сигнал опасности.
 * @param {number} radius
 * @returns {number}
 */
export function thicknessFor(radius) {
  const ratio = Math.min(1, Math.max(0, 1 - radius / DANGER_RADIUS));
  return RING_THICKNESS_FAR + (RING_THICKNESS_NEAR - RING_THICKNESS_FAR) * ratio;
}

export class Ring {
  /**
   * @param {object} options
   * @param {string} options.kind тип кольца
   * @param {number} options.radius стартовый радиус
   * @param {number} options.speed модуль скорости, единиц в секунду
   * @param {number} [options.angle] фаза кольца
   * @param {number|null} [options.gapAngle] центр разрыва, null — кольцо сплошное
   * @param {number} [options.spin] угловая скорость разрыва
   * @param {string|null} [options.side] сторона dual ('L'|'R'), null в single
   */
  constructor({ kind, radius, speed, angle = 0, gapAngle = null, spin = 0, side = null }) {
    this.id = nextId;
    nextId += 1;

    this.kind = kind;
    this.radius = radius;
    this.speed = speed;
    this.angle = angle;
    this.gapAngle = gapAngle;
    this.spin = spin;
    /** @type {string|null} */
    this.side = side;
    this.alive = true;
    /** Магнит уже начал тянуть — влияет на отрисовку и подсказки. */
    this.pulling = false;
    /** Кольцо уже рассчитано у центра: повторный удар невозможен. */
    this.resolved = false;
    /** Кольцо уже отброшено: импульс тратится только один раз. */
    this.pushed = false;
    /** Скорость отлёта наружу: задаётся в момент отброса. */
    this.escapeSpeed = 0;
  }

  /** Толщина кольца на текущем радиусе. */
  get thickness() {
    return thicknessFor(this.radius);
  }

  /**
   * Точка на кольце по углу — нужна рендеру и тестам геометрии.
   * @param {number} angle
   * @returns {{x: number, y: number}}
   */
  pointAt(angle) {
    return { x: Math.cos(angle) * this.radius, y: Math.sin(angle) * this.radius };
  }

  /**
   * Попадает ли угол в видимый разрыв кольца.
   * @param {number} angle
   * @returns {boolean}
   */
  isInGap(angle) {
    if (this.gapAngle === null) return false;
    return angleDistance(angle, this.gapAngle) <= GAP_SPAN / 2;
  }

  /**
   * Чистый пролёт: разрыв у игрока в более широком окне, чем видимая щель.
   * @param {number} angle
   * @returns {boolean}
   */
  isCleanPass(angle) {
    if (this.gapAngle === null) return false;
    return angleDistance(angle, this.gapAngle) <= CLEAN_WINDOW_RAD;
  }

  /**
   * Накрывает ли кольцо точку в полярных координатах.
   * @param {number} r радиус точки
   * @param {number} angle угол точки
   * @param {number} [slack] допуск сверх половины толщины
   * @returns {boolean}
   */
  covers(r, angle, slack = 0) {
    if (Math.abs(r - this.radius) > this.thickness / 2 + slack) return false;
    return !this.isInGap(angle);
  }

  /**
   * Продвинуть кольцо по времени.
   * @param {number} dt секунды
   */
  update(dt) {
    // Отбитое кольцо летит только наружу и гаснет за пределами поля.
    // Без этого оно тормозило, разворачивалось и снова шло к центру,
    // из-за чего отброс не убирал кольцо, а лишь откладывал его.
    if (this.pushed) {
      this.radius += this.escapeSpeed * dt;
      return;
    }

    let speed = this.speed;
    if (this.kind === RING_KIND.MAGNET && this.radius < MAGNET_TURN_RADIUS) {
      this.pulling = true;
      speed = this.speed * MAGNET_PULL;
    }
    this.radius -= speed * dt;
    if (this.gapAngle !== null && this.spin !== 0) {
      this.gapAngle = normalizeAngle(this.gapAngle + this.spin * dt);
    }
  }

  /**
   * Оттолкнуть кольцо импульсом ровно один раз.
   *
   * Импульс не просто сдвигает кольцо наружу, а разворачивает его: дальше оно
   * уходит только от центра и удаляется, едва покинув кадр. Так одно нажатие
   * действительно убирает угрозу, а не отсрочивает её.
   *
   * @returns {'pushed'|'already'}
   */
  push() {
    if (this.pushed) return 'already';
    this.pushed = true;
    this.resolved = true;
    // Скорость отлёта чуть выше скорости подлёта: кольцо быстро покидает кадр.
    this.escapeSpeed = Math.max(this.speed * 1.4, BASE_ESCAPE_SPEED);
    return 'pushed';
  }
}

/**
 * Какой тип кольца положен на этой секунде партии.
 * @param {number} elapsedSec
 * @param {{jaggedTimeSec: number, magnetTimeSec: number, earlyGapMixChance?: number, jaggedPhaseChance?: number}} profile
 * @param {(() => number)|null} [random] seeded PRNG; без него миксы не бросаются
 * @returns {string}
 */
export function pickKind(elapsedSec, profile, random = null) {
  if (elapsedSec >= profile.magnetTimeSec) return RING_KIND.MAGNET;

  if (elapsedSec >= profile.jaggedTimeSec) {
    // Фаза jagged: микс рваных и целых, не 100% дырок.
    const chance =
      typeof profile.jaggedPhaseChance === 'number'
        ? profile.jaggedPhaseChance
        : JAGGED_PHASE_CHANCE;
    if (!random) return RING_KIND.JAGGED;
    return random() < chance ? RING_KIND.JAGGED : RING_KIND.PLAIN;
  }

  // Лёгкий микс: часть plain заменяем на jagged до порога jaggedTimeSec.
  const mixChance =
    typeof profile.earlyGapMixChance === 'number'
      ? profile.earlyGapMixChance
      : EARLY_GAP_MIX_CHANCE;
  const mixFrom = Math.min(EARLY_GAP_MIX_SEC, profile.jaggedTimeSec * 0.45);
  if (mixChance > 0 && random && elapsedSec >= mixFrom && random() < mixChance) {
    return RING_KIND.JAGGED;
  }
  return RING_KIND.PLAIN;
}

/**
 * Навести разрыв так, чтобы за `leadSec` до центра он смотрел на игрока.
 *
 * К моменту crush разрыв ещё чуть проворачивается, но остаётся в CLEAN_WINDOW
 * при типичном spin — чистое уклонение читается глазом, а не выпадает лотереей.
 *
 * @param {number} radius текущий радиус
 * @param {number} speed скорость сближения
 * @param {number} spin угловая скорость разрыва
 * @param {number} playerAngle угол игрока
 * @param {number} leadSec насколько раньше центра совмещаем разрыв
 * @returns {number} стартовый угол разрыва
 */
export function aimGapAtPlayer(radius, speed, spin, playerAngle, leadSec) {
  const eta = radius / Math.max(0.0001, speed);
  const early = Math.min(Math.max(0, leadSec), eta);
  return normalizeAngle(playerAngle - (eta - early) * spin);
}

/**
 * Собрать новое кольцо под текущую сложность.
 *
 * Тип выбирается по времени партии, но скорость, фаза и разброс — от seeded PRNG,
 * поэтому весь паттерн воспроизводится по одному сиду у всех игроков.
 *
 * @param {object} options
 * @param {() => number} options.random seeded PRNG партии
 * @param {number} options.index порядковый номер кольца
 * @param {number} options.elapsedSec сколько секунд идёт партия
 * @param {number} options.speedScale общий ускоритель прогрессии
 * @param {{jaggedTimeSec: number, magnetTimeSec: number}} options.profile
 * @param {string|null} [options.side] сторона dual
 * @returns {Ring}
 */
export function createRing({ random, index, elapsedSec, speedScale, profile, side = null }) {
  // База от времени/LV (+ speedScale), не от index — импульсы не разгоняют очередь.
  const baseTravel = travelSecondsFor(elapsedSec) / Math.max(0.2, speedScale);
  const jitter = rangeBetween(random, TRAVEL_JITTER_MIN, TRAVEL_JITTER_MAX);
  const travel = baseTravel * jitter;
  const speed = SPAWN_RADIUS / travel;
  const kind = pickKind(elapsedSec, profile, random);

  // Разрыв только у jagged. Magnet — сплошной, но тянет (визуально другой тип).
  const hasGap = kind === RING_KIND.JAGGED;
  const spinDir = random() < 0.5 ? -1 : 1;
  const spin = hasGap ? rangeBetween(random, 0.7, 1.4) * GAP_SPIN_PER_SEC * spinDir : 0;

  // Разрыв наводим на подлёт: на старте он не смотрит в игрока, а к зоне
  // опасности выходит в читаемое окно. Небольшой дрожащий сдвиг — чтобы
  // «всегда не жать» не было бесплатной стратегией.
  const aim = hasGap
    ? aimGapAtPlayer(SPAWN_RADIUS, speed, spin, 0, GAP_AIM_LEAD_SEC)
    : null;
  const aimJitter = hasGap ? rangeBetween(random, -0.1, 0.1) : 0;
  const gapAngle = aim === null ? null : normalizeAngle(aim + aimJitter);

  return new Ring({
    kind,
    radius: SPAWN_RADIUS,
    speed,
    angle: rangeBetween(random, 0, Math.PI * 2),
    gapAngle,
    spin,
    side,
  });
}