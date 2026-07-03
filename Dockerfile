FROM node:20-alpine

# docker CLI + compose plugin inside the container so we can shell out to docker
# (the daemon's UNIX socket is mounted in from the host). No daemon inside.
RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client bash

WORKDIR /app

# ---------------------------------------------------------------------------
# 1. Cache the server dependency layer.
#    Copying package.json (+lock if present) first means source edits don't
#    invalidate this layer — `npm ci` reruns only when deps actually change.
# ---------------------------------------------------------------------------
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --prefer-offline --no-audit --no-fund 2>/dev/null \
    || npm install --omit=dev --prefer-offline --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. Cache the web dependency layer separately (Vite + React deps are heavy).
# ---------------------------------------------------------------------------
COPY web/package.json web/package-lock.json* ./web/
RUN cd web \
    && (npm ci --prefer-offline --no-audit --no-fund 2>/dev/null \
         || npm install --prefer-offline --no-audit --no-fund) \
    && chmod -R +x node_modules/.bin 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Bring in the actual source (invalidates only the build layer, not deps).
# ---------------------------------------------------------------------------
COPY server ./server
COPY web ./web

# ---------------------------------------------------------------------------
# 4. Build the SPA — invoke vite via `node` directly instead of the shell
#    wrapper in .bin/. Bypasses the sh: Permission denied trap when Docker
#    Buildkit or a host-copied node_modules lacks the +x bit on binaries.
# ---------------------------------------------------------------------------
RUN cd web && node ./node_modules/vite/bin/vite.js build

WORKDIR /app

EXPOSE 8089
CMD ["node", "server/index.mjs"]
