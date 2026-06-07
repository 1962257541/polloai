"use client";

import { useEffect, useState } from "react";

export type Task = {
  id: string;
  type: "text_to_image" | "image_to_video" | "video_upscale";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  prompt: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
  responseText?: string | null;
  parameters?: {
    responseText?: string | null;
  } | null;
  assets: Array<{
    id: string;
    role: "input" | "output";
    mediaType: "image" | "video";
    url: string;
  }>;
};

const STATUS_LABELS: Record<Task["status"], string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<Task["status"], string> = {
  queued: "var(--text-muted)",
  running: "var(--accent)",
  succeeded: "var(--success)",
  failed: "var(--error)",
  cancelled: "var(--text-muted)",
};

function getProgress(task: Task, now: number) {
  if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return 100;
  if (task.status === "queued") return 12;

  const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : new Date(task.createdAt).getTime();
  const elapsed = Math.max(0, (now - startedAt) / 1000);
  const expected = task.type === "text_to_image" ? 30 : 150;
  return Math.max(18, Math.min(92, Math.round(18 + (elapsed / expected) * 72)));
}

function getProgressClass(task: Task) {
  if (task.status === "failed") return "progress-bar progress-bar-failed";
  if (task.status === "cancelled") return "progress-bar progress-bar-cancelled";
  if (task.status === "running") return "progress-bar progress-bar-running";
  return "progress-bar";
}

interface TaskCardProps {
  task: Task;
  compact?: boolean;
  selected?: boolean;
  onSelect?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onRetry?: (task: Task) => void;
  onUpscale?: (task: Task) => void;
}

