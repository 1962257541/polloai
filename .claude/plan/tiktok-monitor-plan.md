# TikTok 数据看板 — 实施计划

## Context

**目标**：在 polloai 平台新增 TikTok 多账号数据看板，采集并展示视频指标（播放量/点赞/评论/分享/收藏）与带货数据（GMV/订单/佣金），支持多账号管理；销售可看到自己上传的账号，管理员可看全部。

**当前状态**：
- 仓库里已有人启动过这个特性（git status 中 `apps/api/src/tiktok/`、`apps/api/src/system-config/`、`apps/scraper/`、`apps/web/app/(dashboard)/tiktok/`、`prisma/migrations/20260506055013_add_tiktok_monitor/` 均为 untracked）。
- **源码文件已丢失**，仅 `apps/api/dist/`、`apps/scraper/dist/` 存有完整编译产物；目录与迁移文件夹是空壳。
- `apps/api/src/app.module.ts` 没有注册 `TiktokModule` / `SystemConfigModule`；`apps/web/components/Sidebar.tsx` 没有 TikTok 菜单；`prisma/schema.prisma` 没有 TikTok 相关模型。
- 已有的 dist 设计是用 **Playwright 登录 TikTok Affiliate 后台**（`affiliate.tiktok.com/connection/creator`）抓取，**不是** TikTokDownloader 公开 API（公开 API 抓不到带货 GMV）。

**评估结论 — TikTokDownloader 不适用**：该项目仅能拿到 `play_count / digg_count / comment_count / share_count / collect_count` 等公开指标，**完全无法获取小黄车/橱窗/Affiliate GMV**。本计划采用 Playwright 后台采集方案。

**用户决策（Plan 阶段已确认）**：
1. 数据源：Playwright 登录 Affiliate 后台采集
2. 商品数据范围：带货 GMV / 订单 / 佣金（Affiliate）
3. 权限：admin 看所有人，salesperson 只看自己上传的（需新增 `ownerId`）
4. 实施策略：基于 dist 反推恢复 + 补齐缺失部分

---

## 总体架构

```
Web (Next.js)              API (NestJS)                 Scraper (NestJS Standalone)
  /tiktok                    AdminTiktokController         BullMQ Worker (queue: tt-scrape)
  /tiktok/[accountId]   ←→   SystemConfigController   →   BrowserPool (Playwright Chromium ×N)
                             TiktokService                 AffiliateScraper
                                    ↓                      HeartbeatService → Redis tt:scraper:hb
                             Postgres (Prisma)             SystemConfigLoader (订阅 system-config:changed)
                                    ↑                            ↓
                             SystemConfig.cookieKey  ←  解密后注入 → 解密 TiktokAccount.storageState
```

**采集流程**：API 触发 `refresh` → 入队 BullMQ → Scraper 取 BrowserPool 一个空闲实例 → 用账号 storageState 启动 context → 访问 affiliate 后台 + 创作者主页 → 抽取数据 → 写入 `TiktokVideo` + 累计 `TiktokVideoMetric` 快照 → 更新 `lastScrapedAt` → 失败则更新 `status` 为 `cookie_expired` / `captcha_blocked` / `error`。

---

## 数据库模型（Prisma 增量）

新增到 `prisma/schema.prisma`：

