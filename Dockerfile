# Linux x64 専用（リプレイ解析バイナリが linux-x64 / win-x64 のみ対応のため）
FROM --platform=linux/amd64 node:22-bookworm-slim

# libicu: 解析バイナリ(.NET 自己完結)が実行時に必要とする
RUN apt-get update \
  && apt-get install -y --no-install-recommends libicu72 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
COPY config ./config

ENV NODE_ENV=production
VOLUME ["/app/data", "/app/logs"]
CMD ["node", "dist/index.js"]
