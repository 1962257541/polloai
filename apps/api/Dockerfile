FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate

# ---- Builder ----
FROM base AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

# Generate Prisma client before tsc compilation
RUN pnpm exec prisma generate

# Copy source
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Build
RUN pnpm --filter @packages/shared build
RUN pnpm --filter @apps/api build

# ---- Runner ----
FROM base AS runner
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

RUN pnpm exec prisma generate

EXPOSE 3001

CMD ["node", "apps/api/dist/main.js"]