```prisma
enum TiktokAccountStatus {
  active
  cookie_expired
  captcha_blocked
  error
  disabled
}

model TiktokAccount {
  id                  String              @id @default(uuid())
  ownerId             String              // ← salesperson 看自己用此字段
  handle              String              @unique // @username
  nickname            String?
  status              TiktokAccountStatus @default(active)
  // 加密的 Playwright storage_state（JSON）
  storageStateEnc     Bytes?
  storageStateIv      Bytes?
  storageStateTag     Bytes?
  // 配置
  scrapeIntervalMin   Int                 @default(60)
  // 聚合统计（采集后回填）
  followerCount       Int                 @default(0)
  videoCount          Int                 @default(0)
  totalGmvCents       BigInt              @default(0)
  totalCommissionCents BigInt             @default(0)
  totalOrders         Int                 @default(0)
  // 状态
  lastScrapedAt       DateTime?
  lastErrorAt         DateTime?
  lastErrorMessage    String?
  createdAt           DateTime            @default(now())
  updatedAt           DateTime            @updatedAt

  owner   User           @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  videos  TiktokVideo[]

  @@index([ownerId, createdAt])
  @@index([status, lastScrapedAt])
}

model TiktokVideo {
  id           String   @id @default(uuid())
  accountId    String
  videoId      String   // TikTok 原生 video id
  title        String?
  coverUrl     String?
  publishedAt  DateTime?
  // 最新快照
  playCount    BigInt   @default(0)
  likeCount    BigInt   @default(0)
  commentCount BigInt   @default(0)
  shareCount   BigInt   @default(0)
  collectCount BigInt   @default(0)
  gmvCents     BigInt   @default(0)
  orderCount  Int       @default(0)
  scrapedAt    DateTime @default(now())

  account TiktokAccount         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  metrics TiktokVideoMetric[]

  @@unique([accountId, videoId])
  @@index([accountId, publishedAt])
  @@index([accountId, playCount])
}

// 历史快照（趋势图）
model TiktokVideoMetric {
  id           String   @id @default(uuid())
  videoId      String
  playCount    BigInt
  likeCount    BigInt
  commentCount BigInt
  shareCount   BigInt
  collectCount BigInt
  gmvCents     BigInt
  orderCount   Int
  capturedAt   DateTime @default(now())

  video TiktokVideo @relation(fields: [videoId], references: [id], onDelete: Cascade)

  @@index([videoId, capturedAt])
}

model SystemConfig {
  key        String   @id // tiktok.cookieKey / tiktok.scrapeTimeoutMs / ...
  category   String   // tiktok
  isSecret   Boolean  @default(false)
  // 非敏感
  valuePlain String?
  // 敏感（AES-256-GCM with TIKTOK_BOOT_KEY）
  valueEnc   Bytes?
  valueIv    Bytes?
  valueTag   Bytes?
  byteLength Int?     // 解密后的明文字节长度（用于UI显示）
  updatedBy  String?
  updatedAt  DateTime @updatedAt
  createdAt  DateTime @default(now())

  @@index([category])
}
```

`User` 模型追加 `tiktokAccounts TiktokAccount[]` 关系字段。

---

## 加密体系（沿用 dist 设计）

```
环境变量 TIKTOK_BOOT_KEY (32B base64)
      ↓ AES-256-GCM
SystemConfig: tiktok.cookieKey (32B 随机生成，可旋转)
      ↓ AES-256-GCM
TiktokAccount.storageStateEnc (Playwright storage_state JSON)
```

- **轮换 cookieKey** 时，所有非 `disabled` 账号自动置为 `cookie_expired`（旧 storage_state 无法解密，必须重传）。
- 加密实现已在 `apps/api/dist/system-config/crypto.service.js` —— 直接照译为 `apps/api/src/system-config/crypto.service.ts`。

---

## 后端 API（NestJS）

### `apps/api/src/system-config/`（管理员密钥/配置管理）

| 方法 | 路由 | 角色 | 说明 |
|---|---|---|---|
| GET | `/admin/system-config/tiktok` | admin | 返回 cookieKey 配置态 + 抓取参数 |
| PUT | `/admin/system-config/tiktok` | admin | 更新 affiliateOverviewUrl / scrapeTimeoutMs / browserPoolSize / defaultIntervalMin |
| POST | `/admin/system-config/tiktok/cookie-key/rotate` | admin | 旋转 cookie 主密钥（**所有账号需重传 cookie**） |
| DELETE | `/admin/system-config/tiktok/cookie-key` | admin | 重置 cookie 主密钥 |

