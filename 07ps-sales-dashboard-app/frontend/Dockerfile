# Build context is the repo root (see docker-compose.yml) so the @07ps/ui workspace package
# can be copied alongside the frontend - npm workspaces need both present to link correctly.
FROM node:20-alpine
WORKDIR /repo
COPY package.json ./
COPY frontend ./frontend
COPY packages ./packages
RUN npm install
WORKDIR /repo/frontend
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
