"use client";

import { useEffect, useState } from "react";

export type Task = {
  id: string;
  type: "text_to_image" | "image_to_video";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  prompt: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
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
  onDelete?: (taskId: string) => void;
}

export default function TaskCard({ task, compact = false, onDelete }: TaskCardProps) {
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    if (task.status !== "queued" && task.status !== "running") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);

  const progress = getProgress(task, clock);
  const output = task.assets.find((a) => a.role === "output");
  const isPending = task.status === "queued" || task.status === "running";

  if (compact) {
    return (
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px",
          width: 160,
          flexShrink: 0,
        }}
      >
        {/* 缩略图/进度 */}
        <div style={{ position: "relative" }}>
          {output ? (
            output.mediaType === "image" ? (
              <img src={output.url} alt="" style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 4, display: "block" }} />
            ) : (
              <video src={output.url} style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 4, display: "block" }} />
            )
          ) : (
            <div
              style={{
                height: 100,
                background: "var(--bg-raised)",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {isPending && (
                <div className="progress-track" style={{ width: "80%" }}>
                  <div className={getProgressClass(task)} style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* 状态 */}
        <div style={{ marginTop: 6, fontSize: "0.65rem", fontFamily: "JetBrains Mono, monospace", color: STATUS_COLORS[task.status] }}>
          {STATUS_LABELS[task.status]}
        </div>

        {/* 操作按钮 */}
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          {output && (
            <a
              href={output.url}
              download
              target="_blank"
              rel="noreferrer"
              title="下载"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "4px 0",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "0.7rem",
                textDecoration: "none",
                transition: "color 0.15s, border-color 0.15s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--accent)"; (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border-focus)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              下载
            </a>
          )}
          {onDelete && (
            <button
              title="删除"
              onClick={() => onDelete(task.id)}
              style={{
                flex: output ? "0 0 auto" : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px 6px",
                borderRadius: 4,
                border: "1px solid rgba(239,68,68,0.3)",
                background: "transparent",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: "0.7rem",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.1)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
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
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* 结果区 */}
      {output ? (
        <div style={{ position: "relative" }}>
          {output.mediaType === "image" ? (
            <img
              src={output.url}
              alt="generated"
              style={{ width: "100%", maxHeight: 400, objectFit: "contain", background: "var(--bg-raised)", display: "block" }}
              onError={(e) => {
                const el = e.currentTarget;
                el.style.display = "none";
                const parent = el.parentElement;
                if (parent && !parent.querySelector(".img-error-msg")) {
                  const msg = document.createElement("div");
                  msg.className = "img-error-msg";
                  msg.style.cssText = "height:200px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:var(--bg-raised);color:var(--text-muted);font-size:0.8rem;";
                  msg.innerHTML = `<span>⚠ 图片加载失败</span><span style="font-size:0.7rem;font-family:monospace;word-break:break-all;padding:0 16px;text-align:center;opacity:0.6">${el.src}</span>`;
                  parent.insertBefore(msg, el);
                }
              }}
            />
          ) : (
            <video controls src={output.url} style={{ width: "100%", maxHeight: 400 }} />
          )}
          <a
            href={output.url}
            download
            target="_blank"
            rel="noreferrer"
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              background: "rgba(0,0,0,0.7)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 12px",
              color: "var(--text-primary)",
              fontSize: "0.8rem",
              textDecoration: "none",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              gap: 6,
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
      ) : (
        <div
          style={{
            height: 240,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            background: "var(--bg-raised)",
          }}
        >
          {isPending ? (
            <>
              <div style={{ width: "60%" }}>
                <div className="progress-track">
                  <div className={getProgressClass(task)} style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.75rem", color: "var(--accent)" }}>
                {STATUS_LABELS[task.status]} · {progress}%
              </div>
            </>
          ) : task.status === "succeeded" ? (
            // 成功但图片还未加载到列表，显示等待提示
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <div style={{ width: "60%" }}>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: "100%", background: "var(--success)" }} />
                </div>
              </div>
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.75rem", color: "var(--success)" }}>
                已完成 · 加载中...
              </div>
            </div>
          ) : (
            <div style={{ color: task.status === "failed" ? "var(--error)" : "var(--text-muted)", fontSize: "0.875rem" }}>
              {task.status === "failed" ? `生成失败${task.errorMessage ? `：${task.errorMessage}` : ""}` : "无结果"}
            </div>
          )}
        </div>
      )}

      {/* 信息区 */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: "0.7rem",
              color: STATUS_COLORS[task.status],
              letterSpacing: "0.05em",
            }}
          >
            {STATUS_LABELS[task.status].toUpperCase()}
          </span>
          <span style={{ color: "var(--border)", fontSize: "0.7rem" }}>·</span>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.7rem", color: "var(--text-muted)" }}>
            {new Date(task.createdAt).toLocaleTimeString("zh-CN")}
          </span>
          {onDelete && (
            <button
              title="删除"
              onClick={() => onDelete(task.id)}
              style={{
                marginLeft: "auto",
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
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.1)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
              删除
            </button>
          )}
        </div>
        <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          {task.prompt}
        </p>
        {task.errorMessage && (
          <p style={{ marginTop: 6, fontSize: "0.75rem", color: "var(--error)" }}>{task.errorMessage}</p>
        )}
      </div>
    </div>
  );
}
