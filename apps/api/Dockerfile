# Multi-stage: TypeScript build is performed inside image; generated lockfile required.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN test -s pnpm-lock.yaml || (echo 'Generate and commit pnpm-lock.yaml before production build' && exit 1)
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dota/api build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
