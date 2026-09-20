/**
 * Детерминированный генератор случайных чисел.
 *
 * Используется и для сида дня (общий паттерн у всех игроков), и для разброса
 * визуальных деталей. Алгоритм простой и переносимый: одинаковый результат
 * в браузере, в Node и в тестах.
 */

/**
 * Хеш строки в 32-битное целое без знака (FNV-1a).
 * @param {string} text
 * @returns {number}
 */
export function hashSeed(text) {
  const source = String(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Сид дня: одно и то же в 00:00 UTC у всех игроков.
 * @param {number} [timestampMs] — момент времени, по умолчанию «сейчас»
 * @returns {string} — например `pulse-2026-09-19`
 */
export function dailySeed(timestampMs = Date.now()) {
  return `pulse-${dayKey(timestampMs)}`;
}

/**
 * Номер дня для выбора профиля: целое число суток с 1970-01-01 UTC.
 * @param {number} [timestampMs]
 * @returns {number}
 */
export function dayIndex(timestampMs = Date.now()) {
  return Math.floor(timestampMs / 86_400_000);
}

/**
 * Ключ даты в формате YYYY-MM-DD по UTC.
 * @param {number} timestampMs
 * @returns {string}
 */
export function dayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Генератор случайных чисел на 32 битах: быстрый, без состояния за пределами замыкания.
 * @param {number|string} seed
 * @returns {() => number} — функция, возвращающая число в [0, 1)
 */
export function mulberry32(seed) {
  let state = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Разброс в диапазоне [min, max).
 * @param {() => number} random
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function rangeBetween(random, min, max) {
  return min + (max - min) * random();
}