# TikTok 数据看板 UI 设计文档

## 全局设计基线（沿用项目现有规范）

| 类别 | 规格 |
|------|------|
| 页面 H1 | `1.4rem / 700 / #0F172A`，`margin: 0` |
| 副标题 | `0.8rem / 400 / #94A3B8`，`marginTop: 4` |
| 章节标题 H3 | `0.95rem / 700 / #0F172A` |
| 表头/标签 | `0.65rem / 600 / #94A3B8`，`letter-spacing: 0.1em`，全大写 |
| 正文 | `0.875rem / 400 / #475569` |
| 数字强调 | `1.5rem / 700 / #0F172A`（卡片大数）；`1rem / 600`（行内） |
| 主色 | `#2563EB`（accent），`rgba(37,99,235,0.08)`（glow） |
| 卡片 | `bg #FFFFFF`，`border 1px #E2E8F0`，`radius 12`，`shadow 0 1px 3px rgba(0,0,0,0.06)` |
| 间距节奏 | 标题块 `marginBottom: 32`；section 间 `gap: 24`；卡片内 `padding: 16-20` |
| 按钮 | 使用现有 `.btn-primary` / `.btn-ghost` / `.btn-danger` |
| 输入 | 使用现有 `.input-field` |

### 状态 Chip 色映射（5 种 TikTok 账号状态）

| status | 文字 | 背景 | 文字色 | 边框 |
|--------|------|------|--------|------|
| `active` | 正常 | `rgba(16,185,129,0.1)` | `#10b981` | `rgba(16,185,129,0.2)` |
| `cookie_expired` | Cookie 过期 | `rgba(245,158,11,0.1)` | `#f59e0b` | `rgba(245,158,11,0.25)` |
| `captcha_blocked` | 验证码拦截 | `rgba(249,115,22,0.1)` | `#f97316` | `rgba(249,115,22,0.25)` |
| `error` | 异常 | `rgba(239,68,68,0.1)` | `#ef4444` | `rgba(239,68,68,0.2)` |
| `disabled` | 已停用 | `#F1F5F9` | `#94A3B8` | `#E2E8F0` |

Chip 规格：`padding: 2px 8px / radius: 9999 / fontSize: 0.7rem / fontWeight: 500`，左侧可加 `6×6` 圆点。

---

## 页面 1：TikTok 账号列表 `/tiktok`

### ASCII 线框图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TikTok 数据                                                                 │
│ TIKTOK DASHBOARD                                                            │
│                                                                             │
│ ┌─────────────────────┐ ┌──────────────┐ ┌─────────────┐      ┌──────────┐ │
│ │ Q  搜索 handle/昵称 │ │ 状态: 全部 ▾ │ │ 所有人│仅我 │      │ + 新建   │ │
│ └─────────────────────┘ └──────────────┘ └─────────────┘      └──────────┘ │
│                                                                             │
│ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐       │
│ │ @fashion_sara  ●正常│ │ @beauty_lily ●过期 │ │ @gadget_max  ●异常 │       │
│ │ Sara Chen          │ │ Lily Wong          │ │ Max Lee            │       │
│ │ ─────────────────  │ │ ─────────────────  │ │ ─────────────────  │       │
│ │ 12.4K   38         │ │ 45.2K   126        │ │ 8.1K    22         │       │
│ │ 粉丝    视频       │ │ 粉丝    视频       │ │ 粉丝    视频       │       │
│ │                    │ │                    │ │                    │       │
│ │ $3,240  87         │ │ $12,800 412        │ │ $980    19         │       │
│ │ GMV     订单       │ │ GMV     订单       │ │ GMV     订单       │       │
│ │ ─────────────────  │ │ ─────────────────  │ │ ─────────────────  │       │
│ │ 2 分钟前  ↻ ⇧ →    │ │ 3 小时前  ↻ ⇧ →    │ │ 12 分钟前 ↻ ⇧ →    │       │
│ └────────────────────┘ └────────────────────┘ └────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 组件树

- `TiktokListPage` (page-enter)
  - `PageHeader` { title: "TikTok 数据", subtitle: "TIKTOK DASHBOARD" }
  - `Toolbar` (flex row, gap 12, marginBottom 20)
    - `SearchInput` { placeholder, icon: 🔍, width 280 }
    - `StatusFilter` { value, options: 5 个状态 + 全部 }
    - `ScopeToggle` { admin only, value: 'all'|'mine' }
    - `Spacer` (flex: 1)
    - `Button.primary` { label: "+ 新建账号", onClick → openCreateModal }
  - `AccountGrid` (CSS grid, gap 16, repeat auto-fill minmax 300)
    - `AccountCard[]` { handle, nickname, status, metrics, lastScrapedAt }
  - `EmptyState` / `LoadingState` / `ErrorBanner`
  - `CreateAccountModal`

