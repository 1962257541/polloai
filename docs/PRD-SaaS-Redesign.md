# PolloAI SaaS 平台重构需求文档

> **版本**: v1.1
> **日期**: 2026-04-02
> **状态**: 草案
> **变更记录**: v1.1 - 积分制改为订阅制，技术栈升级，新增 i18n 中英文支持

---

## 一、项目概述

### 1.1 项目背景

PolloAI 当前是一个内部 AI 图片/视频生成工具，仅支持 admin 和 salesperson 两种角色。现需重构为面向公众的**商用 SaaS 平台**，参考 AI-668 工坊的产品形态，提供完整的 AI 创作工作流：角色创建 → 图片生成 → 视频生成，并扩展创作策划、爆款复刻、素材管理、AI 助理、工具箱等增值功能模块。

### 1.2 核心目标

1. **商用化**：支持用户注册、订阅付费（月/半年/年），平台统一提供 AI 服务
2. **完整创作链路**：角色生成（Sora 2 Character API） → 图片生成 → 视频生成
3. **UI/UX 全面升级**：参照参考系统的浅色主题、左侧导航、双栏布局风格
4. **增值功能**：创作策划、提示词优化、爆款复刻、精选爆款、AI 助理、工具箱
5. **国际化**：支持中文 / English 双语切换
6. **可扩展架构**：多 Provider 支持（平台侧管理）、模块化设计

### 1.3 商业模式

**平台不提供 API 开放服务**，仅提供 Web 系统使用权。用户通过订阅套餐获得功能使用权限和用量配额，平台方统一管理 AI Provider 的 API Key 和资源调度。

### 1.4 技术栈

#### 保持不变

| 层 | 技术 | 说明 |
|---|------|------|
| 后端框架 | NestJS 11 | 企业级模块化框架 |
| ORM | Prisma + PostgreSQL | 数据库访问 |
| 任务队列 | BullMQ + Redis | AI 生成任务异步处理 |
| 存储 | S3 兼容（MinIO/AWS） | 对象存储 |
| 实时通信 | Redis Pub/Sub + SSE | 任务状态推送 |
| 包管理 | pnpm monorepo | 项目组织 |
| CSS | Tailwind CSS | 样式基础 |

#### 需要升级

| 项 | 当前 | 升级到 | 原因 |
|----|------|--------|------|
| React | 18 | **19** | Server Actions、优化的 SSR |
| Next.js | 14 | **15** | 配合 React 19，性能提升 |

#### 需要新增

| 库 | 用途 | 说明 |
|----|------|------|
| **shadcn/ui** (Radix) | UI 组件库 | 表单、弹窗、表格、下拉等复杂组件，统一设计规范 |
| **Zustand** | 全局状态管理 | 工作台多 Tab 联动、用户状态、订阅信息全局共享 |
| **TanStack Query** | 数据请求 | 缓存、乐观更新、自动重试、分页加载 |
| **React Hook Form + Zod** | 表单处理 | 工作台参数表单的验证、联动、重置 |
| **next-intl** | 国际化 (i18n) | 中英文双语支持 |
| **Lucide React** | 图标库 | 配合 shadcn/ui 使用 |
| **@nestjs/swagger** | API 文档 | 自动生成 Swagger 文档 |
| **@nestjs/throttler** | Rate Limiting | API 防滥用 |
| **@nestjs-modules/mailer** | 邮件服务 | 注册验证、密码重置 |
| **winston / pino** | 结构化日志 | 生产环境日志记录 |
| **crypto (AES-256)** | 加密 | API Key 加密存储 |

#### 明确不引入

| 方案 | 不引入原因 |
|------|-----------|
| 微服务拆分 | 当前单体 + Worker 架构足够，用户量上来再拆 |
| GraphQL | REST 足够，增加复杂度不值得 |
| Docker/K8s | 部署阶段考虑，不影响开发 |

---

## 二、用户体系与权限

### 2.1 角色定义

| 角色 | 说明 |
|------|------|
| **超级管理员** (super_admin) | 平台运营方，管理全局配置、用户、内容、订阅套餐、Provider |
| **普通用户** (user) | 注册用户，订阅套餐后使用平台功能进行 AI 创作 |

### 2.2 注册与登录

- 支持邮箱 + 密码注册（邮箱验证码确认）
- 支持手机号 + 验证码注册（预留，Phase 2）
- 支持第三方 OAuth 登录（预留，Phase 2）
- JWT Token 认证，支持 Refresh Token 机制
- 密码找回 / 重置功能（邮件验证）
- 所有认证页面支持中英文切换

### 2.3 订阅计费模型

**核心原则**：平台不对外提供 API，仅提供系统使用权。用户自己配置第三方API使用。

#### 付费周期

| 周期 | 说明 | 折扣 |
|------|------|------|
| **月付** (monthly) | 按月订阅，随时取消 | 无 |
| **半年付** (semi_annual) | 一次付 6 个月 | ~16% 折扣 |
| **年付** (annual) | 一次付 12 个月 | ~25% 折扣 |

---

## 三、国际化 (i18n)

### 3.1 支持语言

| 语言 | Locale | 说明 |
|------|--------|------|
| 简体中文 | `zh-CN` | 默认语言 |
| English | `en` | 英文 |

### 3.2 实现方案

- 使用 **next-intl** 实现前端国际化
- 路由结构：`/[locale]/dashboard`、`/[locale]/workspace` 等
- 语言切换入口：顶栏右侧（中/EN 切换按钮）
- 用户偏好记忆：语言选择保存到用户配置，下次登录自动应用
- 浏览器语言自动检测：首次访问根据 `Accept-Language` 自动选择

