# Sellora web app (public site, merchant dashboard, super-admin panel).
# Build from this folder:
#   docker build --build-arg API_INTERNAL_URL=http://api:4000 \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://app.example.com -t sellora-web .
# API_INTERNAL_URL is fixed at build time (Next.js bakes the /v1 and /socket.io rewrites into
# the build), so rebuild after changing it. Hosts such as Railway pass service variables to
# these ARGs automatically.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG API_INTERNAL_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_BRAND_NAME
ARG NEXT_PUBLIC_SUPPORT_EMAIL
RUN test -n "$API_INTERNAL_URL" || { echo "Set API_INTERNAL_URL (where this app reaches the API)"; exit 1; }
RUN npx next build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
ARG API_INTERNAL_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL
USER node
EXPOSE 3000
CMD ["node", "server.js"]
