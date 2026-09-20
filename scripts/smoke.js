/**
 * Быстрая проверка боевой сборки: сервер отвечает на все ключевые маршруты,
 * статика раздаётся, рекорд сохраняется и невозможный счёт отклоняется.
 *
 * Запуск: npm run smoke — скрипт поднимает сервер сам на свободном порту.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 3199;

const failures = [];
const checks = [];

/**
 * Проверка с понятным сообщением.
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(name);
}

/** Запрос с таймаутом: зависший дымовой тест хуже упавшего. */
async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  return response;
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PULSE_PORT: String(PORT),
    PULSE_HOST: '127.0.0.1',
    PULSE_ENV: 'smoke',
    PULSE_DB_PATH: './data/smoke.db',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

/** Подождать, пока сервер начнёт принимать запросы. */
async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await request('/api/health');
      if (response.ok) return true;
    } catch {
      // Сервер ещё поднимается — ждём дальше.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

try {
  const ready = await waitForServer();
  check('сервер поднялся', ready, ready ? '' : serverOutput.trim());

  if (ready) {
    const health = await request('/api/health');
    const healthBody = await health.json();
    check('GET /api/health отвечает ok', healthBody.ok === true);
    check('хранилище доступно', ['sqlite', 'json'].includes(healthBody.store), healthBody.store);

    const daily = await request('/api/daily');
    const dailyBody = await daily.json();
    check('GET /api/daily отдаёт сид', typeof dailyBody.seed === 'string' && dailyBody.seed.startsWith('pulse-'));
    check('профиль дня содержит пороги', typeof dailyBody.profile?.jaggedTimeSec === 'number');

    const index = await request('/');
    const html = await index.text();
    check('GET / отдаёт страницу игры', index.ok && html.includes('ECHO dual'));
    check('страница подключает точку входа', html.includes('src/main.js'));

    const styles = await request('/styles.css');
    check('GET /styles.css отдаёт стили', styles.ok && (styles.headers.get('content-type') ?? '').includes('text/css'));

    const module = await request('/src/core/game.js');
    check('модули ядра раздаются', module.ok);

    // fetch нормализует «/../» до отправки, поэтому проверяем закодированный
    // вариант: он доходит до сервера дословно и не должен отдавать файл.
    const traversal = await request('/..%2f..%2fserver%2fconfig.js');
    check('выход за пределы корня запрещён', traversal.status === 404 || traversal.status === 400, String(traversal.status));

    const save = await request('/api/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'free',
        player: 'Смоук',
        score: 1234,
        elapsedSec: 90,
        cleanDodges: 8,
        hits: 2,
      }),
    });
    const saveBody = await save.json();
    check('POST /api/scores сохраняет результат', save.status === 201 && saveBody.saved === true, String(save.status));
    check('сохранённому результату считается место', typeof saveBody.rank === 'number');

    const board = await request('/api/leaderboard?limit=5&player=%D0%A1%D0%BC%D0%BE%D1%83%D0%BA');
    const boardBody = await board.json();
    check('GET /api/leaderboard отдаёт таблицу', Array.isArray(boardBody.entries));
    check('игрок найден в таблице', boardBody.entries.some((entry) => entry.player === 'Смоук'));

    const cheat = await request('/api/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'free', player: 'x', score: 999_999_999, elapsedSec: 3, cleanDodges: 0, hits: 0 }),
    });
    check('невозможный счёт отклонён', cheat.status === 400, String(cheat.status));

    const missing = await request('/api/nothing-here');
    check('неизвестный маршрут даёт 404', missing.status === 404);
  }
} catch (error) {
  check('дымовой тест без исключений', false, String(error));
} finally {
  server.kill();
}

for (const item of checks) {
  const mark = item.ok ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length}`);
  console.error(serverOutput.trim());
  process.exit(1);
}

console.log(`\nВсе проверки пройдены: ${checks.length}`);