文件：
- `system-config.module.ts`
- `system-config.controller.ts`
- `system-config.service.ts`（含 Redis pub `system-config:changed` 通知 scraper 热更新）
- `crypto.service.ts`
- `system-config.constants.ts`（`TIKTOK_CONFIG_CATEGORY`、`TIKTOK_CONFIG_KEYS`、`TIKTOK_CONFIG_DEFAULTS`、`SYSTEM_CONFIG_CHANGED_CHANNEL`）
- `dto/update-tiktok-config.dto.ts`

### `apps/api/src/tiktok/`（业务接口）

| 方法 | 路由 | 角色 | 说明 |
|---|---|---|---|
| GET | `/tiktok/accounts` | admin / salesperson | admin 看全部；salesperson 自动按 `ownerId = current.sub` 过滤。支持 `?status=&q=&page=&pageSize=` |
| POST | `/tiktok/accounts` | admin / salesperson | 创建账号，自动绑定 `ownerId = current.sub` |
| GET | `/tiktok/accounts/:id` | admin / salesperson(owner) | salesperson 仅能访问自己的 |
| PATCH | `/tiktok/accounts/:id` | admin / salesperson(owner) | nickname / scrapeIntervalMin / status |
| DELETE | `/tiktok/accounts/:id` | admin / salesperson(owner) | |
| POST | `/tiktok/accounts/:id/cookies` | admin / salesperson(owner) | multipart 上传 storage_state JSON 文件 |
| POST | `/tiktok/accounts/:id/refresh` | admin / salesperson(owner) | 手动入队抓取 |
| GET | `/tiktok/accounts/:id/videos` | admin / salesperson(owner) | `?sortBy=playCount\|gmv\|orderCount` |
| GET | `/tiktok/accounts/:id/videos/:videoId/metrics` | admin / salesperson(owner) | 趋势数据（按时间序列） |
| GET | `/tiktok/health` | admin | 读 Redis `tt:scraper:hb` 显示采集服务在线状态 |

**关键变化点**：dist 里所有接口路由前缀是 `/admin/tiktok`，全是 `admin only`。本期改为 `/tiktok`，`Roles("admin", "salesperson")`，并在 service 层用 `ownerOrAdminGuard` 做行级过滤。

文件：
- `tiktok.module.ts`
- `tiktok.controller.ts`
- `tiktok.service.ts`（**这一份是真实实现，非 dist 里的 Mock**：调 Prisma + 入队 BullMQ + 读 Postgres）
- `health.controller.ts`
- `dto/create-account.dto.ts`、`dto/update-account.dto.ts`、`dto/upload-cookie.dto.ts`
- `tiktok-ownership.guard.ts`（行级权限）

### 注册到 AppModule

`apps/api/src/app.module.ts` 加入 `SystemConfigModule`、`TiktokModule`，并在 `BullModule.registerQueue({ name: "tt-scrape" })` 注册采集队列。

---

## 采集服务 `apps/scraper/`

**形态**：独立 NestJS standalone（`createApplicationContext`），不是 BullMQ Worker 而是 NestJS Module 内启动 BullMQ Worker（参考 `apps/worker` 现有形态）。

**M1 已完成（dist 反推）**：
- `services/env.service.ts` —— Zod 加载 DATABASE_URL / REDIS_URL / TIKTOK_BOOT_KEY
- `services/prisma.service.ts`
- `services/heartbeat.service.ts` —— 每 30s 写 `tt:scraper:hb` `{ts, activeBrowsers, poolSize, successRate}` 到 Redis
- `services/system-config-loader.service.ts` —— 订阅 `system-config:changed`，缓存 cookieKey、超时、池大小

**M3-M4 新增**：
- `services/browser-pool.service.ts` —— Playwright Chromium 池（按 `browserPoolSize` 启动），acquire/release，崩溃自愈
- `services/affiliate-scraper.service.ts` —— 核心采集器：
  - 解密 storageState → `chromium.launchPersistentContext` 或 `context.storageState`
  - 访问 `affiliate.tiktok.com/connection/creator` → 抽取卖家概览（GMV、佣金、订单聚合）
  - 访问 `tiktok.com/@{handle}` → 拿视频列表（XHR/network intercept 拿到 `itemList`）
  - 访问每个视频详情拿独立指标
  - 检测 `captcha_blocked` / 登录失效 → 抛 `CookieExpiredError` → API 标记账号
