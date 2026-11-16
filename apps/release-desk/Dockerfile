FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./client
COPY index.html vite.config.js ./
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global @shopify/cli@5.0.1 --no-audit --no-fund
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY docker-entrypoint.sh /usr/local/bin/release-desk-entrypoint
RUN mkdir -p /data && chown -R node:node /data /app
RUN chmod +x /usr/local/bin/release-desk-entrypoint
EXPOSE 3000
ENTRYPOINT ["release-desk-entrypoint"]
CMD ["node", "server/index.mjs"]
