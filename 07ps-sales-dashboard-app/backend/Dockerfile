# --- Stage 1: Build the application ---
FROM node:20-alpine AS builder

WORKDIR /repo
COPY package.json ./
COPY backend ./backend

# Install ALL packages (including TypeScript) and build the project
RUN npm install --workspace backend
WORKDIR /repo/backend
RUN npm run build

# --- Stage 2: Final lightweight runner ---
FROM node:20-alpine

# Install Chromium for automated generation tasks
RUN apk add --no-cache chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /repo
COPY package.json ./
COPY backend ./backend

# Install ONLY production packages to keep the container tiny
RUN npm install --workspace backend --omit=dev

# Copy the compiled production build from the builder stage
COPY --from=builder /repo/backend/dist /repo/backend/dist

WORKDIR /repo/backend
EXPOSE 4000
CMD ["npm", "start"]
