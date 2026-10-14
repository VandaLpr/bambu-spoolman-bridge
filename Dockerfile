# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries (glibc/musl, x64/arm64): no install scripts or compiler needed.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY assets ./assets

# Runs as "node" (1000:1000) by default. On Unraid, run it as 99:100 (nobody:users)
# with `user: "99:100"` (compose) or --user 99:100 so /data matches appdata ownership.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
