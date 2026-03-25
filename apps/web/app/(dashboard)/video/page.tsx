"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VideoGenerator from "../../../components/VideoGenerator";
import TaskCard, { Task } from "../../../components/TaskCard";
import { api } from "../../../lib/api";
import { getToken } from "../../../lib/auth";

const PAGE_SIZE = 10;

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export default function VideoPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTasks = useCallback(async (selectLatest = false) => {
    const token = getToken();
    if (!token) return;

    try {
      const res = await api.listTasks(token, "image_to_video", PAGE_SIZE, 0);
      const nextTasks: Task[] = res.items || [];
      setTotal(res.total ?? 0);
      setTasks((prev) => {
        const prevOld = prev.slice(PAGE_SIZE);
        const newIds = new Set(nextTasks.map((t) => t.id));
        return [...nextTasks, ...prevOld.filter((t) => !newIds.has(t.id))];
      });
      setSelectedTaskId((current) => {
        if (selectLatest) return nextTasks[0]?.id ?? null;
        if (current) return current;
        return nextTasks[0]?.id ?? null;
      });
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  const loadMore = async () => {
    const token = getToken();
    if (!token || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.listTasks(token, "image_to_video", PAGE_SIZE, tasks.length);
      const more: Task[] = res.items || [];
      setTotal(res.total ?? 0);
      setTasks((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        return [...prev, ...more.filter((t) => !existingIds.has(t.id))];
      });
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const hasPending = tasks.some((t) => t.status === "queued" || t.status === "running");
    if (hasPending) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void loadTasks(), 3000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {};
  }, [tasks, loadTasks]);

  useEffect(() => {
    void loadTasks();
    const token = getToken();
    if (!token) return;
    stopStreamRef.current = api.streamTasks(token, () => void loadTasks());
    return () => {
      stopStreamRef.current?.();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [loadTasks]);

  const handleDelete = async (taskId: string) => {
    const token = getToken();
    if (!token) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task && (task.status === "queued" || task.status === "running")) {
      await api.cancelTask(token, taskId).catch(() => {});
    }
    await api.deleteTask(token, taskId);
    await loadTasks();
  };

  const handleCreated = () => void loadTasks(true);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0];
  const hasMore = tasks.length < total;

  return (
    <div
      className="page-enter"
      style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 64px)", minHeight: 0 }}
    >
      {/* 页头 */}
      <div style={{ marginBottom: 20, flexShrink: 0 }}>
        <h1
          style={{
            fontFamily: "Syne, sans-serif",
            fontWeight: 700,
            fontSize: "1.4rem",
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          图生视频
        </h1>
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "0.8rem",
            fontFamily: "JetBrains Mono, monospace",
            marginTop: 4,
          }}
        >
          IMAGE TO VIDEO / VEO
        </p>
      </div>

      {/* 主体：左生成器 | 中预览 | 右历史列表 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "380px 1fr 280px",
          gap: 16,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* 左：生成器 */}
        <div style={{ overflowY: "auto" }}>
          <VideoGenerator onCreated={handleCreated} />
        </div>

        {/* 中：当前任务预览 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {loadingTasks ? (
            <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>加载中...</span>
          ) : selectedTask ? (
            <div style={{ width: "100%", height: "100%", overflowY: "auto" }}>
              <TaskCard task={selectedTask} onDelete={handleDelete} />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
              }}
            >
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth={1}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", margin: 0 }}>
                选择图片并填写描述后点击生成
              </p>
            </div>
          )}
        </div>

        {/* 右：历史列表 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {/* 顶部标题 */}
          <div
            style={{
              padding: "16px 16px 12px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: "0.7rem",
                fontFamily: "JetBrains Mono, monospace",
                color: "var(--text-muted)",
                letterSpacing: "0.08em",
              }}
            >
              HISTORY
            </span>
          </div>

          {/* 列表 */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingTasks ? (
              <div
                style={{
                  padding: "20px 16px",
                  textAlign: "center",
                  fontSize: "0.78rem",
                  color: "var(--text-muted)",
                }}
              >
                加载中...
              </div>
            ) : tasks.length === 0 ? (
              <div
                style={{
                  padding: "20px 16px",
                  textAlign: "center",
                  fontSize: "0.78rem",
                  color: "var(--text-muted)",
                }}
              >
                暂无历史记录
              </div>
            ) : (
              <>
                {tasks.map((task) => {
                  const isActive = task.id === (selectedTask?.id ?? null);
                  const outputAsset = task.assets?.find(
                    (a: { role: string; mediaType: string; url: string }) => a.role === "output",
                  );
                  const inputAsset = task.assets?.find(
                    (a: { role: string; mediaType: string; url: string }) => a.role === "input",
                  );
                  // 视频任务：优先用 input 图作缩略图（视频无法直接渲染为图片缩略图）
                  // 若有 output 且为图片类型则优先 output
                  const thumbUrl =
                    (outputAsset?.mediaType === "image" ? outputAsset?.url : undefined) ||
                    inputAsset?.url;

                  return (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      style={{
                        padding: "10px 12px",
                        cursor: "pointer",
                        background: isActive ? "var(--accent-glow)" : "transparent",
                        borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive)
                          (e.currentTarget as HTMLDivElement).style.background = "var(--bg-raised)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive)
                          (e.currentTarget as HTMLDivElement).style.background = "transparent";
                      }}
                    >
                      {/* 缩略图 */}
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 6,
                          overflow: "hidden",
                          flexShrink: 0,
                          background: "var(--bg-raised)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {thumbUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbUrl}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="var(--text-muted)"
                              strokeWidth={1.5}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polygon points="23 7 16 12 23 17 23 7" />
                              <rect x="1" y="5" width="15" height="14" rx="2" />
                            </svg>
                          </div>
                        )}
                      </div>

                      {/* 内容 */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: isActive ? "var(--accent)" : "var(--text-primary)",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            lineHeight: 1.4,
                          }}
                        >
                          {task.prompt || "无描述"}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                            {timeAgo(task.createdAt)}
                          </span>
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontFamily: "JetBrains Mono, monospace",
                              color:
                                task.status === "succeeded"
                                  ? "var(--success)"
                                  : task.status === "failed"
                                    ? "var(--error)"
                                    : task.status === "running"
                                      ? "var(--accent)"
                                      : "var(--text-muted)",
                            }}
                          >
                            ·{" "}
                            {task.status === "succeeded"
                              ? "完成"
                              : task.status === "failed"
                                ? "失败"
                                : task.status === "running"
                                  ? "生成中"
                                  : task.status === "cancelled"
                                    ? "已取消"
                                    : "排队中"}
                          </span>
                        </div>
                      </div>

                      {/* 删除按钮 */}
                      <button
                        type="button"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(task.id);
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-muted)",
                          padding: 2,
                          flexShrink: 0,
                          opacity: 0.5,
                          lineHeight: 1,
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                          (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.opacity = "0.5";
                          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    </div>
                  );
                })}

                {hasMore && (
                  <div style={{ padding: "10px 16px" }}>
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                      style={{
                        width: "100%",
                        padding: "6px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--text-muted)",
                        fontSize: "0.75rem",
                        cursor: loadingMore ? "default" : "pointer",
                      }}
                    >
                      {loadingMore ? "加载中..." : "加载更多"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
