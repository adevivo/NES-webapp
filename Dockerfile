# ---- build: install deps, copy EmulatorJS (postinstall), build the site ----
FROM node:24.22.2-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY stubs ./stubs
COPY scripts ./scripts
RUN npm ci
COPY tsconfig.json vite.config.ts index.html play.html activity.html ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---- runtime deps only (ws) ----
FROM node:24.22.2-alpine3.24 AS deps
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund ws@8.22.1

# ---- runtime: tiny Node server, non-root, read-only friendly ----
FROM node:24.22.2-alpine3.24
ENV NODE_ENV=production PORT=3000 DIST_DIR=/app/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
