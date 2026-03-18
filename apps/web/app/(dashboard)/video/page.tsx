"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VideoGenerator from "../../../components/VideoGenerator";
import TaskCard, { Task } from "../../../components/TaskCard";
import { api } from "../../../lib/api";
import { getToken } from "../../../lib/auth";

export default function VideoPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTasks = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await api.listTasks(token, "image_to_video");
      setTasks(res.items || []);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  // 有进行中任务时每 3 秒轮询一次
  useEffect(() => {
    const hasPending = tasks.some((t) => t.status === "queued" || t.status === "running");
    if (hasPending) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => { void loadTasks(); }, 3000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {};
  }, [tasks, loadTasks]);

  useEffect(() => {
    void loadTasks();

    const token = getToken();
    if (!token) return;

    // SSE 作为加速通道，有事件立即刷新
    stopStreamRef.current = api.streamTasks(token, () => {
      void loadTasks();
    });

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
    await api.deleteTask(token, taskId);
    await loadTasks();
  };

  const latestTask = tasks[0];
  const historyTasks = tasks.slice(1);
  const generating = tasks.some((t) => t.status === "queued" || t.status === "running");

  return (
    <div className="page-enter">
      {/* 页面标题 */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: "1.4rem", color: "var(--text-primary)", margin: 0 }}>
          图生视频
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "JetBrains Mono, monospace", marginTop: 4 }}>
          IMAGE TO VIDEO · VEO
        </p>
      </div>

      {/* 主内容：左右分栏 */}
      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 24, alignItems: "start" }}>
        {/* 左：表单 */}
        <VideoGenerator onCreated={loadTasks} generating={generating} />

        {/* 右：结果 */}
        <div>
          {loadingTasks ? (
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>加载中...</span>
            </div>
          ) : latestTask ? (
            <TaskCard task={latestTask} onDelete={handleDelete} />
          ) : (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "2px dashed var(--border)",
                borderRadius: 10,
                height: 240,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", margin: 0 }}>上传图片并输入描述后点击生成</p>
            </div>
          )}
        </div>
      </div>

      {/* 历史任务 */}
      {historyTasks.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 600, fontSize: "0.9rem", color: "var(--text-secondary)", marginBottom: 16 }}>
            历史记录
          </h3>
          <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
            {historyTasks.map((task) => (
              <TaskCard key={task.id} task={task} compact onDelete={handleDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
