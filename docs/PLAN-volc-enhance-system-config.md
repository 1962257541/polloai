# 计划：画质提升（火山引擎）配置迁移到系统设置

> 状态：**待确认，未实施**
> 创建日期：2026-06-10
> 前置依赖：确认火山引擎产品线与真实 API 参数（见「待确认问题」）

## 1. 背景与现状

`video_upscale`（画质提升）功能通过火山引擎视频超分 API 实现，当前配置方式与其他生成功能不一致：

| 功能 | 配置位置 | 生效范围 |
|------|---------|---------|
| 文字生图 / 图生视频 | `/settings` 系统设置页 → User 表（`imageModels` / `videoModels` / `apiKey`） | 每用户独立 |
| 画质提升 | 根目录 `.env.local` 的 `VOLC_*` 变量，worker 启动时读取 | 平台级，改动需重启 worker |

现存问题：

1. **凭证未配置**：`.env.local` 无 `VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY`，所有画质提升任务立即失败（已实测验证，错误回写正常）。
2. **API 参数是占位符**：`VolcEngineService`（`apps/worker/src/services/volcengine.service.ts`）中的
   Action 名（`SubmitEnhanceTask` / `QueryEnhanceTask`）、service（`vod`）、version（`2023-01-01`）、
   请求体字段（`InputVideoUrl` / `Tier` / `TargetResolution`）、响应字段路径均为猜测值，
   未对照火山官方文档校正。即使配好 AK/SK 也会报 `InvalidAction` 类错误。
3. **改配置需重启 worker**，运营/管理员无法自助维护。

## 2. 目标

- 管理员可在 `/settings` 页面维护火山引擎配置（AK/SK、增强档位、默认分辨率），保存后**立即生效，无需重启 worker**。
- 保留 env 变量作为兜底（DB 无值时回退 env），便于本地开发与容器化部署。

## 3. 非目标（明确不做）

- 不做每用户级火山凭证（火山为平台统一计费能力，代码注释已明确，见 `generations.service.ts` createVideoUpscaleTask）。
- 不做密钥加密存储（现状用户 Gemini key 也是明文入库，安全水位一致；如未来要求提升，两者一起做）。
- 不改画质提升的任务流程/状态机（已验证设计正确）。

## 4. 待确认问题（实施前必须回答）

| # | 问题 | 影响 |
|---|------|------|
| 1 | 开通的是火山哪条产品线？（VOD 画质增强 / 智能媒体处理 imp / 视觉智能视频超分） | 决定 HOST / SERVICE / VERSION / ACTION 与请求/响应字段映射 |
| 2 | 档位（tier）实际可选值有哪些？（当前占位：standard/pro/turbo/llm） | 决定设置界面下拉选项 |
| 3 | 该产品对输入视频的要求？（是否必须公网 URL、时长/大小限制、是否支持回调） | 决定本地 MinIO 方案是否要改造（公网暴露或换云存储） |
| 4 | 是否需要在前端弹窗让用户选档位？（当前只选分辨率，档位全局统一） | 决定弹窗与 parameters 透传是否扩展 |

## 5. 技术方案

### 5.1 数据层（Prisma）

新增通用平台级配置表（key-value，便于未来扩展其他全局配置）：

```prisma
model SystemConfig {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt

  @@map("system_configs")
}
```

约定 key（与 env 变量一一对应，便于回退逻辑）：

- `volc.accessKey` / `volc.secretKey`
- `volc.region` / `volc.enhanceHost` / `volc.enhanceService` / `volc.enhanceVersion`
- `volc.enhanceSubmitAction` / `volc.enhanceQueryAction`
- `volc.enhanceTier` / `volc.enhanceResolution`

> 注意：内存中有记录「polloai 库无 init baseline migration，已有数据的库慎用 db push（会误删 tiktok 列）」。
> 本次新增表使用 `prisma migrate dev` 生成增量 migration，不用 db push。

### 5.2 API 层（AdminModule）

新增两个 admin-only 接口（沿用 `JwtAuthGuard` + `RolesGuard`）：

- `GET /admin/system-config/volc` — 返回当前配置；**SK 脱敏**（只回显后 4 位，如 `****abcd`），与现有 apikey 接口风格一致。
- `PUT /admin/system-config/volc` — 整体更新；SK 字段传空/缺省表示「保持不变」，避免回显脱敏值被误存。

