FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate

# ---- Builder ----
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN pnpm --filter @packages/shared build
RUN pnpm --filter @apps/worker build

# ---- Runner ----
FROM base AS runner
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

RUN pnpm exec prisma generate

CMD ["node", "apps/worker/dist/main.js"]
