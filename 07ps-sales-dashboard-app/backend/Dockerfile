# Build context is the repo root (see docker-compose.yml).
FROM node:20-alpine
WORKDIR /repo
COPY package.json ./
COPY backend ./backend
RUN npm install --workspace backend --omit=dev
WORKDIR /repo/backend
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"]
