# Единый образ всего Node-приложения. В docker-compose запускается как разные
# сервисы (web / scheduler / generator) через разные команды.
FROM node:22-bookworm-slim

WORKDIR /app

# Сборочные зависимости на случай, если better-sqlite3 будет компилироваться из исходников
# (обычно ставится prebuilt-бинарь, но подстрахуемся).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# По умолчанию — веб; в compose команда переопределяется на scheduler/generator.
CMD ["node", "web/server.js"]
