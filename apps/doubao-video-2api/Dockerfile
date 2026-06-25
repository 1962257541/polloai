# /Dockerfile
# ====================================================================
# Dockerfile for doubao-2api (v1.4 - Patched for User Permissions)
# ====================================================================

# 使用一个稳定、广泛支持的 Debian 版本作为基础镜像
FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

# 关键修正: 一次性、完整地安装所有系统依赖
# 合并了 Playwright 官方建议的核心库和我们之前发现的字体库
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright 核心依赖
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libatspi2.0-0 \
    # 官方错误日志中明确提示缺少的关键库
    libpango-1.0-0 libcairo2 \
    # 解决字体问题的包
    fonts-unifont fonts-liberation \
    # 清理 apt 缓存以减小镜像体积
    && rm -rf /var/lib/apt/lists/*

# 关键修复：固定 Playwright 浏览器到全局路径，避免运行时按 $HOME（可能是
# /root 或未设）去找而报 "Executable doesn't exist"。装和跑都用同一路径，
# 且放在所有用户可读的 /ms-playwright 下，appuser 运行时也能访问。
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 安装 Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 以 root 安装 Chromium 到全局路径，并放开读/执行权限给非 root 用户
RUN playwright install chromium && \
    chmod -R a+rx /ms-playwright

# 复制应用代码
COPY . .

# 创建并切换到非 root 用户运行
RUN useradd --create-home appuser && \
    chown -R appuser:appuser /app
USER appuser

# 暴露端口并启动
# 监听平台注入的 $PORT（Zeabur/Railway 等会注入），本地无该变量时回退 8000。
# 用 shell 形式 CMD 才能对 $PORT 做环境变量展开。
EXPOSE 8000
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1
