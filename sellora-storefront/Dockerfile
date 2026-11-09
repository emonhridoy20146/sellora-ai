# Sellora online stores (every business's shop and landing pages, chosen by the Host header).
# Build from this folder:
#   docker build -t sellora-storefront .
# Settings are read when the server starts, so one image serves any setup:
#   API_INTERNAL_URL    where this app reaches the API, e.g. http://api:4000 ("host:port" works too)
#   STOREFRONT_API_KEY  the same value as STOREFRONT_API_KEY in the API's settings
#   TRUST_PROXY_HOPS    proxies in front of this app that add to X-Forwarded-For (default 1)

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p public && npx next build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3100
CMD ["node", "server.js"]