export default function TaskCard({
  task,
  compact = false,
  selected = false,
  onSelect,
  onDelete,
  onCancel,
  onRetry,
  onUpscale,
}: TaskCardProps) {
  const [clock, setClock] = useState(Date.now);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    if (task.status !== "queued" && task.status !== "running") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);

  useEffect(() => {
    setMediaError(false);
  }, [task.id, task.assets]);

  const progress = getProgress(task, clock);
  const output = task.assets.find((asset) => asset.role === "output");
  const isPending = task.status === "queued" || task.status === "running";
  const canUpscale = task.status === "succeeded" && output?.mediaType === "video" && Boolean(onUpscale);
  const isInteractive = compact && Boolean(onSelect);
  const textResponse = task.responseText?.trim() || task.parameters?.responseText?.trim() || "";
  const hasTextResponse = task.status === "succeeded" && Boolean(textResponse);

  const handleSelect = () => {
    onSelect?.(task.id);
  };

  const handleSelectByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleSelect();
    }
  };

  if (compact) {
    return (
      <div
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : -1}
        aria-pressed={isInteractive ? selected : undefined}
        onClick={isInteractive ? handleSelect : undefined}
        onKeyDown={handleSelectByKeyboard}
        style={{
          background: selected ? "var(--bg-raised)" : "var(--bg-surface)",
          border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
          boxShadow: selected ? "0 0 0 2px rgba(37,99,235,0.25)" : "none",
          borderRadius: 8,
          padding: "10px",
          width: 176,
          flexShrink: 0,
          cursor: isInteractive ? "pointer" : "default",
          transition: "border-color 0.15s, box-shadow 0.15s, transform 0.15s",
        }}
      >
        <div style={{ position: "relative" }}>
          {output && !mediaError ? (
            output.mediaType === "image" ? (
              <img
                src={output.url}
                alt=""
                style={{ width: "100%", height: 108, objectFit: "cover", borderRadius: 4, display: "block" }}
                onError={() => setMediaError(true)}
              />
            ) : (
              <video
                src={output.url}
                style={{ width: "100%", height: 108, objectFit: "cover", borderRadius: 4, display: "block" }}
              />
            )
          ) : (
            <div
              style={{
                height: 108,
                background: "var(--bg-raised)",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 10px",
                textAlign: "center",
              }}
            >
              {isPending ? (
                <div className="progress-track" style={{ width: "80%" }}>
                  <div className={getProgressClass(task)} style={{ width: `${progress}%` }} />
                </div>
              ) : (
                <span
                  style={{
                    fontSize: hasTextResponse ? "0.74rem" : "0.72rem",
                    color: hasTextResponse ? "var(--text-secondary)" : "var(--text-muted)",
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: hasTextResponse ? 4 : 2,
                    WebkitBoxOrient: "vertical",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {task.status === "failed" ? "生成失败" : "暂无预览"}
                </span>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "0.65rem",
            fontFamily: "inherit",
            color: STATUS_COLORS[task.status],
          }}
        >
          <span>{STATUS_LABELS[task.status]}</span>
          <span style={{ color: "var(--border)" }}>/</span>
          <span style={{ color: "var(--text-muted)" }}>
            {(() => {
              const d = new Date(task.createdAt);
              const dateStr = d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
              const timeStr = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
              return `${dateStr} ${timeStr}`;
            })()}
          </span>
        </div>

        <p
          style={{
            margin: "8px 0 0",
            fontSize: "0.76rem",
            color: "var(--text-secondary)",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            minHeight: 34,
          }}
        >
          {task.prompt}
        </p>

        {hasTextResponse && (
          <p
            style={{
              margin: "6px 0 0",
              fontSize: "0.72rem",
              color: "var(--text-muted)",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              whiteSpace: "pre-wrap",
            }}
          >
            {textResponse}
          </p>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {output ? (
            <a
              href={output.url}
              download
              target="_blank"
              rel="noreferrer"
              title="下载"
              onClick={(event) => event.stopPropagation()}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "5px 0",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
                textDecoration: "none",
              }}
            >
              下载
            </a>
          ) : (
            <span
              title="暂无可下载内容"
              onClick={(event) => event.stopPropagation()}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "5px 0",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-muted)",
                fontSize: "0.72rem",
                opacity: 0.4,
                cursor: "not-allowed",
                userSelect: "none",
              }}
            >
              下载
            </span>
          )}

          {canUpscale && (
            <button
              type="button"
              title="画质提升"
              onClick={(event) => {
                event.stopPropagation();
                onUpscale?.(task);
              }}
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "5px 8px",
                borderRadius: 4,
                border: "1px solid var(--accent)",
                background: "rgba(37,99,235,0.06)",
                color: "var(--accent)",
                cursor: "pointer",
                fontSize: "0.72rem",
              }}
            >
              ✨高清
            </button>
          )}

          {task.status === "failed" && onRetry && (
            <button
              type="button"
              title="重试"
              onClick={(event) => {
                event.stopPropagation();
                onRetry(task);
              }}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "5px 8px",
                borderRadius: 4,
                border: "1px solid var(--accent)",
                background: "rgba(37,99,235,0.06)",
                color: "var(--accent)",
                cursor: "pointer",
                fontSize: "0.72rem",
              }}
            >
              重试
            </button>
          )}

          {isPending && onCancel && (
            <button
              type="button"
              title="取消"
              onClick={(event) => {
                event.stopPropagation();
                onCancel(task.id);
              }}
              style={{
                flex: output ? "0 0 auto" : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "5px 8px",
                borderRadius: 4,
                border: "1px solid rgba(251,146,60,0.4)",
                background: "transparent",
                color: "#fb923c",
                cursor: "pointer",
                fontSize: "0.72rem",
              }}
            >
              取消
            </button>
          )}

          {onDelete && !isPending && (
            <button
              type="button"
              title="删除"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(task.id);
              }}
              style={{
                flex: output ? "0 0 auto" : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "5px 8px",
                borderRadius: 4,
                border: "1px solid rgba(239,68,68,0.3)",
                background: "transparent",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: "0.72rem",
              }}
            >
              删除
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {output && !mediaError ? (
        <div style={{ position: "relative" }}>
          {output.mediaType === "image" ? (
            <img
              src={output.url}
              alt="generated"
              style={{
                width: "100%",
                maxHeight: 400,
                objectFit: "contain",
                background: "var(--bg-raised)",
                display: "block",
              }}
              onError={() => setMediaError(true)}
            />
          ) : (
            <video controls src={output.url} style={{ width: "100%", maxHeight: 400, display: "block" }} />
          )}

          <div
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              display: "flex",
              gap: 8,
            }}
          >
            <a
              href={output.url}
              download
              target="_blank"
              rel="noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(0,0,0,0.7)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6,
                padding: "6px 12px",
                color: "#ffffff",
                fontSize: "0.8rem",
                textDecoration: "none",
                backdropFilter: "blur(8px)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              下载
            </a>
          </div>
        </div>
      ) : (
        <div
          style={{
            height: 260,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            background: "var(--bg-raised)",
            padding: "0 20px",
            textAlign: "center",
            position: "relative",
          }}
        >
          <span
            title="暂无可下载内容"
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              padding: "6px 12px",
              color: "#ffffff",
              fontSize: "0.8rem",
              opacity: 0.4,
              cursor: "not-allowed",
              userSelect: "none",
            }}
          >
            下载
          </span>
          {isPending ? (
            <>
              <div style={{ width: "60%" }}>
                <div className="progress-track">
                  <div className={getProgressClass(task)} style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div
                style={{
                  fontFamily: "inherit",
                  fontSize: "0.75rem",
                  color: "var(--accent)",
                }}
              >
                {STATUS_LABELS[task.status]} / {progress}%
              </div>
            </>
          ) : (
            <div
              style={{
                color: task.status === "failed" ? "var(--error)" : "var(--text-muted)",
                fontSize: "0.875rem",
                maxWidth: 480,
              }}
            >
              {task.status === "failed"
                ? `生成失败${task.errorMessage ? `：${task.errorMessage}` : ""}`
                : "暂无可展示结果"}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span
            style={{
              fontFamily: "inherit",
              fontSize: "0.7rem",
              color: STATUS_COLORS[task.status],
              letterSpacing: "0.05em",
            }}
          >
            {STATUS_LABELS[task.status]}
          </span>
          <span style={{ color: "var(--border)", fontSize: "0.7rem" }}>/</span>
          <span
            style={{
              fontFamily: "inherit",
              fontSize: "0.7rem",
              color: "var(--text-muted)",
            }}
          >
            {new Date(task.createdAt).toLocaleString("zh-CN")}
          </span>

          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {canUpscale && (
              <button
                type="button"
                title="画质提升（火山引擎超分）"
                onClick={() => onUpscale?.(task)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid var(--accent)",
                  background: "rgba(37,99,235,0.06)",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                ✨ 画质提升
              </button>
            )}

            {task.status === "failed" && onRetry && (
              <button
                type="button"
                title="重试"
                onClick={() => onRetry(task)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid var(--accent)",
                  background: "rgba(37,99,235,0.06)",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                重试
              </button>
            )}

            {isPending && onCancel && (
              <button
                type="button"
                title="取消"
                onClick={() => onCancel(task.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid rgba(251,146,60,0.4)",
                  background: "transparent",
                  color: "#fb923c",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                取消
              </button>
            )}

            {onDelete && !isPending && (
              <button
                type="button"
                title="删除"
                onClick={() => onDelete(task.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(239,68,68,0.3)",
                  background: "transparent",
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                删除
              </button>
            )}
          </div>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "0.8rem",
            color: "var(--text-secondary)",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {task.prompt}
        </p>

        {hasTextResponse && (
          <p
            style={{
              marginTop: 8,
              marginBottom: 0,
              fontSize: "0.78rem",
              color: "var(--text-secondary)",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
            }}
          >
            {textResponse}
          </p>
        )}

        {task.errorMessage && task.status === "failed" && (
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: "0.75rem", color: "var(--error)" }}>
            {task.errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
