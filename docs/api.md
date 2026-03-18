# API v1 快速调用

Base URL: `http://localhost:3001/api/v1`

## Auth

### 注册
```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"u@example.com","password":"password123","name":"User"}'
```

### 登录
```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@pollo.ai","password":"demo123456"}'
```

## Credits

```bash
curl http://localhost:3001/api/v1/credits/me \
  -H "Authorization: Bearer <JWT>"
```

## 文字生图

```bash
curl -X POST http://localhost:3001/api/v1/generations/image \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt":"A cinematic fox in snowfall",
    "size":"1024x1024",
    "quality":"auto",
    "outputFormat":"png"
  }'
```

默认模型：`gemini-2.5-flash-image`

## 图生视频（URL）

```bash
curl -X POST http://localhost:3001/api/v1/generations/video-from-image \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt":"camera slowly pushes in",
    "imageUrl":"https://example.com/input.png",
    "size":"1280x720",
    "durationSec":4
  }'
```

默认模型：`veo-3.1-generate-preview`

## 图生视频（上传文件）

```bash
curl -X POST http://localhost:3001/api/v1/generations/video-from-image \
  -H "Authorization: Bearer <JWT>" \
  -F "prompt=camera slowly pushes in" \
  -F "durationSec=4" \
  -F "image=@./input.png"
```

## 查询任务

```bash
curl http://localhost:3001/api/v1/generations/<TASK_ID> \
  -H "Authorization: Bearer <JWT>"
```

## 任务列表

```bash
curl "http://localhost:3001/api/v1/generations?limit=20&offset=0" \
  -H "Authorization: Bearer <JWT>"
```

## 取消任务

```bash
curl -X POST http://localhost:3001/api/v1/generations/<TASK_ID>/cancel \
  -H "Authorization: Bearer <JWT>"
```
