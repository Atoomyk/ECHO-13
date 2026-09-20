#!/usr/bin/env bash
#
# Установка PULSE на Ubuntu 24.04 (1 vCPU / 768 МБ).
#
# Что делает скрипт:
#   1. ставит nginx и Node.js 22;
#   2. создаёт системного пользователя pulse;
#   3. раскладывает статику в /var/www/pulse, сервер в /opt/pulse;
#   4. создаёт каталоги данных и логов;
#   5. включает systemd-юнит и проверяет /api/health.
#
# Запуск: sudo bash deploy/install.sh /path/to/pulse
# Файл обязан иметь переводы строк LF и не иметь BOM.

set -euo pipefail

SOURCE_DIR="${1:-}"
APP_USER="pulse"
APP_DIR="/opt/pulse"
WEB_DIR="/var/www/pulse"
DATA_DIR="/var/lib/pulse"
LOG_DIR="/var/log/pulse"
ENV_DIR="/etc/pulse"
PORT="3002"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "нужны права root: sudo bash deploy/install.sh /path/to/pulse" >&2
  exit 1
fi

if [[ -z "${SOURCE_DIR}" || ! -f "${SOURCE_DIR}/server/server.js" ]]; then
  echo "укажите каталог проекта: sudo bash deploy/install.sh /path/to/pulse" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "==> ставлю Node.js 22"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> ставлю nginx"
apt-get install -y -qq nginx

echo "==> создаю пользователя ${APP_USER}"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

echo "==> раскладываю файлы"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${ENV_DIR}"
install -d "${WEB_DIR}"

# Статика: разметка, стили и модули клиента.
install -m 644 "${SOURCE_DIR}/index.html" "${WEB_DIR}/index.html"
install -m 644 "${SOURCE_DIR}/styles.css" "${WEB_DIR}/styles.css"
rm -rf "${WEB_DIR}/src"
cp -r "${SOURCE_DIR}/src" "${WEB_DIR}/src"

# Сервер и ядро: сервер импортирует src/core, поэтому дерево копируется целиком.
rm -rf "${APP_DIR}/server" "${APP_DIR}/src"
cp -r "${SOURCE_DIR}/server" "${APP_DIR}/server"
cp -r "${SOURCE_DIR}/src" "${APP_DIR}/src"
install -m 644 "${SOURCE_DIR}/package.json" "${APP_DIR}/package.json"
install -m 644 "${SOURCE_DIR}/README.md" "${APP_DIR}/README.md"

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${DATA_DIR}" "${LOG_DIR}"

echo "==> настраиваю окружение"
if [[ ! -f "${ENV_DIR}/pulse.env" ]]; then
  cat > "${ENV_DIR}/pulse.env" <<EOF
PULSE_PORT=${PORT}
PULSE_HOST=127.0.0.1
PULSE_ENV=production
PULSE_DB_PATH=${DATA_DIR}/pulse.db
PULSE_ALLOWED_ORIGINS=
PULSE_SITE_PASSWORD=
EOF
  chmod 640 "${ENV_DIR}/pulse.env"
  chown root:"${APP_USER}" "${ENV_DIR}/pulse.env"
  echo "заполните PULSE_SITE_PASSWORD в ${ENV_DIR}/pulse.env" >&2
fi

echo "==> включаю сервис"
install -m 644 "${SOURCE_DIR}/deploy/pulse-api.service" /etc/systemd/system/pulse-api.service
systemctl daemon-reload
systemctl enable pulse-api >/dev/null
systemctl restart pulse-api

echo "==> настраиваю nginx"
install -m 644 "${SOURCE_DIR}/deploy/nginx-pulse.conf" /etc/nginx/sites-available/pulse
ln -sf /etc/nginx/sites-available/pulse /etc/nginx/sites-enabled/pulse
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> жду запуска сервиса"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "PULSE поднялся:"
    curl -fsS "http://127.0.0.1:${PORT}/api/health"
    echo
    echo "Дальше: впишите свой домен в /etc/nginx/sites-available/pulse и перезапустите nginx."
    exit 0
  fi
  sleep 0.5
done

echo "сервис не ответил за 10 секунд, смотрите логи:" >&2
echo "  journalctl -u pulse-api -n 50 --no-pager" >&2
exit 1
