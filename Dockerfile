FROM node:24.12.0-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig*.json vite.config.ts ./
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.12.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/race.sqlite
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/dist/client ./dist/client
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]

# Run the compiled load client in Linux without shipping it in the release image.
FROM runtime AS load-test
COPY --from=build /app/dist/scripts/load-test.js ./dist/scripts/load-test.js
CMD ["node", "dist/scripts/load-test.js"]

FROM runtime AS release