### 3.3 翻译范围

| 范围 | 说明 |
|------|------|
| UI 文案 | 所有按钮、标签、提示、菜单、表头等静态文案 |
| 表单验证 | 错误提示信息 |
| 通知/Toast | 操作成功/失败提示 |
| 邮件模板 | 注册验证、密码重置等邮件 |
| 文档说明 | `/docs` 页面内容 |
| 套餐描述 | 套餐名称、功能说明 |
| 错误页面 | 404、500 等 |

### 3.4 后端国际化

- API 错误消息返回 i18n key，前端根据当前语言显示
- 邮件模板根据用户语言偏好选择对应语言版本
- 数据库存储内容（如精选爆款标题/描述）支持多语言字段

---

## 四、整体布局与导航

### 4.1 全局布局

采用**左侧固定导航栏 + 右侧内容区**的经典 SaaS 布局：

```
┌──────────┬──────────────────────────────────────────┐
│          │  顶栏：Logo · 面包屑 · 语言切换 · 通知 · 用户 │
│  左侧    ├──────────────────────────────────────────┤
│  导航栏  │                                          │
│          │          主内容区                          │
│          │    （双栏布局：左操作 + 右预览）              │
│          │                                          │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

### 4.2 左侧导航菜单结构

```
Logo + 品牌名
────────────
首页（仪表盘）
工作台
   ├─ 角色生成      ← Tab 切换
   ├─ 图片生成      ← Tab 切换
   └─ 视频生成      ← Tab 切换