DTO 校验：tier / resolution 用枚举白名单（枚举值依「待确认问题 #2」定）；AK/SK 必填长度下限。

### 5.3 Worker 层

- `VolcEngineService` 改为**每次任务执行时**从 DB 读取配置（画质提升频率低，无需缓存），合并优先级：**DB > env 默认值**。
- `configured` 判定同步改为「DB 或 env 任一有 AK/SK」。
- worker 已有 PrismaService，无新增依赖。

顺手加固（同一 PR 内，改动小）：

1. `pollVolcEnhance` 增加最大轮询时长（建议 30 分钟），超时标记任务失败，避免 worker 槽位（并发仅 2）被永久占用。
2. 火山域名强制直连：当前 worker 继承系统 `HTTPS_PROXY=127.0.0.1:7890`（Gemini 科学上网用），
   `open.volcengineapi.com` 为国内节点走该代理可能不通。在 `dispatcherFor` 中对 `*.volcengineapi.com` 走 `directDispatcher`。

### 5.4 Web 层（/settings）

在系统设置页新增「画质提升（火山引擎）」区块（`/settings` 已被 middleware 限制为 admin-only）：

- AK / SK 输入框（SK 显示脱敏占位，留空 = 不修改）
- 档位下拉（选项依「待确认问题 #2」）
- 默认分辨率（1080p / 2k / 4k）
- 保存按钮 + 成功/失败提示
- 可选：「连通性测试」按钮（提交一次 query 探活，回显火山响应），方便管理员验证凭证 — 视工作量决定是否纳入

UI 遵循项目统一设计规范（参考基准 ImageTab.tsx，见 memory：Clipora UI Design System）。

## 6. 实施步骤（预估总量：半天～1 天）

1. 确认「待确认问题」#1/#2，按文档校正 `VolcEngineService` 的 Action/字段映射（含响应路径）。
2. Prisma：新增 `SystemConfig` model → `pnpm db:migrate` → `pnpm db:generate`。
3. API：AdminModule 增加 controller/service/DTO（GET/PUT），单测覆盖脱敏与「空值不覆盖」逻辑。
4. Worker：配置读取改造 + 轮询超时 + 火山域名直连。
5. Web：设置页新增区块。
6. 联调测试（见下）。

## 7. 测试计划

**单元测试**
- AdminService：SK 脱敏；PUT 空 SK 不覆盖旧值。
- VolcEngineService：用 undici `MockAgent` 断言 V4 签名头格式、提交/查询响应解析（不需真实凭证）。

**集成测试（本地）**
1. 设置页保存假 AK/SK → 提交画质提升任务 → 预期火山返回鉴权失败错误，任务 failed 且错误信息可读（验证 DB 配置生效、无需重启）。
2. 清空 DB 配置且 env 无值 → 提交任务 → 预期「未配置火山 AK/SK」快速失败。

**真实联调（需真实 AK/SK）**
1. 设置页填入真实凭证。
2. 用公网可访问的源视频提交（本地 MinIO `localhost:9000` 地址火山拉不到，见待确认问题 #3）：
   ```bash
   TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/login -H "Content-Type: application/json" \
     -d '{"email":"admin@polloai.com","password":"admin123456"}' | jq -r .token)
   curl -X POST http://localhost:3001/api/v1/generations/video-upscale \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"sourceVideoUrl":"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4","targetResolution":"1080p"}'
   ```
3. 观察 worker 日志 `[VolcEngine]` 请求/响应，确认任务走完：succeeded → 结果上传 S3 → 自动入素材库 → 前端历史可播放。

## 8. 风险与回滚

| 风险 | 缓解 |
|------|------|
| SK 明文入库 | 与现有用户 Gemini key 安全水位一致；UI 全程脱敏；未来统一加密 |
| 火山 API 字段对不上 | 全部走 SystemConfig/env 可配 + 响应多路径解析，改配置即可修复，无需发版 |
| migration 影响已有库 | 纯新增表，无破坏性变更；仍按惯例先备份再 migrate |
| 回滚 | 功能开关天然存在：清空 DB 配置即回退 env 行为；代码回滚无数据残留问题 |
