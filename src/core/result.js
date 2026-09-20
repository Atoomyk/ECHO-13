/**
 * Результат партии — то, что показывается на экране проигрыша и уходит в рекорды.
 *
 * Отдельный модуль без DOM: подсчёт очков и эмодзи-сетка проверяются тестами,
 * сервер использует те же функции для валидации присланного результата.
 */

import { DAILY_BUCKETS, SCORE_PER_SEC } from './constants.js';

/**
 * Оценка партии: победы, ошибки, чистота.
 * @param {object} result
 * @param {number} result.score
 * @param {number} result.elapsedSec
 * @param {number} result.hits
 * @param {number} result.cleanDodges
 * @returns {{score: number, elapsedSec: number, hits: number, cleanDodges: number, accuracy: number}}
 */
export function summarize({ score, elapsedSec, hits, cleanDodges }) {
  const attempts = hits + cleanDodges;
  return {
    score: Math.max(0, Math.floor(score) || 0),
    elapsedSec: Math.max(0, Number(elapsedSec) || 0),
    hits: Math.max(0, Math.floor(hits) || 0),
    cleanDodges: Math.max(0, Math.floor(cleanDodges) || 0),
    accuracy: attempts === 0 ? 1 : cleanDodges / attempts,
  };
}

/**
 * Эмодзи-сетка для шаринга: зелёный — чистое уклонение, жёлтый — чистых
 * уклонений в интервале было мало, красный — были касания.
 *
 * @param {object} result результат партии в формате `summarize`
 * @param {number} [buckets] сколько значков показать
 * @returns {string}
 */
export function shareGrid(result, buckets = DAILY_BUCKETS) {
  const total = Math.max(1, Math.floor(buckets) || DAILY_BUCKETS);
  const seconds = Math.max(0, result.elapsedSec);
  const span = seconds / total;

  // Касания распределяем по времени равномерно: точных отметок времени у нас нет.
  const hitSlots = new Set();
  for (let i = 0; i < result.hits; i += 1) {
    hitSlots.add(total - 1 - (i % total));
  }

  const cleanPerSlot = result.cleanDodges / total;
  let out = '';
  for (let i = 0; i < total; i += 1) {
    if (hitSlots.has(i)) out += '🔴';
    else if (span > 0 && cleanPerSlot < 0.5) out += '🟡';
    else out += '🟢';
  }
  return out;
}

/**
 * Строка для копирования в буфер обмена.
 * @param {object} result
 * @param {object} [options]
 * @param {number} [options.day] номер дня челленджа, 1 — самый первый
 * @param {boolean} [options.daily]
 * @returns {string}
 */
export function shareText(result, { day, daily = false } = {}) {
  const seconds = result.elapsedSec.toFixed(1);
  const title = daily && day ? `ECHO dual · челлендж дня #${day}` : 'ECHO dual';
  const lines = [
    `${title} ${result.score} очков`,
    `${seconds} с · множитель чистых уклонений: ${result.cleanDodges}`,
    shareGrid(result),
  ];
  return lines.join('\n');
}

/**
 * Ожидаемый верхний предел счёта — предохранитель от абсурдных чисел с клиента.
 * @param {number} elapsedSec
 * @param {number} multiplierMax
 * @returns {number}
 */
export function maxPlausibleScore(elapsedSec, multiplierMax) {
  return Math.ceil(elapsedSec * SCORE_PER_SEC * multiplierMax) + 1_000;
}