创作策划
爆款复刻
精选爆款
任务记录
素材库
工具箱
文档说明
AI 助理
────────────
个人中心
订阅管理          ← 原"积分管理"改为"订阅管理"
偏好设置
────────────
收起/展开
```

> 注：原 "API 设置" 从用户侧移除。API Provider 统一由平台管理员在管理后台配置。Pro/Enterprise 套餐用户可在偏好设置中配置自定义 Provider。

### 4.3 视觉风格

- **主题**：浅色/白色背景为主，清爽专业
- **强调色**：蓝色系 (#2563EB 为主色调)
- **导航栏**：白底，选中项蓝色高亮背景
- **内容区**：白色卡片 + 浅灰背景 (#F8FAFC)
- **圆角**：统一使用 8-12px 圆角（shadcn/ui 默认）
- **字体**：中文使用系统默认（苹方/微软雅黑），英文使用 Inter
- **顶栏**：当前页面标题 + 右侧（语言切换 | 通知铃铛 | 用户头像下拉）
- **组件规范**：统一使用 shadcn/ui 组件，确保设计一致性

---

## 五、功能模块详细需求

### 5.1 首页（仪表盘）

**路由**: `/[locale]/dashboard`

展示用户关键数据概览：
- 当前套餐信息 + 到期时间
- 本月用量概览（角色/图片/视频生成次数 vs 配额）— 进度条形式
- 近期生成任务（最新 5 条）
- 快捷入口卡片（角色生成、图片生成、视频生成）
- 公告/新功能提示区域
- 套餐即将到期/用量即将耗尽提醒

---

### 5.2 工作台

**路由**: `/[locale]/workspace`

工作台是核心创作模块，通过**顶部 Tab 切换**在三个子功能间导航：`角色生成` | `图片生成` | `视频生成`。每个 Tab 下采用**左右双栏布局**：左侧为任务创建表单，右侧为结果预览区。

顶部 Tab 旁显示用户当前套餐和剩余用量。

#### 5.2.1 角色生成 Tab

**API**: Sora 2 Character API

**左侧 - 任务创建**：

| 字段 | 类型 | 说明 |
|------|------|------|
| 模型选择 | 下拉 | Sora 2 Character 系列模型（平台预配置可用模型） |
| 角色名称 | 文本输入 | 必填，用于后续引用 |
| 数量 | 数字输入 | 生成数量 1-4 |
| 角色描述 | 多行文本 | 详细描述角色外貌、性格、风格等特征，支持占位符提示 |
| 参考图片 | 图片上传 | 可选，上传参考图片辅助角色生成 |
| 高级参数展开 | 折叠面板 | 包含附加参数 |
| └ 风格 | 下拉 | 写实 / 动漫 / 3D / 像素等 |
| └ 分辨率 | 下拉 | 预设分辨率选项 |
| 用量提示 | 文本 | `本次消耗 1 次角色生成配额（剩余 XX/XX）` |
| 创建任务 | 按钮 | 蓝色主按钮，提交生成 |

**右侧 - 我的角色库**：

- 标题：`我的角色库` / `My Characters`
- 使用提示文案（当无角色时）
- 角色卡片列表（宫格展示）：
  - 角色头像/预览图
  - 角色名称
  - 创建时间
  - 操作：使用（跳转图片生成并自动关联） / 编辑 / 删除
- 支持搜索/筛选
- 分页

#### 5.2.2 图片生成 Tab

**左侧 - 任务创建**：

| 字段 | 类型 | 说明 |
|------|------|------|
| 模型选择 | 下拉 | 可选图片生成模型（平台预配置） |
| 角色关联 | 下拉 | 可选关联已创建的角色 |
| 提示词 | 多行文本 | 图片描述提示词 |
| 反向提示词 | 多行文本 | 可选，描述不想要的元素 |
| 宽高比 | 下拉 | 1:1 / 16:9 / 9:16 / 4:3 / 3:4 |
| 数量 | 数字输入 | 1-4 |
| 格式 | 下拉 | PNG / JPEG / WEBP |
| 高级参数 | 折叠面板 | |
| └ 质量 | 下拉 | low / medium / high / auto |
| └ 种子 | 数字输入 | 可选，固定随机种子 |
| 用量提示 | 文本 | `本次消耗 X 次图片生成配额（剩余 XX/XX）` |
| 创建任务 | 按钮 | 蓝色主按钮 |

**右侧 - 图片预览**：

- 标题：`图片预览` / `Image Preview`
- 使用提示文案（未生成时显示）
- 生成中：进度条 + 状态文字
- 生成完成：图片展示 + 操作按钮：
  - 下载原图
  - 保存到素材库
  - 用于视频生成（跳转视频生成 Tab 并自动填充）
  - 重新生成
- 历史记录列表（当前会话）

#### 5.2.3 视频生成 Tab

**左侧 - 任务创建**：

| 字段 | 类型 | 说明 |
|------|------|------|
| 模型选择 | 下拉 | VEO 3.1 等视频模型（平台预配置） |
| 角色关联 | 下拉 | 可选关联已创建的角色 |
| 生成方式 | 下拉 | 图片转视频 (i2v) / 文字转视频 (t2v) |
| 参考图片 | 图片上传/素材选择 | i2v 模式必填 |
| 提示词 | 多行文本 | 视频动作/场景描述 |
| 时长 | 数字输入 | 视频秒数（如 4-8 秒） |
| 高级参数 | 折叠面板 | |
| └ FPS | 下拉 | 24 / 30 / 60 |
| └ 分辨率 | 下拉 | 720p / 1080p |
| 用量提示 | 文本 | `本次消耗 1 次视频生成配额（剩余 XX/XX）` |
| 拼接视频选项 | 复选框 | 可选，生成后自动与之前片段拼接 |
| 创建任务 | 按钮 | 蓝色主按钮 |

**右侧 - 视频预览**：

- 标题：`视频预览` / `Video Preview`
- 使用提示文案
- 生成中：进度条 + 预计时间
- 生成完成：视频播放器 + 操作：
  - 下载视频
  - 保存到素材库
  - 继续生成下一片段
- 历史片段时间轴

---

### 5.3 创作策划

**路由**: `/[locale]/planning`

AI 辅助创作策划，用户输入需求，AI 生成完整创作方案。

**左侧 - 创作需求表单**：

| 字段 | 类型 | 说明 |
|------|------|------|
| 模型选择 | 下拉 | 平台配置的 LLM 模型 |
| 创作类型 | 下拉 | 短视频 / 广告 / 故事 / 产品展示 等 |
| 主题描述 | 多行文本 | 描述创作主题和核心需求 |
| 目标平台 | 多选 | 抖音 / 小红书 / B站 / YouTube / TikTok |
| 风格偏好 | 下拉 | 写实 / 动漫 / 混合 |
| 时长目标 | 下拉 | 15秒 / 30秒 / 60秒 / 自定义 |
| 参考链接 | 文本 | 可选，提供参考视频/内容链接 |
| 附加要求 | 多行文本 | 其他补充说明 |
| 历史策划案 | 下拉 | 可加载以往的策划案继续编辑 |
| 生成策划方案 | 按钮 | 蓝色主按钮 |

**右侧 - 创作方案**：

- 标题：`创作方案` / `Creative Plan`
- 顶部操作：`下载方案` 按钮
- 方案内容（Markdown 渲染）：
  - 创意概述
  - 分镜脚本（表格形式）
  - 角色设定建议
  - 提示词建议（可一键复制到工作台）
  - 配乐/音效建议
  - 发布建议
- 底部操作：一键执行（自动在工作台创建对应任务）

---

### 5.4 提示词优化

**路由**: `/[locale]/workspace`（工作台子功能，Tab 旁的辅助功能按钮）

提示词优化作为工作台的辅助功能，帮助用户优化提示词以获得更好的生成效果。

**UI**: 弹窗或侧面板

**功能分为两种模式**：

#### 模式一：智能优化

| 字段 | 类型 | 说明 |
|------|------|------|
| AI 模型 | 下拉 | 平台配置的优化用 LLM |
| 原始提示词 | 多行文本 | 用户输入的原始描述 |
| 优化方向 | 多选 | 更详细 / 更有创意 / 更写实 / 适配特定模型 |
| 目标模型 | 下拉 | 优化后用于哪个生成模型 |
| 语言 | 下拉 | 中文 / 英文 / 中英混合 |
| 开始优化 | 按钮 | |

#### 模式二：模板优化

| 字段 | 类型 | 说明 |
|------|------|------|
| 基础描述 | 多行文本 | 简单描述场景 |
| 参考图片 | 图片上传 | 可选，上传参考图 1 张，可附带说明 |
| 主体描述 | 文本 | 画面中主体 |
| 风格选择 | 下拉 | 写实摄影 / 油画 / 水彩 / 3D渲染 等 |
| 镜头选择 | 下拉 | 特写 / 中景 / 全景 / 鸟瞰 等 |
| 光线选择 | 下拉 | 自然光 / 黄金时刻 / 霓虹 / 工作室灯光 |
| 生成提示词 | 按钮 | |

**右侧 - 优化结果**：

- 顶部提示文案（中英文）
- 优化后的提示词（可编辑）
- 操作按钮：
  - 复制
  - 应用到工作台（自动填充到当前 Tab 的提示词输入框）
  - 重新优化

---

### 5.5 爆款复刻

**路由**: `/[locale]/replicate`

分析爆款视频并复刻其风格和内容。

**左侧 - 创建复刻任务**：

| 字段 | 类型 | 说明 |
|------|------|------|
| 视频来源 | 单选 | 上传视频 / 输入链接 / 从精选爆款选择 |
| 视频上传/链接 | 上传/文本 | 根据来源类型展示对应输入 |
| AI 分析描述 | 只读文本 | AI 自动分析视频内容后生成的描述（可编辑） |
| 复刻模式 | 单选 | 自动复刻 / 自定义复刻 |
| 模型选择 | 下拉 | 平台配置的生成模型 |
| 风格调整 | 滑块 | 与原视频相似度 0%-100% |
| 自定义修改 | 多行文本 | 需要修改的部分（如替换角色、更换场景等） |
| 分辨率 | 下拉 | 输出分辨率 |
| 用量提示 | 文本 | 显示消耗配额 |
| 开始复刻 | 按钮 | 蓝色主按钮 |

**右侧 - 视频预览**：

- 原视频播放器（如有）
- 复刻进度
- 复刻结果视频播放器
- 对比模式：左右对比原版/复刻版
- 操作：下载 / 保存到素材库 / 再次调整

---

### 5.6 精选爆款

**路由**: `/[locale]/trending`

平台运营的爆款内容展示广场。

**页面结构**：

- **顶部筛选栏**：
  - 分类 Tab：`全部` | `穿搭` | `电商` | `知识类` | `全部分类`
  - 排序：最新 / 最热 / 收藏最多
  - 搜索框

- **内容区 - 卡片瀑布流/网格**：
  - 示例卡片区域标题：`示例卡片` / `Example Cards`
  - 卡片内容：
    - 视频/图片缩略图（支持悬浮预览）
    - 标题（支持中英文）
    - 标签
    - 点赞/收藏数
    - 创作者信息
  - 点击卡片进入详情页：
    - 完整视频播放
    - 创作参数展示（提示词、模型、参数等）
    - 一键复刻按钮（跳转爆款复刻页，自动填充）
    - 一键使用提示词（跳转工作台）

- **管理员功能**：
  - 上传/编辑/删除精选内容（支持中英文标题/描述）
  - 置顶/排序管理
  - 分类管理

---

### 5.7 任务记录

**路由**: `/[locale]/tasks`

用户所有生成任务的统一管理视图。

**页面结构**：

- **筛选栏**：
  - 记录类型筛选：全部 / 角色生成 / 图片生成 / 视频生成 / 提示词优化
  - 时间范围：今天 / 最近7天 / 最近30天 / 自定义
  - 状态筛选：全部 / 排队中 / 生成中 / 已完成 / 已失败 / 已取消
  - 搜索框（按提示词关键字搜索）
  - 每页条数：10 / 20 / 50

- **任务列表（表格视图）**：

| 列 | 说明 |
|----|------|
| ID | 任务 ID（可点击查看详情） |
| 类型 | 角色/图片/视频/提示词 |
| 模型 | 使用的模型名称 |
| 状态 | 排队中/生成中/已完成/失败/已取消（带颜色标签） |
| 创建时间 | |
| 完成时间 | |
| 操作 | 查看详情 / 下载 / 重新生成 / 删除 |

- **分页**：底部分页控件

---

### 5.8 素材库

**路由**: `/[locale]/materials`

用户的资源管理中心，管理上传的和生成的所有素材。

**页面结构**：

- **顶部操作栏**：
  - `上传素材` 按钮（支持批量上传）
  - 存储用量指示：`已用 XX / 配额 XX`
  - 支持拖拽上传区域

- **筛选栏**：
  - 来源筛选：全部 / 我上传的 / 角色生成 / 图片生成 / 视频生成
  - 类型筛选：全部 / 图片 / 视频
  - 排序：最新 / 最早 / 名称
  - 搜索框

- **素材网格/列表视图**：
  - 缩略图
  - 文件名
  - 类型
  - 大小
  - 上传/生成时间
  - 操作：预览 / 下载 / 使用（跳转工作台） / 删除

- **批量操作**：
  - 多选模式
  - 批量下载 / 批量删除

---

### 5.9 工具箱

**路由**: `/[locale]/tools`

提供多种 AI 辅助工具，通过**顶部 Tab 切换**不同工具。

> **套餐限制**：Free 套餐不可用，Basic 套餐可用基础功能，Pro/Enterprise 全部功能。

**Tab 列表**：`图片画布` | `视频编辑` | `字幕去除` | `任务记录`

右上角切换：`媒体工具` / `流程工具`

#### 5.9.1 图片画布

- 类似简易版图片编辑器
- 新建空白工程 / 打开工程文件
- 工程列表弹窗：搜索、历史工程列表
- 画布操作：缩放、移动、图层管理
- 基础编辑：裁剪、调整大小、旋转、文字叠加

#### 5.9.2 视频编辑

| 功能 | 说明 |
|------|------|
| 视频素材 | 选择要编辑的视频（上传或从素材库选择） |
| 基础编辑 | 裁剪、拼接、调速 |
| 添加配音 | 选择配音角色、上传音频 |
| 视频配乐 | 背景音乐选择（从素材库或上传） |
| 视频比例 | 横屏 / 竖屏 / 方形 |
| 幕布颜色 | 设置背景/边框颜色 |
| 视频封面 | 选择或上传封面图 |
| 右侧任务面板 | 任务详情和进度显示 |

#### 5.9.3 字幕去除

| 功能 | 说明 |
|------|------|
| 去除方式 | AI 自动检测 / 手动框选 |
| 视频上传 | 上传需要去除字幕的视频 |
| 字幕检测预览 | 预览检测到的字幕区域 |
| 去除模式 | 全部去除 / 仅去除选中区域 |
| 输出设置 | 格式、分辨率、质量 |
| 右侧任务面板 | 任务详情和进度显示 |

#### 5.9.4 工具箱任务记录

- 独立于主任务记录
- 筛选：全部工程 / 视频编辑 / 图片画布 / 字幕去除 / 配音记录
- 表格展示工具箱相关任务

---

### 5.10 AI 助理

**路由**: `/[locale]/assistant`

集成 LLM 对话功能，辅助创作过程。

**页面结构**：

- **左侧 - 对话列表**：
  - `+` 新建对话按钮
  - 历史对话列表（标题 + 时间）
  - 支持搜索历史对话
  - 对话管理：重命名 / 删除

- **顶部 - 模型选择**：
  - 模型下拉：平台配置的可用 LLM 模型

- **中部 - 对话区域**：
  - 初始状态：AI 助理欢迎页 + 快捷提问建议（中英文）
  - 消息气泡：用户消息 / AI 回复
  - 支持 Markdown 渲染
  - 支持代码高亮

- **底部 - 输入区**：
  - 多行文本输入框
  - 发送按钮
  - 提示：`Enter 发送，Shift+Enter 换行` / `Enter to send, Shift+Enter for new line`
  - 附件上传（图片/文件）

---

### 5.11 文档说明

**路由**: `/[locale]/docs`

平台使用文档和帮助中心。

**页面结构**：

- 标题：`产品说明与使用须知` / `Product Guide`
- `在线使用说明` 按钮（跳转完整文档站）
- 卡片式布局展示各模块说明（中英文内容）：
  - 使用指南
  - 基本配置
  - 核心功能
  - 使用限制条件
  - 定价与费用
  - 素材与基础
  - 创作与合规

---

### 5.12 个人中心

**路由**: `/[locale]/profile`

| 功能 | 说明 |
|------|------|
| 基本信息 | 头像、昵称、邮箱（可编辑） |
| 修改密码 | 旧密码 + 新密码确认 |
| 账户安全 | 登录记录、设备管理 |
| 通知偏好 | 邮件通知开关、站内通知开关 |

---

### 5.13 订阅管理

**路由**: `/[locale]/subscription`

| 功能 | 说明 |
|------|------|
| 当前套餐 | 显示套餐名称、状态（活跃/即将到期/已过期）、到期时间 |
| 本月用量 | 各功能模块用量 vs 配额的进度条展示 |
| 用量历史 | 按日/周/月查看各功能用量趋势图 |
| 升级/续费 | 套餐对比表 + 购买/升级按钮 |
| 付费周期选择 | 月付 / 半年付 / 年付 切换，显示对应价格和折扣 |
| 订单历史 | 历史订单列表（订单号、套餐、金额、支付时间、状态） |
| 发票管理 | 申请开发票（Phase 2） |

**套餐对比表组件**：
- 卡片式展示各套餐
- 当前套餐高亮标记
- 功能对比矩阵
- 价格根据选择的付费周期动态变化
- 显示折扣信息（半年付省 XX，年付省 XX）

---

### 5.14 偏好设置

**路由**: `/[locale]/preferences`

| 设置项 | 类型 | 说明 |
|--------|------|------|
| 界面语言 | 下拉 | 简体中文 / English |
| 主题模式 | 切换 | 浅色 / 深色 / 跟随系统 |
| 默认图片格式 | 下拉 | PNG / JPEG / WEBP |
| 默认图片质量 | 下拉 | low / medium / high / auto |
| 默认视频时长 | 数字 | 4-8 秒 |
| 生成完成通知 | 开关 | 浏览器通知 |
| 自动保存到素材库 | 开关 | 生成的内容是否自动保存 |
| 自定义 Provider | 区域 | 仅 Pro/Enterprise 可见，配置自有 API Provider |

---

## 六、管理后台（超级管理员）

### 6.1 用户管理

- 用户列表（搜索、筛选、分页）
- 用户详情：基本信息、套餐信息、用量统计
- 操作：禁用/启用账户、调整套餐、手动调整配额
- 批量操作

### 6.2 套餐管理

- 套餐 CRUD（名称、价格、配额、功能列表）
- 价格配置：分别设置月付/半年付/年付价格
- 套餐启用/停用
- 折扣码/优惠活动管理（Phase 2）

### 6.3 Provider 管理（平台级）

- 管理平台统一的 AI Provider（Gemini、OpenAI 等）
- 配置 API Key、Base URL、优先级
- 模型可用性管理：哪些模型对哪些套餐可用
- 用量监控和成本统计
- fallback 策略配置

### 6.4 精选内容管理

- 精选爆款 CRUD（支持中英文标题/描述）
- 分类管理
- 置顶/排序

### 6.5 数据统计

- 用户增长趋势
- 订阅收入统计
- 各功能使用频次
- AI 调用成本统计
- Provider 调用量分布

### 6.6 系统配置

- 全局公告管理（支持中英文）
- 邮件模板管理
- 系统参数配置

---

## 七、数据模型设计（新增/变更）

### 7.1 新增表

```prisma
// ==================== 用户扩展 ====================

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  phone         String?   @unique
  passwordHash  String
  nickname      String?
  avatar        String?
  role          UserRole  @default(user)
  locale        String    @default("zh-CN")  // 用户语言偏好
  isActive      Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // 关联
  characters    Character[]
  tasks         GenerationTask[]
  materials     Material[]
  conversations Conversation[]
  subscription  Subscription?
  usageRecords  UsageRecord[]
  providers     UserProvider[]    // 仅 Pro/Enterprise

  @@index([email])
}

