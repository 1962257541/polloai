FROM node:20 AS base
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate

# ---- Builder ----
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/scraper/package.json ./apps/scraper/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

RUN pnpm exec prisma generate

COPY packages/shared ./packages/shared
COPY apps/scraper ./apps/scraper

RUN pnpm --filter @packages/shared build
RUN pnpm --filter @apps/scraper build

# ---- Runner ----
FROM base AS runner
WORKDIR /app

# Install Playwright dependencies + Chromium
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/scraper/package.json ./apps/scraper/
COPY packages/shared/package.json ./packages/shared/
COPY prisma ./prisma

RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/apps/scraper/dist ./apps/scraper/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

RUN pnpm exec prisma generate

CMD ["node", "apps/scraper/dist/main.js"]
