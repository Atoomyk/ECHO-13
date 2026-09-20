/**
 * Настройки сервера из переменных окружения (см. .env.example).
 */

import path from 'node:path';

const DEFAULT_PORT = 3002;
const DEFAULT_DB = './data/pulse.db';

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