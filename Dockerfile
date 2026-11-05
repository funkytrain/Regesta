# Regesta - container image.
#
# Built for x86-64, which is what most home servers and NAS boxes run. If
# yours is ARM (a Raspberry Pi, an Apple Silicon Mac), build the image on the
# machine that will run it and it will work the same.

FROM node:22-slim AS base
WORKDIR /app

# libvips is what sharp uses to generate thumbnails. It comes from the system
# rather than being compiled, so the image is smaller and starts sooner.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips42 \
 && rm -rf /var/lib/apt/lists/*

# --- dependencies ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- build ---
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# The SQL and the web interface do not go through the compiler: they are
# copied as they are.
RUN cp src/server/schema.sql dist/server/ && cp -r src/web dist/web

# --- final image ---
FROM base AS final

ENV NODE_ENV=production \
    REGESTA_PORT=8080 \
    REGESTA_DB=/data/regesta.db \
    REGESTA_THUMBNAILS=/data/thumbnails \
    REGESTA_WEB=/app/dist/web

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The archive profiles: the vocabulary of your naming convention. Mount your
# own over this directory if you keep it outside the image.
COPY profiles ./profiles

# /documents is mounted read-only from the host: the originals live there.
# /data is the only thing the application writes: database and thumbnails.
VOLUME ["/data"]
EXPOSE 8080

# Unprivileged user: if something goes wrong, it cannot touch the system.
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://localhost:8080/api/summary').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]
