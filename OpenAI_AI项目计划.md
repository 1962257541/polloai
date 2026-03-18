# Gemini AI 项目计划（仅双功能）

## 摘要
- 使用 Gemini API（`gemini-2.5-flash-image`、`veo-3.1-generate-preview`）。
- 功能范围仅包含：
1. 文字生图
2. 图生视频
- 明确排除：文生视频。

## 实施方案
- 前端：Next.js + React + Tailwind
- 后端：NestJS
- Worker：BullMQ 异步执行 Gemini 任务
- 队列：Redis
- 数据库：PostgreSQL
- 对象存储：MinIO（本地）/ S3（生产）

## 模型映射
- 文字生图：`gemini-2.5-flash-image`（Nano Banana）
- 图生视频：`veo-3.1-generate-preview`

## 当前实现要点
- 图片生成走 Gemini `generateContent`
- 图生视频走 Veo `predictLongRunning`
- worker 会先拉取输入图片，再以内联图片方式调用 Veo
- 视频任务使用轮询查询 operation 状态，完成后下载视频并回存对象存储
- 状态机：`queued -> running -> succeeded/failed/cancelled`
