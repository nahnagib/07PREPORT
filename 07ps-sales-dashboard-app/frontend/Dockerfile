# Build context is the repo root (see docker-compose.yml) so the @07ps/ui workspace package
# can be copied alongside the frontend - npm workspaces need both present to link correctly.
FROM node:20-alpine
WORKDIR /repo
COPY package.json ./
COPY frontend ./frontend
COPY packages ./packages
RUN npm install
WORKDIR /repo/frontend
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time -- must be an ARG available
# before `next build` runs, not just a runtime env var (see docker-compose.yml's frontend.build.args).
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
