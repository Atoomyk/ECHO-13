/**
 * HTTP-сервер PULSE: API рекордов, параметры дня и статика.
 *
 * Зависимостей нет — только стандартная библиотека Node. Это осознанный выбор:
 * сервер живёт на 1 vCPU / 768 МБ, а `node_modules` съедает и диск, и память.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpError,
  MAX_BODY_BYTES,
  dailyPayload,
  leaderboardPayload,
  parseLeaderboardQuery,
  sanitizeText,
  validateScore,
} from './app.js';
import { loadConfig, applyEnvFile } from './config.js';
import { SiteGate, clientIp } from './gate.js';
import { serveStatic } from './static.js';
import { makeEntry, openStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

applyEnvFile(path.join(projectRoot, '.env'));
const config = loadConfig();
const gate = new SiteGate({ password: config.sitePassword });

/**
 * Ответ в формате JSON.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/**
 * Прочитать тело запроса с ограничением размера.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'too_large', 'тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Проверить источник запроса по списку разрешённых.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes(origin);
}

/**
 * Обработать запрос к API.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:url').URL} url
 * @param {Awaited<ReturnType<typeof openStore>>} store
 * @returns {Promise<boolean>} обработан ли запрос
 */
async function handleApi(req, res, url, store) {
  const route = url.pathname;

  if (!route.startsWith('/api/')) return false;

  if (!originAllowed(req)) {
    sendJson(res, 403, { error: 'origin_not_allowed' });
    return true;
  }

  if (req.method === 'GET' && route === '/api/health') {
    sendJson(res, 200, { ok: true, store: store.kind, env: config.env, mode: 'pulse' });
    return true;
  }

  if (req.method === 'GET' && route === '/api/gate') {
    const ip = clientIp(req);
    const status = gate.status(ip);
    sendJson(res, 200, {
      enabled: gate.enabled,
      locked: status.locked,
      retryAfterSec: status.retryAfterSec,
    });
    return true;
  }

  if (req.method === 'POST' && route === '/api/gate') {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: 'bad_json' });
      return true;
    }

    const ip = clientIp(req);
    const password = typeof parsed.password === 'string' ? parsed.password : '';
    const token = typeof parsed.token === 'string' ? parsed.token : '';

    if (token) {
      const ok = gate.verify(token);
      sendJson(res, ok ? 200 : 401, ok ? { ok: true } : { error: 'bad_token' });
      return true;
    }

    const result = gate.unlock(ip, password);
    sendJson(res, 200, { ok: true, token: result.token });
    return true;
  }

  if (req.method === 'GET' && route === '/api/daily') {
    sendJson(res, 200, dailyPayload());
    return true;
  }

  if (req.method === 'GET' && route === '/api/leaderboard') {
    const query = parseLeaderboardQuery(url.searchParams);
    const rows = store.top(query);
    sendJson(res, 200, leaderboardPayload(rows, url.searchParams.get('player') ?? ''));
    return true;
  }

  if (req.method === 'GET' && route === '/api/stats') {
    const mode = sanitizeText(url.searchParams.get('mode'), 16) || 'free';
    sendJson(res, 200, store.stats(mode));
    return true;
  }

  if (req.method === 'POST' && route === '/api/scores') {
    const raw = await readBody(req);

    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: 'bad_json' });
      return true;
    }

    const result = validateScore(parsed);
    store.insert(makeEntry(result));

    const rows = store.top({
      mode: result.mode,
      day: result.mode === 'daily' ? result.day : null,
      limit: 100,
    });
    const board = leaderboardPayload(rows, result.player);

    sendJson(res, 201, { saved: true, rank: board.rank, total: board.total });
    return true;
  }

  sendJson(res, 404, { error: 'not_found' });
  return true;
}

const store = await openStore(config.dbPath);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (await handleApi(req, res, url, store)) return;

    res.setHeader('access-control-allow-origin', '*');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const served = await serveStatic(res, projectRoot, url.pathname);
    if (!served) sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return;
    }

    // Внутренняя ошибка не должна раскрывать детали реализации.
    console.error('[pulse] ошибка обработки запроса:', error);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[pulse] http://${config.host}:${config.port} · хранилище: ${store.kind}`);
});

/** Аккуратное завершение: systemd шлёт SIGTERM при перезапуске. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[pulse] получен ${signal}, останавливаюсь`);
    server.close(() => process.exit(0));
  });
}