### 卡片样式规格

- 容器：`bg #FFFFFF / border 1px #E2E8F0 / radius 12 / padding 16 / shadow 0 1px 3px rgba(0,0,0,0.06)`
- hover：`border-color #2563EB / shadow 0 4px 16px rgba(37,99,235,0.12) / translateY(-1px) / transition 0.15s`
- handle：`0.9rem / 600 / #0F172A`；nickname：`0.75rem / 400 / #94A3B8`；chip 右上角 `position absolute`
- 分隔线：`height 1px / bg #E2E8F0 / margin 12 0`
- 数字块：值 `1.25rem / 700 / #0F172A`；标签 `0.65rem / 600 / #94A3B8 / uppercase / letterSpacing 0.08em`；2×2 grid，`gap 12`
- 时间：`0.7rem / #94A3B8`
- 操作图标按钮：`28×28`，`color #94A3B8`，hover `color #2563EB / bg rgba(37,99,235,0.08)`

### 工具条

- 搜索框：`.input-field` + `padding-left 36`，左侧 SVG 16×16；`width 280`；输入 200ms 防抖
- 状态下拉：自定义 select，外观与 `.btn-ghost` 一致
- 角色切换：分段控件（`border 1px #E2E8F0 / radius 8 / padding 2`），激活段 `bg #FFFFFF / color #2563EB / shadow 0 1px 2px rgba(0,0,0,0.06)`

### 交互

- **加载态**：6 个 skeleton 卡（`bg #F1F5F9 / shimmer`）
- **空态**：64×64 灰 SVG + "暂无 TikTok 账号" + "+ 创建第一个账号" 主按钮
- **创建弹窗**：3 字段（`handle *` 前缀 `@` 校验 `^[A-Za-z0-9._]{2,24}$` / `nickname` 可选 / `scrapeIntervalMin` 5–1440 默认 60），底部右对齐 取消/创建

---

## 页面 2：TikTok 账号详情 `/tiktok/[accountId]`

### ASCII 线框图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ←  @fashion_sara  ●正常        Sara Chen                                    │
│    最近抓取：2 分钟前                                                       │
│                                                                             │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│ │ 12,400   │ │ 38       │ │ $3,240   │ │ 87       │ │ $486     │           │
│ │ 粉丝     │ │ 视频     │ │ 累计 GMV │ │ 订单     │ │ 佣金     │           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
│                                                                             │
│ [↻ 立即刷新] [⇧ 上传 Cookie] [⏱ 修改抓取间隔]              [🗑 删除账号]   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ COVER   TITLE              发布时间   播放▾   点赞   评论   分享  GMV   │ │
│ ├─────────────────────────────────────────────────────────────────────────┤ │
│ │ [img]  夏季穿搭五件套...    2d前    241.2K  18.4K   320   1.2K  $890  ▸│ │
│ │ [img]  通勤包测评           5d前    128.5K   9.1K   142   480   $420  ▸│ │
│ │ ─── 展开行（折线图：近7天 / 近30天） ──────────────────────────────── │ │
│ │                              ‹  1  2  3  …  8  ›                        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 组件树

- `TiktokDetailPage` (page-enter)
  - `BackHeader`: `←` + handle (h1 1.2rem) + statusChip + nickname (0.8rem secondary) + lastScrapedAt
  - `SummaryRow` (5 stat cards) — 第一张左侧 `3px` 蓝色高亮条
  - `ActionBar` (左：refresh/uploadCookie/changeInterval；右：deleteAccount[btn-danger])
  - `VideoTable`
    - `TableHeader` (sortable: playCount/gmv/orderCount)
    - `TableRow[]` clickable
    - `ExpandedRow → TrendChart` (tabs: 7d/30d)
    - `Pagination`

### 样式规格

- StatCard: `flex 1 / padding 16 20 / radius 12`；值 `1.5rem / 700`；label `0.65rem / 600 / uppercase`；间距 `gap 12`
- 表格列模板: `60px 2fr 100px 90px 80px 70px 70px 80px 32px`；表头 `bg #F8FAFC`，单元 `padding 12 16`
- 可排序表头: hover `color #2563EB`，激活带 `▼/▲`
- 行 hover: `bg #F8FAFC / cursor pointer`
- 展开区: `bg #F1F5F9 / padding 24`；折线图高 `200`
- 封面: `48×48 / radius 6 / object-fit cover`
- 分页器: 圆形 `28×28`，激活 `bg #2563EB / color #fff`

### 交互