// ==================== 角色库 ====================

model Character {
  id          String   @id @default(cuid())
  userId      String
  name        String
  description String?  @db.Text
  style       String?
  avatarUrl   String?
  parameters  Json?    // Sora 2 Character API 参数
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id])
  tasks       GenerationTask[]

  @@index([userId, createdAt])
}

// ==================== 订阅系统 ====================

model Plan {
  id              String    @id @default(cuid())
  name            String    @unique         // 内部标识：free / basic / pro / enterprise
  displayNameZh   String                    // 中文显示名
  displayNameEn   String                    // 英文显示名
  descriptionZh   String?   @db.Text
  descriptionEn   String?   @db.Text
  type            PlanType
  priceMonthly    Decimal   @default(0)     // 月付价格（元）
  priceSemiAnnual Decimal   @default(0)     // 半年付价格
  priceAnnual     Decimal   @default(0)     // 年付价格
  quotas          Json                      // 用量配额 JSON
  features        Json                      // 功能列表 JSON（中英文）
  sortOrder       Int       @default(0)     // 排序
  isActive        Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  subscriptions   Subscription[]
}

// quotas JSON 结构示例：
// {
//   "character_generation": 50,    // -1 表示不限
//   "image_generation": 200,
//   "video_generation": 30,
//   "prompt_optimization": 100,
//   "creative_planning": 30,
//   "ai_assistant_messages": 500,
//   "replication": 5,
//   "storage_mb": 5120,
//   "concurrent_tasks": 3,
//   "priority_queue": false,
//   "custom_provider": false,
//   "toolbox_level": "basic"       // "none" | "basic" | "full"
// }

