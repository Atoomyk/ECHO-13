/**
 * Кольцо — единственный враг PULSE.
 *
 * Кольцо живёт в полярной системе: положение задаётся радиусом от центра,
 * форма — разрывом (дыркой) определённой ширины. Модуль не знает ни о рендере,
 * ни о вводе: обновляется чистой арифметикой и проверяется тестами.
 */

import {
  BASE_ESCAPE_SPEED,
  DANGER_RADIUS,
  GAP_SPAN,
  GAP_SPIN_PER_SEC,
  RING_THICKNESS_FAR,
  RING_THICKNESS_NEAR,
  SPAWN_RADIUS,
  TRAVEL_MIN_SEC,
  TRAVEL_START_SEC,
  TRAVEL_STEP_SEC,
} from './constants.js';
import { rangeBetween } from './random.js';

/** Типы колец: включаются по мере роста сложности. */
export const RING_KIND = Object.freeze({
  PLAIN: 'plain',
  DOUBLE: 'double',
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
 * Длительность полёта кольца от края до центра для его номера.
 * Скорость растёт ступенями: каждые четыре кольца — на шаг быстрее, до предела.
 * @param {number} index порядковый номер кольца, начиная с 0
 * @returns {number} секунд
 */
export function travelSecondsFor(index) {
  const safe = Math.max(0, Math.floor(index) || 0);
  const step = Math.floor(safe / 4);
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
   */
  constructor({ kind, radius, speed, angle = 0, gapAngle = null, spin = 0 }) {
    this.id = nextId;
    nextId += 1;

    this.kind = kind;
    this.radius = radius;
    this.speed = speed;
    this.angle = angle;
    this.gapAngle = gapAngle;
    this.spin = spin;
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
   * Попадает ли угол в разрыв.
   * @param {number} angle
   * @returns {boolean}
   */
  isInGap(angle) {
    if (this.gapAngle === null) return false;
    return angleDistance(angle, this.gapAngle) <= GAP_SPAN / 2;
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
 * @param {{doubleTimeSec: number, jaggedTimeSec: number, magnetTimeSec: number}} profile
 * @returns {string}
 */
export function pickKind(elapsedSec, profile) {
  if (elapsedSec >= profile.magnetTimeSec) return RING_KIND.MAGNET;
  if (elapsedSec >= profile.jaggedTimeSec) return RING_KIND.JAGGED;
  if (elapsedSec >= profile.doubleTimeSec) return RING_KIND.DOUBLE;
  return RING_KIND.PLAIN;
}

/**
 * Преобразовать прицельный угол кольца в разрыв, который придёт в центр.
 *
 * Разрыв кружится вместе с кольцом, поэтому наводим его так, чтобы через
 * `leadSec` секунд он оказался напротив игрока.
 *
 * @param {number} radius текущий радиус
 * @param {number} speed скорость сближения
 * @param {number} spin угловая скорость разрыва
 * @param {number} playerAngle угол игрока
 * @param {number} leadSec окно наведения
 * @returns {number} целевой угол разрыва
 */
export function aimGapAtPlayer(radius, speed, spin, playerAngle, leadSec) {
  const eta = radius / Math.max(0.0001, speed);
  const lead = Math.min(eta, leadSec);
  return normalizeAngle(playerAngle - lead * spin);
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
 * @param {{doubleTimeSec: number, jaggedTimeSec: number, magnetTimeSec: number}} options.profile
 * @returns {Ring}
 */
export function createRing({ random, index, elapsedSec, speedScale, profile }) {
  // Скорость кольца колеблется вокруг общего расписания: ±12% от сида.
  // Без этого разброса все партии одного сида проходили бы одинаково,
  // и ежедневный челлендж не отличался бы день ото дня.
  const baseTravel = travelSecondsFor(index) / Math.max(0.2, speedScale);
  const jitter = 0.88 + random() * 0.24;
  const travel = baseTravel * jitter;
  const speed = SPAWN_RADIUS / travel;
  const kind = pickKind(elapsedSec, profile);

  const hasGap = kind !== RING_KIND.PLAIN;
  const spinDir = random() < 0.5 ? -1 : 1;
  const spin = hasGap ? rangeBetween(random, 0.7, 1.4) * GAP_SPIN_PER_SEC * spinDir : 0;

  // Разрыв рождается вдали от игрока, иначе кольцо влетало бы в центр уже открытым,
  // и первый удар можно было бы не отрабатывать вовсе. Смещение откладывается
  // от направления, противоположного игроку, поэтому знак вращения на него не влияет.
  const offset = 0.6 + random() * 1.9;
  const gapAngle = hasGap ? normalizeAngle(Math.PI + offset * spinDir) : null;

  return new Ring({
    kind,
    radius: SPAWN_RADIUS,
    speed,
    angle: rangeBetween(random, 0, Math.PI * 2),
    gapAngle,
    spin,
  });
}