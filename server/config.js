/**
 * Настройки сервера из переменных окружения (локально — файл `.env` в корне).
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = 3002;
const DEFAULT_DB = './data/pulse.db';

/**
 * Подставить в `env` значения из `.env`, не перезаписывая уже заданные ключи.
 * Без внешних зависимостей: на сервере переменные приходят из systemd.
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyEnvFile(filePath, env = process.env) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{port: number, host: string, env: string, dbPath: string, allowedOrigins: string[], isProduction: boolean}}
 */
export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PULSE_PORT ?? '', 10);
  const envName = env.PULSE_ENV ?? 'production';

  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    host: env.PULSE_HOST || '127.0.0.1',
    env: envName,
    dbPath: path.resolve(env.PULSE_DB_PATH || DEFAULT_DB),
    allowedOrigins: (env.PULSE_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    isProduction: envName === 'production',
  };
}