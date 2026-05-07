# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
# Development (run each in separate terminals)
pnpm dev:api        # Build shared then start NestJS API (port 3001)
pnpm dev:worker     # Build shared then start BullMQ worker
pnpm dev:web        # Start Next.js frontend (port 3000)

# Database
pnpm db:generate    # Regenerate Prisma client after schema changes
pnpm db:migrate     # Run migrations (dev)
pnpm db:push        # Push schema without migration (prototyping)
pnpm db:seed        # Seed initial admin account (admin@polloai.com / admin123456)

# Build & Test
pnpm build          # Build all packages (shared first, then apps)
pnpm test           # Run all tests
pnpm --filter @apps/api test   # Run API tests only (Jest, *.spec.ts)
```

**Important:** `@packages/shared` must be built before `@apps/api` or `@apps/worker` — the dev scripts handle this automatically, but manual runs need `pnpm --filter @packages/shared build` first.

## Architecture

This is a **pnpm monorepo** for an internal AI image/video generation tool powered by Google Gemini.

### Request Flow

```
Next.js (web) → NestJS API (api) → BullMQ Queue → Worker
                                        ↓
                              Redis pub/sub (generation-status channel)
                                        ↑
                              API SSE stream → frontend EventSource
```

### Apps

| App | Tech | Role |
|-----|------|------|
| `apps/api` | NestJS 11 | REST API, JWT auth, task management, SSE notifications |
| `apps/worker` | BullMQ Worker | Consumes generation jobs, calls Gemini, uploads to S3 |
| `apps/web` | Next.js 14 (App Router) | Frontend dashboard |
| `packages/shared` | TypeScript | Zod schemas, shared types (GenerationEvent, contracts) |

### Key Modules (API)

- **AuthModule** — JWT login (`/auth/login`), `JwtAuthGuard`, `@CurrentUser()` decorator
- **AdminModule** — Admin-only CRUD for salespersons (`/admin/salespersons`), API key management (`/admin/me/apikey`, `/admin/salespersons/:id/apikey`)
- **GenerationsModule** — Task creation/listing/cancellation; enqueues jobs with `{taskId, apiKey}` payload
- **NotificationsModule** — SSE stream at `/notifications/stream`; subscribes to Redis `generation-status` channel
- **StorageModule** — S3-compatible upload (MinIO/AWS)
- **AuditModule** — Global `AuditInterceptor` logs all requests to `ApiAuditLog`

### Role & Auth Model

Two roles: `admin` and `salesperson` (default). Each user stores their own `apiKey` (Gemini key) — generation tasks use the submitting user's key, not a global env key. Guards: `JwtAuthGuard` (all protected routes) + `RolesGuard` (admin routes).

### Worker

Concurrency: 2 workers. Processes `process-generation` jobs from `generation-jobs` queue. After Gemini call completes, uploads output to S3, updates DB, publishes status event to Redis. Video generation uses long-polling (`pollVideoCompletion`, 5 s intervals) until Gemini's operation `done === true`.

### Frontend Auth

`apps/web/lib/auth.ts` — writes JWT token and role to cookies (`polloai_token`, `polloai_role`) for middleware access. `apps/web/middleware.ts` — redirects unauthenticated users to `/login`; blocks non-admin users from `/settings`.

### Environment Variables (API / Worker)

Required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_BASE_URL`

Optional overrides: `GEMINI_BASE_URL`, `GEMINI_IMAGE_MODEL` (default: `gemini-2.5-flash-image`), `GEMINI_VIDEO_MODEL` (default: `veo-3.1-generate-preview`), `GEMINI_VIDEO_SECONDS` (4–8, default: 4)

Env files are loaded from `.env.local` → `.env` → `../../.env.local` → `../../.env` (first match wins, no override).

### Shared Contracts (`packages/shared`)

- `textToImageSchema` / `imageToVideoSchema` — Zod schemas used for validation in both API and worker
- `GenerationEvent` — shape of Redis pub/sub messages
- TaskStatus state machine: `queued → running → succeeded | failed | cancelled` (terminal states cannot transition back)

## Agent skills

### Issue tracker

Issues and PRDs for this repo live as GitHub issues. Uses the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default canonical label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
