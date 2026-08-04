FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM deps AS prod-deps

RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 8080

CMD ["node", "dist/index.js"]
