/**
 * Вход на сайт: пароль из env, lockout по IP, одноразовые токены сессии.
 * Без DOM — проверяется тестами.
 */

import crypto from 'node:crypto';

import { HttpError } from './app.js';

export const GATE_MAX_ATTEMPTS = 3;
export const GATE_LOCK_MS = 5 * 60 * 1000;
export const GATE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Сравнение строк без утечки по времени (насколько позволяет Node).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualText(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim().slice(0, 64);
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

export class SiteGate {
  /**
   * @param {object} options
   * @param {string} options.password
   * @param {() => number} [options.now]
   */
  constructor({ password, now = () => Date.now() }) {
    this.password = String(password ?? '');
    this.now = now;
    /** @type {Map<string, {fails: number, lockedUntil: number}>} */
    this.attempts = new Map();
    /** @type {Map<string, number>} token → expiresAt */
    this.tokens = new Map();
  }

  /** Нужен ли вход (пустой пароль в env — gate выключен). */
  get enabled() {
    return this.password.length > 0;
  }

  /**
   * @param {string} ip
   * @returns {{locked: boolean, retryAfterSec: number, fails: number}}
   */
  status(ip) {
    this.prune();
    const row = this.attempts.get(ip);
    if (!row) return { locked: false, retryAfterSec: 0, fails: 0 };
    const wait = row.lockedUntil - this.now();
    if (wait > 0) {
      return { locked: true, retryAfterSec: Math.ceil(wait / 1000), fails: row.fails };
    }
    if (row.lockedUntil > 0) {
      // Блокировка истекла — даём новую серию попыток.
      this.attempts.delete(ip);
      return { locked: false, retryAfterSec: 0, fails: 0 };
    }
    return { locked: false, retryAfterSec: 0, fails: row.fails };
  }

  /**
   * @param {string} ip
   * @param {string} password
   * @returns {{token: string}}
   */
  unlock(ip, password) {
    if (!this.enabled) {
      return { token: this.issueToken() };
    }

    const state = this.status(ip);
    if (state.locked) {
      throw new HttpError(
        429,
        'locked',
        `слишком много попыток — подождите ${state.retryAfterSec} с`,
      );
    }

    if (!safeEqualText(password, this.password)) {
      const row = this.attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
      row.fails += 1;
      if (row.fails >= GATE_MAX_ATTEMPTS) {
        row.lockedUntil = this.now() + GATE_LOCK_MS;
        row.fails = GATE_MAX_ATTEMPTS;
      }
      this.attempts.set(ip, row);

      if (row.lockedUntil > this.now()) {
        throw new HttpError(429, 'locked', 'слишком много попыток — подождите 5 минут');
      }
      throw new HttpError(401, 'bad_password', 'неверный пароль');
    }

    this.attempts.delete(ip);
    return { token: this.issueToken() };
  }

  /**
   * @param {string} token
   * @returns {boolean}
   */
  verify(token) {
    if (!this.enabled) return true;
    const key = String(token ?? '');
    if (!key) return false;
    this.prune();
    const expires = this.tokens.get(key);
    return typeof expires === 'number' && expires > this.now();
  }

  /** @returns {string} */
  issueToken() {
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, this.now() + GATE_TOKEN_TTL_MS);
    return token;
  }

  prune() {
    const now = this.now();
    for (const [ip, row] of this.attempts) {
      if (row.lockedUntil > 0 && row.lockedUntil <= now && row.fails >= GATE_MAX_ATTEMPTS) {
        // После окончания блокировки сбрасываем счётчик.
        this.attempts.delete(ip);
      } else if (row.lockedUntil <= now && row.fails < GATE_MAX_ATTEMPTS && row.fails === 0) {
        this.attempts.delete(ip);
      }
    }
    for (const [token, expires] of this.tokens) {
      if (expires <= now) this.tokens.delete(token);
    }
  }
}