- `services/monitor-worker.service.ts` —— BullMQ Worker（队列 `tt-scrape`），消费 `{accountId}` job
- `services/scheduler.service.ts` —— `@Cron` 按账号 `scrapeIntervalMin` 入队
- `package.json` —— 创建（git status 显示 `apps/scraper/` 还没 package.json）

**依赖**：
```json
{
  "dependencies": {
    "@nestjs/common": "^11",
    "@nestjs/core": "^11",
    "@nestjs/bullmq": "^11",
    "@nestjs/schedule": "^4",
    "bullmq": "^5",
    "ioredis": "^5",
    "playwright": "^1.49",
    "@prisma/client": "workspace 现版本",
    "zod": "^3"
  }
}
```

**Docker**：`docker-compose.yml` 增加 scraper 服务，base image `mcr.microsoft.com/playwright:v1.49.0-jammy`，挂载 `apps/scraper/dist`，env 注入 `TIKTOK_BOOT_KEY`、`DATABASE_URL`、`REDIS_URL`。

---

## 前端页面 `apps/web/app/(dashboard)/tiktok/`

### `page.tsx` —— 账号列表
- 上方工具条：搜索框、状态筛选 `active|cookie_expired|captcha_blocked|error|disabled`、`+ 新建账号` 按钮
- 卡片网格：每卡显示 handle / nickname / 状态 chip / 粉丝数 / 视频数 / 累计 GMV / 累计订单 / lastScrapedAt 相对时间 / `刷新`、`上传 Cookie`、`详情` 三个按钮
- admin 顶部多一个 `所有人 / 仅我的` 筛选切换；salesperson 隐藏
- 对接 `apps/web/lib/tiktok.ts`（封装 fetch）

### `[accountId]/page.tsx` —— 账号详情
- 顶部摘要卡（粉丝、视频数、GMV、订单、佣金）
- 视频表格：按 `playCount / gmv / orderCount` 排序，分页；点击视频展开折线图（调 metrics 接口拿趋势）
- 账号操作区：手动刷新、上传 cookie、修改抓取间隔、删除

### 复用组件
- `apps/web/components/TiktokConfigManage.tsx`（git status 已存在但是空壳）—— 系统设置页里的 TikTok 配置 tab：cookie 主密钥状态、抓取超时、浏览器池大小、Affiliate URL、`旋转密钥`/`重置密钥` 按钮
- `apps/web/lib/tiktok.ts`（git status 已存在但是空壳）—— 前端 API 客户端

### Sidebar 集成
`apps/web/components/Sidebar.tsx` 在 `NAV_ITEMS` 加：
```ts
{
  label: "TikTok 数据",
  href: "/tiktok",
  icon: ...(类似 ImageTab 的 SVG),
  roles: ["admin", "salesperson"],
}
```

### 设置页集成
`apps/web/app/(dashboard)/settings/page.tsx` 在 `tab` state 增加 `"tiktok"`，渲染 `<TiktokConfigManage />`；该 tab 仅 admin 可见。

---

## 环境变量增量

`.env.example` 追加：
```
# TikTok Monitor
TIKTOK_BOOT_KEY=<32 字节 base64，例: openssl rand -base64 32>
TIKTOK_SCRAPER_HEADLESS=true
TIKTOK_SCRAPER_PROXY=    # 可选 HTTP/SOCKS 代理
```

`apps/api/src/config/env.service.ts` 在 `envSchema` 加 `TIKTOK_BOOT_KEY: z.string().optional()`，对外暴露 `get tiktokBootKey(): Buffer | undefined`（解码 base64）。

`apps/scraper/services/env.service.ts` 复制同样的 schema。

---

## 关键文件清单（待恢复/新增）

