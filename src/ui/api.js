/**
 * Запросы к API PULSE и локальные рекорды.
 *
 * Сеть необязательна: если сервер недоступен, игра работает как одиночная,
 * а рекорд остаётся в localStorage. Ни один сетевой сбой не должен ломать партию.
 */

/** Ключи локального хранилища. */
const KEY_BEST = 'pulse.best';
const KEY_BEST_DAILY = 'pulse.bestDaily';
const KEY_NAME = 'pulse.name';
const KEY_SOUND = 'pulse.sound';

/**
 * Безопасно прочитать localStorage: в приватном режиме он может бросать.
 * @param {string} key
 * @param {string|null} fallback
 * @returns {string|null}
 */
function readLocal(key, fallback = null) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Безопасно записать localStorage.
 * @param {string} key
 * @param {string} value
 */
function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Приватный режим или переполнение — игра продолжается без сохранения.
  }
}

/** Личный рекорд свободной игры. */
export function getBest() {
  return Number(readLocal(KEY_BEST, '0')) || 0;
}

/** Личный рекорд ежедневного челленджа. */
export function getBestDaily() {
  return Number(readLocal(KEY_BEST_DAILY, '0')) || 0;
}

/**
 * Обновить личные рекорды.
 * @param {number} score
 * @param {boolean} daily
 * @returns {{best: number, bestDaily: number, isRecord: boolean}}
 */
export function saveBest(score, daily) {
  const rounded = Math.max(0, Math.floor(score) || 0);
  const best = getBest();
  let isRecord = false;

  if (rounded > best) {
    writeLocal(KEY_BEST, String(rounded));
    isRecord = true;
  }

  let bestDaily = getBestDaily();
  if (daily && rounded > bestDaily) {
    writeLocal(KEY_BEST_DAILY, String(rounded));
    bestDaily = rounded;
    isRecord = true;
  }

  return { best: Math.max(best, rounded), bestDaily, isRecord };
}

/** Имя игрока для лидерборда: пустая строка означает «анонимный». */
export function getPlayerName() {
  return readLocal(KEY_NAME, '') ?? '';
}

/**
 * Сохранить имя игрока.
 * @param {string} name
 * @returns {string} очищенное имя
 */
export function setPlayerName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  writeLocal(KEY_NAME, clean);
  return clean;
}

/** Настройка звука. */
export function getSoundEnabled() {
  return readLocal(KEY_SOUND, '1') !== '0';
}

/**
 * Сохранить настройку звука.
 * @param {boolean} value
 */
export function setSoundEnabled(value) {
  writeLocal(KEY_SOUND, value ? '1' : '0');
}

/**
 * Отправить результат на сервер. Ошибки глушатся: игра важнее сети.
 * @param {object} payload
 * @returns {Promise<object|null>}
 */
export async function submitScore(payload) {
  try {
    const response = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Получить таблицу рекордов.
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {boolean} [options.daily]
 * @returns {Promise<object|null>}
 */
export async function fetchLeaderboard({ limit = 10, daily = false } = {}) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (daily) params.set('mode', 'daily');
    const response = await fetch(`/api/leaderboard?${params.toString()}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Запросить параметры дня: общий сид и пороги сложности.
 * Сервер авторитетен, но игра работает и без него — считает день сама.
 * @returns {Promise<object|null>}
 */
export async function fetchDaily() {
  try {
    const response = await fetch('/api/daily');
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const KEY_GATE_TOKEN = 'echo.gate.token';

/** Токен входа в рамках вкладки. */
export function getGateToken() {
  try {
    return window.sessionStorage.getItem(KEY_GATE_TOKEN);
  } catch {
    return null;
  }
}

/** @param {string} token */
export function setGateToken(token) {
  try {
    window.sessionStorage.setItem(KEY_GATE_TOKEN, token);
  } catch {
    /* ignore */
  }
}

export function clearGateToken() {
  try {
    window.sessionStorage.removeItem(KEY_GATE_TOKEN);
  } catch {
    /* ignore */
  }
}

/**
 * Статус gate: включён ли пароль, lockout.
 * @returns {Promise<{enabled: boolean, locked: boolean, retryAfterSec: number}|null>}
 */
export async function fetchGateStatus() {
  try {
    const response = await fetch('/api/gate');
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Проверить сохранённый токен.
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function verifyGateToken(token) {
  try {
    const response = await fetch('/api/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Войти по паролю.
 * @param {string} password
 * @returns {Promise<{ok: true, token: string}|{ok: false, error: string, message?: string, retryAfterSec?: number}>}
 */
export async function unlockGate(password) {
  try {
    const response = await fetch('/api/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: body.error || 'error',
        message: body.message,
        retryAfterSec: body.retryAfterSec,
      };
    }
    return { ok: true, token: body.token };
  } catch {
    return { ok: false, error: 'network', message: 'сервер недоступен' };
  }
}