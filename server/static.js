/**
 * Раздача статики: HTML, стили, модули ядра и интерфейса.
 *
 * В продакшене статику обычно отдаёт nginx, но встроенный слой нужен для
 * локальной разработки и для случая, когда сервис поднят без прокси.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Расширения, которые сервис умеет отдавать. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Файлы, которые не нужно кэшировать: во время разработки они меняются. */
const NO_CACHE = new Set(['.html', '.js', '.css', '.mjs']);

/**
 * Разрешить путь внутри корня и не выпустить за его пределы.
 * @param {string} root
 * @param {string} requestPath
 * @returns {string|null}
 */
export function resolveSafePath(root, requestPath) {
  const raw = requestPath.split('?')[0];

  // Декодирование оставляем, но без исключений от битого процента.
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  // Backslash тоже разделитель на Windows, поэтому приводим к прямому слэшу.
  decoded = decoded.replace(/\\/g, '/');

  const base = path.resolve(root);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(base, relative);

  // Защита от ../: итоговый путь обязан лежать внутри корня.
  if (target !== base && !target.startsWith(base + path.sep)) return null;

  // Запрос не должен покидать дерево проекта даже по нормализованному пути.
  const relativeToBase = path.relative(base, target);
  if (relativeToBase === '' || relativeToBase.startsWith('..')) {
    return relativeToBase === '' ? target : null;
  }
  return target;
}

/**
 * Отдать файл. Возвращает true, если ответ отправлен.
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {string} requestPath
 * @returns {Promise<boolean>}
 */
export async function serveStatic(res, root, requestPath) {
  const target = resolveSafePath(root, requestPath);
  if (target === null) return false;

  let filePath = target;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    return false;
  }

  let content;
  try {
    content = await fs.readFile(filePath);
  } catch {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();
  const type = TYPES[extension] ?? 'application/octet-stream';

  res.writeHead(200, {
    'content-type': type,
    'content-length': content.length,
    'cache-control': NO_CACHE.has(extension) ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  res.end(content);
  return true;
}