**API（13 文件）**：
- `apps/api/src/tiktok/tiktok.module.ts`
- `apps/api/src/tiktok/tiktok.controller.ts`
- `apps/api/src/tiktok/tiktok.service.ts` ← **真实实现，非 Mock**
- `apps/api/src/tiktok/health.controller.ts`
- `apps/api/src/tiktok/tiktok-ownership.guard.ts` ← **新增**
- `apps/api/src/tiktok/dto/create-account.dto.ts`
- `apps/api/src/tiktok/dto/update-account.dto.ts`
- `apps/api/src/system-config/system-config.module.ts`
- `apps/api/src/system-config/system-config.controller.ts`
- `apps/api/src/system-config/system-config.service.ts`
- `apps/api/src/system-config/crypto.service.ts`
- `apps/api/src/system-config/system-config.constants.ts`
- `apps/api/src/system-config/dto/update-tiktok-config.dto.ts`

**Scraper（10 文件）**：
- `apps/scraper/package.json` ← **新增**（git status 没有）
- `apps/scraper/tsconfig.json` ← **新增**
- `apps/scraper/src/main.ts`
- `apps/scraper/src/scraper.module.ts`
- `apps/scraper/src/services/{env,prisma,heartbeat,system-config-loader}.service.ts` ← 从 dist 反推
- `apps/scraper/src/services/browser-pool.service.ts` ← **新增**
- `apps/scraper/src/services/affiliate-scraper.service.ts` ← **新增**
- `apps/scraper/src/services/monitor-worker.service.ts` ← **新增**
- `apps/scraper/src/services/scheduler.service.ts` ← **新增**

**Web（4 文件）**：
- `apps/web/app/(dashboard)/tiktok/page.tsx`
- `apps/web/app/(dashboard)/tiktok/[accountId]/page.tsx`
- `apps/web/components/TiktokConfigManage.tsx`
- `apps/web/lib/tiktok.ts`

**改动**：
- `apps/api/src/app.module.ts` ← 注册新模块 + BullModule.registerQueue
- `apps/api/src/config/env.service.ts` ← 加 `TIKTOK_BOOT_KEY`
- `apps/web/components/Sidebar.tsx` ← 加 TikTok 菜单
- `apps/web/app/(dashboard)/settings/page.tsx` ← 加 TikTok 配置 tab
- `apps/web/middleware.ts` ← 检查（默认即可，菜单两角色都可访问，行级在 API）
- `prisma/schema.prisma` ← 新增 4 个模型 + 1 enum
- `prisma/migrations/20260506055013_add_tiktok_monitor/migration.sql` ← **目前为空**，需 `pnpm prisma migrate dev` 生成
- `package.json` 根 ← 加 `dev:scraper` 脚本
- `docker-compose.yml` ← 加 scraper 服务（用 Playwright 镜像）
- `.env.example` ← 追加 TIKTOK_BOOT_KEY 等
- `pnpm-workspace.yaml` ← 确认包含 `apps/scraper`（git status 显示 `pnpm-lock.yaml` 已被改）

**参考源（dist 反推）**：
- `apps/api/dist/tiktok/*.js` —— controller/service/health 的 JS 形态（service 部分仅 Mock，需重写为真实实现）
- `apps/api/dist/system-config/*.js` —— **可直接照译为 .ts**，crypto.service / 加密体系完整
- `apps/scraper/dist/{main,scraper.module}.js` 与 `dist/services/*.js` —— **可直接照译为 .ts** 作为 M1 基础

---

## 里程碑切分

**M1 — 基础设施（半天）**
1. `prisma/schema.prisma` 加模型 → `pnpm db:migrate`
2. `system-config` 模块（照译 dist）+ `TIKTOK_BOOT_KEY` 环境变量
3. `apps/scraper` package.json + 4 个基础 service（照译 dist）
4. AppModule 注册 SystemConfigModule
5. **验证**：`POST /admin/system-config/tiktok/cookie-key/rotate` 能成功生成密钥；scraper 启动后 `redis-cli get tt:scraper:hb` 能拿到心跳

