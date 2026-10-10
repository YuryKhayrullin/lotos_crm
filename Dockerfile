# Explicit version; update only with CI/restore checks, not floating latest.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build -- --webpack

FROM dependencies AS migrator
COPY prisma ./prisma
COPY prisma.deploy.config.ts ./prisma.deploy.config.ts
COPY scripts/lib/environment.mjs ./scripts/lib/environment.mjs
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.deploy.config.ts"]

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -g 10001 lotos && useradd --no-create-home -u 10001 -g lotos lotos
COPY --from=builder --chown=lotos:lotos /app/.next/standalone ./
COPY --from=builder --chown=lotos:lotos /app/.next/static ./.next/static
COPY --from=builder --chown=lotos:lotos /app/public ./public
USER lotos
EXPOSE 3000
CMD ["node", "server.js"]
