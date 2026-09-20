/**
 * Логика API PULSE: чистые функции без привязки к серверу.
 *
 * Маршруты (все под префиксом /api):
 *   GET  /api/health
 *   GET  /api/daily                       общий сид дня и пороги сложности
 *   GET  /api/leaderboard?mode=daily&limit=10
 *   POST /api/scores                      сохранить результат
 *   GET  /api/stats?mode=free
 */

import { DAILY_PROFILES, SCORE_PER_SEC, CLEAN_MULTIPLIER_MAX, DAY_MS } from '../src/core/constants.js';
import { dailySeed, dayIndex, dayKey } from '../src/core/random.js';
import { dailyProfile } from '../src/core/game.js';
import { toPublic } from './store.js';

const MAX_BODY_BYTES = 2048;
const PLAYER_MAX = 24;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** Режимы игры: свободная партия и ежедневный челлендж. */
const MODES = new Set(['free', 'daily']);

/** Верхние границы значений — защита от абсурда с клиента. */
export const LIMITS = Object.freeze({
  score: 1_000_000_000,
  elapsedSec: 86_400,
  cleanDodges: 100_000,
  hits: 100_000,
});

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Очистить текст от управляющих символов и обрезать.
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
export function sanitizeText(value, maxLength) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Привести значение к конечному числу.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value.trim()))) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Проверить и нормализовать результат партии.
 * @param {unknown} payload
 * @returns {{mode: string, player: string, score: number, elapsedSec: number, cleanDodges: number, hits: number, day: number|null}}
 */
export function validateScore(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new HttpError(400, 'bad_payload', 'тело запроса должно быть объектом');
  }

  const raw = /** @type {Record<string, unknown>} */ (payload);
  const mode = sanitizeText(raw.mode, 16) || 'free';
  if (!MODES.has(mode)) {
    throw new HttpError(400, 'bad_mode', `режим должен быть одним из: ${[...MODES].join(', ')}`);
  }

  const score = toNumber(raw.score);
  const elapsedSec = toNumber(raw.elapsedSec);
  const cleanDodges = toNumber(raw.cleanDodges);
  const hits = toNumber(raw.hits);

  if (score === null || elapsedSec === null || cleanDodges === null || hits === null) {
    throw new HttpError(400, 'bad_numbers', 'score, elapsedSec, cleanDodges и hits обязательны');
  }

  if (score < 0 || elapsedSec < 0 || cleanDodges < 0 || hits < 0) {
    throw new HttpError(400, 'bad_numbers', 'отрицательные значения недопустимы');
  }

  if (score > LIMITS.score || elapsedSec > LIMITS.elapsedSec) {
    throw new HttpError(400, 'out_of_range', 'значение выходит за допустимый диапазон');
  }

  if (cleanDodges > LIMITS.cleanDodges || hits > LIMITS.hits) {
    throw new HttpError(400, 'out_of_range', 'слишком много событий для одной партии');
  }

  // Счёт ограничен физически возможным: время × база × максимальный множитель.
  const ceiling = elapsedSec * SCORE_PER_SEC * CLEAN_MULTIPLIER_MAX + 1_000;
  if (score > ceiling) {
    throw new HttpError(400, 'implausible_score', 'счёт не соответствует длительности партии');
  }

  const day = mode === 'daily' ? dayIndexFromPayload(raw.day) : null;

  return {
    mode,
    player: sanitizeText(raw.player, PLAYER_MAX) || 'аноним',
    score: Math.floor(score),
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    cleanDodges: Math.floor(cleanDodges),
    hits: Math.floor(hits),
    day,
  };
}

/**
 * День челленджа: клиент может прислать свой, но он должен быть разумным.
 * @param {unknown} value
 * @returns {number}
 */
function dayIndexFromPayload(value) {
  const parsed = toNumber(value);
  const today = dayIndex();
  if (parsed === null || !Number.isInteger(parsed) || parsed < 0 || parsed > today) return today;
  return parsed;
}

/**
 * Параметры дня: общий сид и пороги сложности. Одинаковы для всех до 00:00 UTC.
 * @param {number} [timestampMs]
 * @returns {{seed: string, date: string, day: number, profile: object}}
 */
export function dailyPayload(timestampMs = Date.now()) {
  return {
    seed: dailySeed(timestampMs),
    date: dayKey(timestampMs),
    day: dayIndex(timestampMs),
    profile: dailyProfile(timestampMs),
  };
}

/**
 * Разобрать query-параметры таблицы рекордов.
 * @param {URLSearchParams} params
 * @returns {{mode: string, day: number|null, limit: number}}
 */
export function parseLeaderboardQuery(params) {
  const mode = sanitizeText(params.get('mode'), 16) || 'free';
  if (!MODES.has(mode)) {
    throw new HttpError(400, 'bad_mode', `режим должен быть одним из: ${[...MODES].join(', ')}`);
  }

  const requested = toNumber(params.get('limit'));
  const limit = requested === null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));

  return { mode, day: mode === 'daily' ? dayIndex() : null, limit };
}

/**
 * Собрать ответ таблицы рекордов вместе с позицией игрока.
 * @param {Array<object>} rows
 * @param {string} player
 * @returns {{entries: Array<object>, rank: number|null, total: number}}
 */
export function leaderboardPayload(rows, player) {
  const entries = rows.map(toPublic);
  const cleanPlayer = sanitizeText(player, PLAYER_MAX);
  const index = cleanPlayer ? entries.findIndex((entry) => entry.player === cleanPlayer) : -1;

  return {
    entries,
    rank: index >= 0 ? index + 1 : null,
    total: entries.length,
  };
}

/** Сколько миллисекунд осталось до смены дня — полезно интерфейсу. */
export function msUntilNextDay(timestampMs = Date.now()) {
  return DAY_MS - (timestampMs % DAY_MS);
}

/** Список известных режимов — используется тестами и справкой. */
export function knownModes() {
  return [...MODES];
}

/** Число профилей сложности: по одному на день, цикл повторяется. */
export function profileCount() {
  return DAILY_PROFILES.length;
}

export { MAX_BODY_BYTES, PLAYER_MAX, DEFAULT_LIMIT, MAX_LIMIT };