- **立即刷新**: 按钮变 spinner + "刷新中…"，成功 toast "已加入抓取队列"
- **上传 Cookie**: 大 textarea (`min-height 200 / monospace`)，placeholder "粘贴 storage_state JSON 或 document.cookie"，"校验并保存"
- **修改抓取间隔**: 滑块 5–1440 + 数字输入，下方 "下次抓取约在 14:32"
- **删除账号**: 红色危险弹窗，要求输入 handle 文本框匹配方可点亮按钮
- **行展开**: 单击切换；同一时间最多 1 行；展开行左侧 `2px` 蓝色高亮条
- **排序**: 默认 `publishedAt desc`；URL 同步 `?sort=playCount&order=desc`

---

## 页面 3：系统设置 → TikTok 配置 Tab

### ASCII 线框图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 系统设置                                                                    │
│ SYSTEM SETTINGS / ADMIN ONLY                                                │
│                                                                             │
│ [账号配置] [模型配置] [TikTok 配置]                                         │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ ●  采集服务在线   已上线 12 秒前              [查看运行日志 →]          │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ COOKIE 主密钥                                                               │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │  状态：●已配置                                                          │ │
│ │  字节长度：32                                                           │ │
│ │  最近更新：2026-05-04 18:21:34                                          │ │
│ │  [生成密钥]  [旋转密钥]                              [重置密钥]         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ 抓取参数                                                                    │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │  AFFILIATE URL                                                          │ │
│ │  [ https://affiliate.tiktok.com/connection/creator                ]     │ │
│ │  抓取超时(ms) 30000   池大小 4   默认间隔(min) 60                       │ │
│ │                                              [取消] [保存]              │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 组件树

- `SettingsPage` 新增 tab `'tiktok'`
- `TiktokConfigManage`
  - `ServiceStatusBar`（顶部）：StatusDot + 文字 + 上线时长 + 链接
  - `Section` "Cookie 主密钥"：KeyStatusCard（dl 列表）+ 三按钮
  - `Section` "抓取参数"：4 字段表单（1 + 3 grid）+ 取消/保存

### 样式规格

- ServiceStatusBar: `bg #F8FAFC / border 1px #E2E8F0 / radius 8 / padding 12 16 / marginBottom 24`；StatusDot 8×8 圆 + 1.5px 同色光晕（在线 `#10b981`，离线 `#ef4444`）；离线时改 `bg rgba(239,68,68,0.06) / border rgba(239,68,68,0.2)`
- Section H3: `0.95rem / 700`，`marginBottom 12`，section 间 `marginBottom 24`
- 配置卡: `.card / padding 20 24`
- dl: 左 `0.7rem / 600 / uppercase / #94A3B8`，右 `0.875rem / #0F172A`，分隔 `border-bottom dashed #E2E8F0`
- 三按钮组: 主操作两个用 `.btn-ghost`，重置用 `.btn-danger`，`flex / justify-content space-between`
- 表单 grid: `grid-template-columns: 1fr 1fr 1fr / gap 16`；Affiliate URL `grid-column: 1 / -1`

### 交互

- **生成密钥**: 弹窗显示一次性明文 + "复制"，关闭后不再可见
- **旋转密钥**: 二次确认（红色危险按钮）；旋转成功同样弹一次性明文
- **重置密钥**: 最严警告，要求输入 `RESET` 才能点亮按钮
- **保存抓取参数**: 字段级校验（超时 30000–300000、池 1–20、间隔 15–1440），失败下方 `0.7rem` 红色提示
- **加载态**: 整卡 skeleton；服务状态条独立轮询 5 秒
- **未配置态**: Cookie 卡中央 "尚未生成主密钥" + 居中 `[生成密钥]` 主按钮

### 可访问性

- 按钮 focus: `outline 2px solid var(--accent-glow) / outline-offset 2px`
- StatusDot 同时附 `aria-label="服务在线"` / `"服务离线"`
- chip 文字与背景对比 ≥ 4.5:1
- 表格行 `cursor pointer / tabindex 0`，回车展开

### 响应式

- ≥1280: 网格 4 列，StatCard 5 列
- 1024–1280: 3 列，StatCard 5 列（缩字号 1.25rem）
- 768–1024: 2 列，StatCard 折成 3+2，详情表隐藏 收藏/分享 列
- <768: 1 列，详情表横向滚动

---

## 实现路径建议

- `apps/web/app/(dashboard)/tiktok/page.tsx`
- `apps/web/app/(dashboard)/tiktok/[accountId]/page.tsx`
- `apps/web/components/TiktokAccountCard.tsx`（新增）
- `apps/web/components/TiktokVideoTable.tsx`（新增）
- `apps/web/components/TiktokConfigManage.tsx`（已存在空壳，按本文档实现）
- `apps/web/lib/tiktok.ts`（已存在空壳，封装 API 调用）
