# Sellora API and worker: one image, two commands.
#   API:    node dist/main.js    (the default)
#   Worker: node dist/worker.js  (set as the service's start command)
# Build from this folder: docker build -t sellora-api .

FROM node:22-bookworm-slim AS build
WORKDIR /app
# The test database's binary is a dev tool; never download it here.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Prints fresh secrets (node scripts/generate-keys.mjs); needs nothing else.
COPY --from=build --chown=node:node /app/scripts/generate-keys.mjs ./scripts/
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
