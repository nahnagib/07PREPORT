# Build context is the repo root (see docker-compose.yml).
FROM node:20-alpine
# tzdata: makes the TZ env var (APP_TIMEZONE, set in docker-compose.yml) resolve to a real IANA zone.
RUN apk add --no-cache tzdata
WORKDIR /repo
COPY package.json ./
COPY backend ./backend
RUN npm install --workspace backend
WORKDIR /repo/backend
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"]