**M2 — 业务 API + 前端骨架（1 天）**
1. `tiktok` 模块的 controller/service/guard，所有接口走 Prisma 真实数据
2. 前端 `/tiktok` 列表页 + 详情页（先跑通 CRUD，refresh 暂时只是更新 lastScrapedAt）
3. Sidebar 菜单 + 设置页 TikTok 配置 tab
4. `tiktok.module.ts` 注入 BullModule.registerQueue("tt-scrape")
5. **验证**：管理员/销售两种角色登录看到的列表不同；上传 cookie 文件能加密落库

**M3 — 真实采集（2 天）**
1. `browser-pool.service.ts`（Playwright Chromium 池）
2. `affiliate-scraper.service.ts`（先实现公开主页抓视频指标 → 再加 Affiliate 后台抓 GMV）
3. `monitor-worker.service.ts`（消费 `tt-scrape` 队列）
4. cookie 解密链路打通
5. **验证**：手动 refresh 一个真实账号，DB 里 TiktokVideo 有数据，TiktokAccount 累计字段更新

**M4 — 调度 & 健康 & 趋势（半天）**
1. `scheduler.service.ts` 按账号间隔自动入队
2. `/tiktok/health` 接口 + 设置页显示采集器在线状态
3. `TiktokVideoMetric` 写入 + 详情页趋势折线图
4. **验证**：scraper 离线后 `health.online=false`；视频详情有趋势曲线

---

## 验证方案（端到端）

```bash
# 1. 数据库迁移
pnpm db:generate && pnpm db:migrate

# 2. 设置环境变量
echo "TIKTOK_BOOT_KEY=$(openssl rand -base64 32)" >> .env

# 3. 启动三个服务
pnpm dev:api      # terminal 1
pnpm dev:web      # terminal 2
pnpm dev:scraper  # terminal 3 (新增)

# 4. 浏览器走通流程
# - 登录 admin → 系统设置 → TikTok 配置 tab → 点「生成 Cookie 主密钥」
# - 顶部菜单「TikTok 数据」→ 新建账号 @demo_user
# - 上传 storage_state.json（从已登录的 Chrome 导出）
# - 点击「立即刷新」→ 详情页应显示视频列表与指标
# - 用 salesperson 账号登录 → /tiktok 应只看到自己上传的账号
# - 关闭 scraper 进程 → 设置页显示「采集服务离线」
```

**自动化测试**：
- `apps/api` 加 `tiktok.service.spec.ts` 测试行级权限：salesperson 不能访问别人的 accountId
- `apps/api` 加 `crypto.service.spec.ts` 测试 cookieKey 旋转后旧 storageState 解密失败
- 集成测试在 M3 后用 Playwright 内置的 mock TikTok 站点

---

## 已知风险与缓解

| 风险 | 缓解措施 |
|---|---|
| TikTok 风控验证码 | Playwright 池打开 `--disable-blink-features=AutomationControlled`、随机化 user-agent、单浏览器单 IP（搭配 proxy）、间隔 ≥ 60min |
| Cookie 失效频繁 | 每个账号独立 storage_state，UI 显示 `cookie_expired` 提示用户重传；不做集中登录 |
| Affiliate 后台 DOM 变化 | 抓取层用 network response intercept 抓 XHR JSON 而非 DOM 选择器，更稳定 |
| 浏览器实例内存爆炸 | `browserPoolSize` 默认 5，可配置；每个 context 用完即 close，定期 hard restart browser |
| BullMQ 队列堆积 | scheduler 按账号间隔分散入队，job 超时 90s 自动失败 |
| 保留之前的 dist 仍是 Mock | M2 实现时**完全重写** tiktok.service.ts，不要复制 dist 里的 mockAccounts |

---

## 不在本次范围内（YAGNI）

- 视频自动下载（TikTokDownloader 那套）
- 直播数据 / 评论详情
- 视频维度的 Affiliate 商品逐条统计（仅做账号聚合 GMV 与视频聚合 GMV）
- 多语言、深色模式适配（沿用项目现有样式系统）
- 告警通知（M4+）