model Subscription {
  id            String             @id @default(cuid())
  userId        String             @unique
  planId        String
  billingCycle  BillingCycle       // monthly / semi_annual / annual
  status        SubscriptionStatus // active / expired / cancelled / past_due
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  cancelledAt   DateTime?
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  user          User               @relation(fields: [userId], references: [id])
  plan          Plan               @relation(fields: [planId], references: [id])
  orders        Order[]

  @@index([userId])
  @@index([status, currentPeriodEnd])
}

model Order {
  id              String      @id @default(cuid())
  userId          String
  subscriptionId  String?
  planId          String
  billingCycle    BillingCycle
  amount          Decimal                  // 实际支付金额
  currency        String      @default("CNY")
  status          OrderStatus              // pending / paid / failed / refunded
  paymentMethod   String?                  // alipay / wechat / stripe
  paymentId       String?     @unique      // 第三方支付订单号
  paidAt          DateTime?
  createdAt       DateTime    @default(now())

  subscription    Subscription? @relation(fields: [subscriptionId], references: [id])

  @@index([userId, createdAt])
  @@index([status])
}

// ==================== 用量追踪 ====================

model UsageRecord {
  id          String    @id @default(cuid())
  userId      String
  quotaKey    String    // 对应 quotas JSON 的 key，如 "image_generation"
  periodStart DateTime  // 当前计费周期开始时间
  used        Int       @default(0)  // 当前周期已使用量
  limit       Int                     // 当前周期配额上限（-1 = 不限）

  user        User      @relation(fields: [userId], references: [id])

  @@unique([userId, quotaKey, periodStart])
  @@index([userId, periodStart])
}

