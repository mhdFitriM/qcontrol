FROM node:20-alpine

# We need the docker CLI inside the container so we can shell out to it
# (the daemon's UNIX socket is mounted in from the host). docker-cli alone
# is enough — no daemon installed inside.
RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client bash

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY web ./web

# Build the SPA at image-build time so the runtime container ships ready.
WORKDIR /app/web
RUN npm install
RUN npm run build

WORKDIR /app

EXPOSE 8089
CMD ["node", "server/index.mjs"]
