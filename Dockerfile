# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY shared shared
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Fixed UID/GID so mounted data directories can be permissioned reliably.
RUN addgroup -S -g 1000 app \
    && adduser -S -u 1000 -G app app \
    && mkdir -p /data \
    && chown -R app:app /data

COPY --from=build --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/server/package.json ./server/package.json
COPY --from=build --chown=app:app /app/server/dist ./server/dist
COPY --from=build --chown=app:app /app/web/dist ./web/dist

USER app
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
