# Gemini AI 项目（双功能）

本项目实现：
1. 文字生图（`gemini-2.5-flash-image`，Nano Banana）
2. 图生视频（`veo-3.1-generate-preview`）

明确不包含：文生视频。

## Key 配置位置
- 在项目根目录创建：`D:\polloai\.env`
- 重点配置项：
  - `GEMINI_API_KEY=你的真实 Gemini Key`
  - 或者 `GOOGLE_API_KEY=你的真实 Gemini Key`
  - `CORS_ORIGINS=*`
  - 如果你本机访问 Gemini 需要代理，再加：`HTTPS_PROXY=http://127.0.0.1:7890`
- 不要把 key 配在 `apps/api` 或 `apps/worker` 子目录，当前已支持自动读取根目录 `.env`。

## Quick Start

1. 复制环境变量
```bash
cp .env.example .env
```

2. 编辑 `.env`，至少改这几项
```bash
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxx
CORS_ORIGINS=*
HTTPS_PROXY=http://127.0.0.1:7890
```

3. 启动基础设施
```bash
docker compose up -d
```

4. 安装依赖
```bash
pnpm install
```

5. 初始化数据库
```bash
pnpm db:generate
pnpm db:push
pnpm db:seed
```

6. 启动服务
```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

## Provider 说明
- 图片任务由 Gemini `gemini-2.5-flash-image` 执行
- 视频任务由 Gemini `veo-3.1-generate-preview` 执行
- Veo 只支持离散时长，当前服务会把旧的 `5` 秒参数自动归整到最近的合法值
- 图生视频不再把图片 URL 直接交给外部模型，而是由 worker 先拉取图片字节，再以内联图片调用 Veo

## 默认测试账号
- `demo@pollo.ai`
- `demo123456`