// ==================== 用户自定义 Provider（Pro/Enterprise） ====================

model UserProvider {
  id        String   @id @default(cuid())
  userId    String
  name      String
  type      String   // gemini / openai / dashscope
  apiKey    String   // AES-256 加密存储
  baseUrl   String?
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user      User     @relation(fields: [userId], references: [id])

  @@unique([userId, name])
}

// ==================== 平台 Provider（管理员管理） ====================

model PlatformProvider {
  id        String   @id @default(cuid())
  name      String   @unique
  type      String   // gemini / openai / dashscope
  apiKey    String   // AES-256 加密存储
  baseUrl   String?
  priority  Int      @default(0)         // 优先级，越大越优先
  enabled   Boolean  @default(true)
  models    Json?    // 该 Provider 可用模型列表
  planAccess Json?   // 各套餐可访问的模型配置
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// ==================== AI 助理 ====================

model Conversation {
  id        String    @id @default(cuid())
  userId    String
  title     String    @default("New Chat")
  model     String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  user      User      @relation(fields: [userId], references: [id])
  messages  Message[]

  @@index([userId, updatedAt])
}

model Message {
  id             String   @id @default(cuid())
  conversationId String
  role           String   // user / assistant / system
  content        String   @db.Text
  createdAt      DateTime @default(now())

  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
}

// ==================== 精选爆款 ====================

model TrendingContent {
  id            String   @id @default(cuid())
  titleZh       String                    // 中文标题
  titleEn       String?                   // 英文标题
  descriptionZh String?  @db.Text
  descriptionEn String?  @db.Text
  category      String
  mediaType     String   // image / video
  mediaUrl      String
  thumbnailUrl  String?
  tags          String[]
  prompt        String?  @db.Text
  model         String?
  parameters    Json?
  likes         Int      @default(0)
  views         Int      @default(0)
  isPinned      Boolean  @default(false)
  createdBy     String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([category, createdAt])
  @@index([isPinned, createdAt])
}

// ==================== 枚举 ====================

enum UserRole {
  super_admin
  user
}

enum PlanType {
  free
  basic
  pro
  enterprise
}

enum BillingCycle {
  monthly
  semi_annual
  annual
}

enum SubscriptionStatus {
  active
  expired
  cancelled
  past_due
}

enum OrderStatus {
  pending
  paid
  failed
  refunded
}
```

### 7.2 现有表变更

| 表 | 变更 |
|---|------|
| GenerationTask | 新增 `type` 值：`character`；新增 `characterId` 可选关联；移除 `creditsConsumed` |
| Material | 新增 `source` 值：`character` |
| User | 移除 `apiKey`、`credits` 字段；新增 `locale`、`isActive` 字段；移除 `plan` 字段（改用 Subscription 关联） |

---

## 八、API 接口规划

### 8.1 新增接口

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/auth/register` | 用户注册 |
| POST | `/auth/verify-email` | 邮箱验证 |
| POST | `/auth/forgot-password` | 密码找回 |
| POST | `/auth/reset-password` | 密码重置 |
| POST | `/auth/refresh` | 刷新 Token |
| GET | `/users/me` | 获取当前用户信息（含套餐、用量） |
| PATCH | `/users/me` | 更新用户信息 |
| PATCH | `/users/me/password` | 修改密码 |
| PATCH | `/users/me/locale` | 更新语言偏好 |
| --- | --- | **角色管理** |
| POST | `/characters` | 创建角色（调用 Sora 2 Character API） |
| GET | `/characters` | 获取角色列表 |
| GET | `/characters/:id` | 获取角色详情 |
| PATCH | `/characters/:id` | 更新角色 |
| DELETE | `/characters/:id` | 删除角色 |
| --- | --- | **订阅** |
| GET | `/subscription` | 获取当前订阅信息 |
| GET | `/subscription/plans` | 获取可用套餐列表 |
| POST | `/subscription/checkout` | 创建支付订单 |
| POST | `/subscription/webhook` | 支付回调 |
| POST | `/subscription/cancel` | 取消订阅 |
| GET | `/subscription/orders` | 订单历史 |
| --- | --- | **用量** |
| GET | `/usage` | 获取当前周期用量概览 |
| GET | `/usage/history` | 用量历史趋势 |
| --- | --- | **AI 助理** |
| GET | `/conversations` | 获取对话列表 |
| POST | `/conversations` | 新建对话 |
| GET | `/conversations/:id/messages` | 获取对话消息 |
| POST | `/conversations/:id/messages` | 发送消息（流式返回） |
| PATCH | `/conversations/:id` | 重命名对话 |
| DELETE | `/conversations/:id` | 删除对话 |
| --- | --- | **精选爆款** |
| GET | `/trending` | 获取精选内容列表（分页/筛选） |
| GET | `/trending/:id` | 获取详情 |
| --- | --- | **创作策划** |
| POST | `/planning/generate` | 生成创作方案（流式返回） |
| GET | `/planning/history` | 获取历史策划案 |
| --- | --- | **提示词优化** |
| POST | `/prompts/optimize` | 优化提示词 |
| POST | `/prompts/template` | 模板式提示词生成 |
| --- | --- | **工具箱** |
| POST | `/tools/subtitle-remove` | 字幕去除任务 |
| POST | `/tools/video-edit` | 视频编辑任务 |
| GET | `/tools/tasks` | 工具箱任务列表 |
| --- | --- | **管理员 - Provider** |
| GET | `/admin/providers` | 获取平台 Provider 列表 |
| POST | `/admin/providers` | 添加 Provider |
| PATCH | `/admin/providers/:id` | 更新 Provider |
| DELETE | `/admin/providers/:id` | 删除 Provider |
| POST | `/admin/providers/:id/test` | 测试连通性 |
| --- | --- | **管理员 - 套餐** |
| POST | `/admin/plans` | 创建套餐 |
| PATCH | `/admin/plans/:id` | 更新套餐 |
| DELETE | `/admin/plans/:id` | 删除套餐 |
| --- | --- | **管理员 - 用户** |
| GET | `/admin/users` | 用户列表 |
| PATCH | `/admin/users/:id` | 编辑用户 |
| PATCH | `/admin/users/:id/quota` | 调整用户配额 |
| --- | --- | **管理员 - 精选内容** |
| POST | `/admin/trending` | 创建精选内容 |
| PATCH | `/admin/trending/:id` | 编辑精选内容 |
| DELETE | `/admin/trending/:id` | 删除精选内容 |
| --- | --- | **管理员 - 统计** |
| GET | `/admin/statistics/overview` | 数据概览 |
| GET | `/admin/statistics/usage` | 用量统计 |
| GET | `/admin/statistics/revenue` | 收入统计 |

### 8.2 现有接口调整

| 接口 | 变更 |
|------|------|
| `POST /generations/image` | 增加 `characterId` 参数；增加用量配额检查和扣减逻辑；使用平台 Provider |
| `POST /generations/video-from-image` | 增加 `characterId` 参数；增加用量配额检查和扣减逻辑；使用平台 Provider |
| `POST /auth/login` | 返回值增加 `subscription`、`locale` 字段；移除 `credits` |

### 8.3 API 中间件 - 用量配额守卫

所有消耗用量的接口增加 `QuotaGuard` 中间件：

```typescript
// 伪代码
@UseGuards(JwtAuthGuard, QuotaGuard('image_generation'))
@Post('/generations/image')
async createImageGeneration() { ... }
```

QuotaGuard 逻辑：
1. 查询用户当前订阅套餐
2. 查询当前计费周期的 UsageRecord
3. 判断 `used < limit`（limit = -1 表示不限）
4. 通过则放行，否则返回 `403 Quota Exceeded`
5. 任务完成后更新 `used + 1`

---

## 九、前端路由规划

```
/                                → 根据浏览器语言重定向到 /zh-CN 或 /en
/[locale]                        → 重定向到 /[locale]/dashboard

/[locale]/login                  → 登录页
/[locale]/register               → 注册页
/[locale]/forgot-password        → 密码找回

/[locale]/dashboard              → 首页仪表盘
/[locale]/workspace              → 工作台（角色/图片/视频 Tab）
/[locale]/planning               → 创作策划
/[locale]/replicate              → 爆款复刻
/[locale]/trending               → 精选爆款
/[locale]/tasks                  → 任务记录
/[locale]/materials              → 素材库
/[locale]/tools                  → 工具箱（画布/编辑/字幕/记录 Tab）
/[locale]/assistant              → AI 助理
/[locale]/docs                   → 文档说明

/[locale]/profile                → 个人中心
/[locale]/subscription           → 订阅管理
/[locale]/preferences            → 偏好设置

/[locale]/admin                  → 管理后台
/[locale]/admin/users            → 用户管理
/[locale]/admin/plans            → 套餐管理
/[locale]/admin/providers        → Provider 管理
/[locale]/admin/trending         → 精选内容管理
/[locale]/admin/statistics       → 数据统计
/[locale]/admin/settings         → 系统配置
```

---

## 十、非功能性需求

### 10.1 性能

- 页面首屏加载 < 2s
- API 响应时间 < 200ms（非 AI 生成接口）
- SSE 推送延迟 < 500ms
- 支持并发 100+ 用户同时使用

### 10.2 安全

- API Key 加密存储（AES-256）
- 密码使用 bcrypt 哈希
- 所有 API 接口 Rate Limiting（@nestjs/throttler）
- CSRF / XSS 防护
- 敏感操作日志审计
- 支付接口签名验证

### 10.3 可用性

- 响应式设计，支持 1280px+ 分辨率
- 移动端适配（Phase 2）
- 操作反馈及时（loading、toast、进度条）
- 错误信息友好可理解（中英文）
- 所有 UI 文案支持 i18n

### 10.4 可维护性

- 模块化代码组织
- 统一的错误处理机制
- API 文档自动生成（Swagger）
- 结构化日志（winston/pino）
- i18n 翻译文件统一管理

---

## 十一、实施阶段规划

### Phase 1：核心重构（5-7 周）

- [ ] **技术栈升级**：React 19 + Next.js 15 + shadcn/ui + Zustand + TanStack Query + React Hook Form
- [ ] **i18n 基础搭建**：next-intl 配置、路由结构、翻译文件骨架
- [ ] **用户体系改造**：注册/登录/密码重置、邮箱验证
- [ ] **订阅系统搭建**：套餐定义、Subscription/Order/UsageRecord 模型、QuotaGuard
- [ ] **全局 UI 重构**：浅色主题、shadcn/ui 组件、新布局、新导航
- [ ] **工作台三合一**：角色生成 + 图片生成 + 视频生成 Tab 切换
- [ ] **角色生成模块**：Sora 2 Character API 集成
- [ ] **素材库升级**：存储配额管理
- [ ] **任务记录统一视图**

### Phase 2：增值功能（3-4 周）

- [ ] 提示词优化功能
- [ ] 创作策划功能
- [ ] AI 助理集成
- [ ] 偏好设置（含语言切换）
- [ ] Pro/Enterprise 用户自定义 Provider

### Phase 3：高级功能（3-4 周）

- [ ] 精选爆款展示广场（中英文内容）
- [ ] 爆款复刻功能
- [ ] 工具箱（图片画布、视频编辑、字幕去除）
- [ ] 文档说明页面（中英文）

### Phase 4：商业化（3-4 周）

- [ ] 支付集成（支付宝/微信支付 + Stripe 海外）
- [ ] 管理后台完善（用户/套餐/Provider/统计）
- [ ] 数据统计与分析
- [ ] i18n 翻译完善和校对
- [ ] 移动端适配

---

## 十二、附录

### 12.1 参考系统截图索引

| 截图文件 | 对应功能 |
|---------|---------|
| 角色生成.png | 工作台 - 角色生成 Tab |
| 图片生成.png | 工作台 - 图片生成 Tab |
| 视频生成.png | 工作台 - 视频生成 Tab |
| 提示词优化1.png / 2.png | 提示词优化（智能优化 / 模板优化） |
| 创作策划1.png / 2.png | 创作策划 |
| 爆款复刻1.png / 2.png | 爆款复刻 |
| 精选爆款.png | 精选爆款广场 |
| 素材库.png | 素材库 |
| 任务记录.png | 任务记录 |
| 工具箱图片画布.png | 工具箱 - 图片画布 |
| 工具箱视频编辑.png | 工具箱 - 视频编辑 |
| 工具箱字幕去除.png | 工具箱 - 字幕去除 |
| 工具箱任务列表.png | 工具箱 - 任务记录 |
| ai助理.png | AI 助理 |
| API设置1.png / 2.png | 管理后台 - Provider 管理 |
| 文档说明.png | 文档说明 |

### 12.2 技术栈全景

```
前端:
  Next.js 15 + React 19 + TypeScript
  shadcn/ui (Radix) + Tailwind CSS + Lucide React
  Zustand (状态管理)
  TanStack Query (数据请求)
  React Hook Form + Zod (表单)
  next-intl (i18n)

后端:
  NestJS 11 + TypeScript
  Prisma + PostgreSQL
  BullMQ + Redis (队列)
  @nestjs/swagger (API 文档)
  @nestjs/throttler (Rate Limiting)
  @nestjs-modules/mailer (邮件)
  winston/pino (日志)
  crypto AES-256 (加密)

基础设施:
  pnpm monorepo
  S3 兼容存储 (MinIO/AWS)
  Redis Pub/Sub + SSE (实时通信)
```
