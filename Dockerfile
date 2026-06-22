FROM node:22-bookworm-slim

# build tools so better-sqlite3 (native, via @actual-app/api) compiles reliably
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.mjs ./
COPY tools ./tools

ENV NODE_ENV=production
CMD ["node", "bot.mjs"]
