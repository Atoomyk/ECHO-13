/**
 * Точка игрока.
 *
 * Игрок не двигается по полю: он всегда в центре и управляет только импульсом.
 * Класс хранит энергию, счёт, множитель и общее время партии — то есть всё,
 * что видно в HUD и что определяет game over.
 */

import {
  CLEAN_MULTIPLIER_MAX,
  CLEAN_MULTIPLIER_STEP,
  ENERGY_MAX,
  ENERGY_REGEN_PER_SEC,
  HIT_DAMAGE,
  HIT_MULTIPLIER_DROP,
  IFRAME_SEC,
  MULTIPLIER_MIN,
  PULSE_COST,
  REGEN_LOCKOUT_SEC,
  SCORE_PER_SEC,
} from './constants.js';

export class Player {
  constructor() {
    this.energy = ENERGY_MAX;
    this.score = 0;
    this.multiplier = 1;
    /** Время с начала партии в секундах. */
    this.elapsedSec = 0;
    /** Секунд неуязвимости осталось. */
    this.invulnerableSec = 0;
    /** Секунд до возобновления восстановления энергии. */
    this.regenLockSec = 0;
    this.alive = true;
    /** Сколько раз кольцо дошло до игрока — для статистики и эмодзи-сетки. */
    this.hits = 0;
    /** Чистые уклонения: разрыв пришёл точно в центр. */
    this.cleanDodges = 0;
  }

  get energyRatio() {
    return this.energy / ENERGY_MAX;
  }

  get invulnerable() {
    return this.invulnerableSec > 0;
  }

  /**
   * Продвинуть состояние игрока на шаг симуляции.
   * @param {number} dt секунды (уже ограничено снаружи)
   */
  update(dt) {
    this.elapsedSec += dt;

    const gained = SCORE_PER_SEC * this.multiplier * dt;
    this.score += gained;

    if (this.regenLockSec > 0) {
      this.regenLockSec = Math.max(0, this.regenLockSec - dt);
    } else {
      this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_REGEN_PER_SEC * dt);
    }

    if (this.invulnerableSec > 0) {
      this.invulnerableSec = Math.max(0, this.invulnerableSec - dt);
    }
  }

  /**
   * Может ли игрок сделать импульс прямо сейчас.
   * @returns {boolean}
   */
  canPulse() {
    return this.alive && this.energy >= PULSE_COST;
  }

  /**
   * Списать стоимость импульса.
   * @returns {boolean} был ли импульс оплачен
   */
  spendPulse() {
    if (!this.canPulse()) return false;
    this.energy -= PULSE_COST;
    this.regenLockSec = REGEN_LOCKOUT_SEC;
    return true;
  }

  /**
   * Касание кольца.
   * @returns {'ignored'|'damaged'|'dead'}
   */
  takeHit() {
    if (!this.alive) return 'ignored';
    if (this.invulnerable) return 'ignored';

    this.hits += 1;
    this.energy -= HIT_DAMAGE;
    this.invulnerableSec = IFRAME_SEC;
    this.multiplier = Math.max(MULTIPLIER_MIN, this.multiplier - HIT_MULTIPLIER_DROP);

    if (this.energy <= 0) {
      this.energy = 0;
      this.alive = false;
      return 'dead';
    }
    return 'damaged';
  }

  /**
   * Кольцо прошло мимо. Разрыв у центра — чистое уклонение, оно поднимает множитель.
   * @param {boolean} throughGap был ли пролёт через разрыв
   * @returns {'clean'|'crushed'}
   */
  resolvePass(throughGap) {
    if (throughGap) {
      this.cleanDodges += 1;
      this.multiplier = Math.min(
        CLEAN_MULTIPLIER_MAX,
        this.multiplier + CLEAN_MULTIPLIER_STEP,
      );
      return 'clean';
    }
    return this.takeHit() === 'ignored' ? 'ignored' : 'crushed';
  }
}