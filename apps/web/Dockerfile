FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN test -s pnpm-lock.yaml || (echo 'Generate and commit pnpm-lock.yaml before production build' && exit 1)
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @dota/web build
FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
