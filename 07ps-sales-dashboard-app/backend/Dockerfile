# Build context is the repo root (see docker-compose.yml).
FROM node:20-alpine
# Chromium via apk, not puppeteer's bundled download -- the bundled Chromium binary targets glibc
# and is broken/oversized on Alpine's musl libc. puppeteer-core (see backend/package.json) never
# downloads its own browser; PUPPETEER_EXECUTABLE_PATH below points it at this one instead.
RUN apk add --no-cache chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
WORKDIR /repo
COPY package.json ./
COPY backend ./backend
RUN npm install --workspace backend --omit=dev
WORKDIR /repo/backend
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"]
