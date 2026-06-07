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
  // 画质提升弹窗
  const [upscaleTask, setUpscaleTask] = useState<Task | null>(null);
  const [upscaleRes, setUpscaleRes] = useState<"1080p" | "2k" | "4k">("1080p");
  const [upscaling, setUpscaling] = useState(false);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTasks = useCallback(async (selectLatest = false) => {
    const token = getToken();
    if (!token) return;

    try {
      const res = await api.listTasks(token, "image_to_video,video_upscale", PAGE_SIZE, 0);
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
      const res = await api.listTasks(token, "image_to_video,video_upscale", PAGE_SIZE, tasks.length);
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

  const handleCancel = async (taskId: string) => {
    const token = getToken();
    if (!token) return;
    try {
      await api.cancelTask(token, taskId);
      await loadTasks();
    } catch (error) {
      console.error("Failed to cancel task:", error);
    }
  };

  const handleRetry = async (task: Task) => {
    const token = getToken();
    if (!token) return;
    try {
      await api.retryVideoTask(token, task);
      await loadTasks(true);
    } catch (error) {
      console.error("Failed to retry task:", error);
    }
  };

  const handleUpscale = (task: Task) => {
    setUpscaleTask(task);
    setUpscaleRes("1080p");
  };

  const confirmUpscale = async () => {
    const token = getToken();
    if (!token || !upscaleTask) return;
    const output = upscaleTask.assets.find((a) => a.role === "output" && a.mediaType === "video");
    if (!output) return;
    try {
      setUpscaling(true);
      await api.createVideoUpscale(token, {
        sourceVideoUrl: output.url,
        targetResolution: upscaleRes,
        sourceTaskId: upscaleTask.id,
      });
      setUpscaleTask(null);
      await loadTasks(true);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setUpscaling(false);
    }
  };

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

  const handleClearAll = async () => {
    const token = getToken();
    if (!token) return;
    const terminated = tasks.filter(
      (t) => t.status === "succeeded" || t.status === "failed" || t.status === "cancelled",
    );
    if (terminated.length === 0) return;
    if (!window.confirm(`确定清除 ${terminated.length} 条已完成的记录吗？此操作不可撤销`)) return;
    try {
      await api.clearCompletedTasks(token, "image_to_video");
      await loadTasks();
    } catch (error) {
      console.error("Failed to clear tasks:", error);
    }
  };

  const handleCreated = () => void loadTasks(true);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0];
  const hasMore = tasks.length < total;

  return (
    <div
      className="page-enter"
      style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)", minHeight: 0 }}
    >
      {/* 主体：左生成器 | 中预览 | 右历史列表 — 撑满剩余高度 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "360px 1fr 280px",
          gap: 16,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* 左：生成器 — 不自身滚动，内部组件控制滚动 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <VideoGenerator onCreated={handleCreated} />
        </div>

        {/* 中：当前任务预览 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
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
              <TaskCard task={selectedTask} onDelete={handleDelete} onCancel={handleCancel} onRetry={handleRetry} onUpscale={handleUpscale} />
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
            borderRadius: 12,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span
                style={{
                  fontSize: "0.7rem",
                  fontFamily: "inherit",
                  color: "var(--text-muted)",
                  letterSpacing: "0.08em",
                }}
              >
                HISTORY
              </span>
              <button
                type="button"
                onClick={() => void handleClearAll()}
                title="清除已完成"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  padding: 2,
                  lineHeight: 1,
                  opacity: 0.5,
                  transition: "opacity 0.15s, color 0.15s",
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
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
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
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, whiteSpace: "nowrap" }}>
                          <span title={new Date(task.createdAt).toLocaleString("zh-CN")} style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                            {timeAgo(task.createdAt)}
                          </span>
                          <span
                            title={new Date(task.createdAt).toLocaleString("zh-CN")}
                            style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "inherit" }}
                          >
                            {(() => {
                              const d = new Date(task.createdAt);
                              const dateStr = d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
                              const timeStr = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                              return `· ${dateStr} ${timeStr}`;
                            })()}
                          </span>
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontFamily: "inherit",
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

      {/* 画质提升弹窗 */}
      {upscaleTask && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => !upscaling && setUpscaleTask(null)}
        >
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 24,
              width: "90%",
              maxWidth: 420,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: "1.1rem", color: "var(--text-primary)" }}>画质提升</h3>
            <p style={{ margin: "0 0 16px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              使用火山引擎超分增强，将生成更高清的视频副本（原视频保留）。
            </p>

            <label style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.05em" }}>
              目标画质
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {(["1080p", "2k", "4k"] as const).map((res) => (
                <button
                  key={res}
                  type="button"
                  onClick={() => setUpscaleRes(res)}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: `1px solid ${upscaleRes === res ? "var(--accent)" : "var(--border)"}`,
                    background: upscaleRes === res ? "var(--accent-glow)" : "transparent",
                    color: upscaleRes === res ? "var(--accent)" : "var(--text-secondary)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textTransform: "uppercase",
                  }}
                >
                  {res}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setUpscaleTask(null)}
                disabled={upscaling}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "0.85rem",
                  cursor: upscaling ? "not-allowed" : "pointer",
                  opacity: upscaling ? 0.5 : 1,
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmUpscale()}
                disabled={upscaling}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid var(--accent)",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: "0.85rem",
                  cursor: upscaling ? "not-allowed" : "pointer",
                  opacity: upscaling ? 0.6 : 1,
                }}
              >
                {upscaling ? "提交中..." : "开始提升"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
