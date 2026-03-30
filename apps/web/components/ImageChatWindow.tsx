"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { getToken } from "../lib/auth";
import type { Task } from "./TaskCard";

type ChatRound = {
  id: string; // taskId 或 pending-xxx
  prompt: string;
  referenceFiles: File[]; // 用户主动上传的参考图（本地）
  status: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  taskId?: string;
  outputUrl?: string;
  responseText?: string;
  errorMessage?: string;
};

interface ImageChatWindowProps {
  availableModels: string[];
  selectedModel: string;
  size: string;
  outputFormat: string;
  imageApiType: string;
  sessionId: string | null;                    // null = 新会话
  onSessionCreated: (id: string) => void;      // 第一次提交后传出 sessionId
}

function getProgressWidth(status: ChatRound["status"]) {
  if (status === "succeeded" || status === "failed" || status === "cancelled") return 100;
  if (status === "queued") return 15;
  return 60;
}

export default function ImageChatWindow({
  availableModels,
  selectedModel,
  size,
  outputFormat,
  imageApiType,
  sessionId,
  onSessionCreated,
}: ImageChatWindowProps) {
  const [rounds, setRounds] = useState<ChatRound[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [useContext, setUseContext] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  // 会话级固定参考图：用户在本会话中上传过的参考图 URL，每轮提交都会自动携带
  const [sessionPinnedUrls, setSessionPinnedUrls] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const token = getToken() ?? "";

  // 同步预览
  useEffect(() => {
    const urls = pendingFiles.map((f) => URL.createObjectURL(f));
    setPendingPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [pendingFiles]);

  // Ctrl+V 粘贴追加参考图
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []).filter((i) =>
        i.type.startsWith("image/"),
      );
      if (items.length === 0) return;
      const pasted = items.map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
      if (pasted.length > 0) {
        setPendingFiles((prev) => [...prev, ...pasted].slice(0, 9));
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, []);

  // 将服务端 Task 转换为 ChatRound
  const taskToChatRound = useCallback((task: Task): ChatRound => ({
    id: task.id,
    prompt: task.prompt,
    referenceFiles: [],
    status: task.status,
    taskId: task.id,
    outputUrl: task.assets.find((a) => a.role === "output")?.url,
    responseText: task.responseText ?? task.parameters?.responseText ?? undefined,
    errorMessage: task.errorMessage ?? undefined,
  }), []);

  // sessionId 变化时加载对应会话的任务
  useEffect(() => {
    if (!token) return;

    if (sessionId === null) {
      // 新会话：清空
      setRounds([]);
      setSessionPinnedUrls([]);
      return;
    }

    setHistoryLoading(true);
    void (async () => {
      try {
        // 判断是否为旧任务（isLegacy：用 taskId 作为 sessionId）
        // 先尝试按 sessionId 查，若无结果则直接按 taskId 查单条
        const res = await api.listTasks(token, "text_to_image", 100, 0, sessionId);
        const items: Task[] = res.items ?? [];
        setRounds(items.length > 0 ? items.reverse().map(taskToChatRound) : []);
        // 恢复会话级固定参考图（从历史任务的 input assets 提取）
        const pinned = items.flatMap((t) =>
          t.assets.filter((a) => a.role === "input").map((a) => a.url),
        );
        setSessionPinnedUrls([...new Set(pinned)]);
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, [token, sessionId, taskToChatRound]);

  // SSE 监听任务状态变化
  useEffect(() => {
    if (!token) return;

    stopStreamRef.current = api.streamTasks(token, (event: any) => {
      const taskId = event?.taskId as string | undefined;
      if (!taskId) return;
      setRounds((prev) =>
        prev.map((r) => {
          if (r.taskId !== taskId) return r;
          const updated: ChatRound = { ...r, status: event.status };
          if (event.assetUrl) updated.outputUrl = event.assetUrl;
          if (event.responseText) updated.responseText = event.responseText;
          if (event.errorMessage) updated.errorMessage = event.errorMessage;
          return updated;
        }),
      );
    });

    return () => stopStreamRef.current?.();
  }, [token]);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rounds]);

  // 获取上轮成功的输出图片 URL
  const lastSuccessOutputUrl = [...rounds].reverse().find(
    (r) => r.status === "succeeded" && r.outputUrl,
  )?.outputUrl;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !selectedModel || submitting) return;

    const roundId = `pending-${Date.now()}`;
    const filesToUpload = [...pendingFiles];

    // 确定本次提交的 sessionId：已有会话直接复用，新会话生成一个新 UUID
    const effectiveSessionId = sessionId ?? crypto.randomUUID();
    const isNewSession = sessionId === null;

    const newRound: ChatRound = {
      id: roundId,
      prompt: prompt.trim(),
      referenceFiles: filesToUpload,
      status: "queued",
    };

    setRounds((prev) => [...prev, newRound]);
    setPrompt("");
    setPendingFiles([]);
    setSubmitting(true);

    try {
      const form = new FormData();
      form.append("prompt", newRound.prompt);
      form.append("model", selectedModel);
      form.append("size", size);
      form.append("outputFormat", outputFormat);
      form.append("imageApiType", imageApiType);
      form.append("sessionId", effectiveSessionId);

      for (const f of filesToUpload) {
        form.append("referenceImages", f);
      }

      // 会话固定参考图 + 上下文上轮输出图，合并后追加（去重）
      const contextUrls = new Set<string>([
        ...sessionPinnedUrls,
        ...(useContext && lastSuccessOutputUrl ? [lastSuccessOutputUrl] : []),
      ]);
      for (const url of contextUrls) {
        form.append("referenceImageUrls", url);
      }

      const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";
      const response = await fetch(`${apiBase}/generations/image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
        throw new Error(msg || `Request failed (${response.status})`);
      }

      setRounds((prev) =>
        prev.map((r) =>
          r.id === roundId
            ? { ...r, taskId: data.taskId, status: data.status ?? "queued" }
            : r,
        ),
      );

      // 将本轮上传的参考图 URL 追加到会话固定列表
      if (data.inputImageUrls?.length) {
        setSessionPinnedUrls((prev) => [...new Set([...prev, ...data.inputImageUrls])]);
      }

      // 新会话第一次提交成功后，通知父组件
      if (isNewSession) {
        onSessionCreated(effectiveSessionId);
      }
    } catch (err) {
      setRounds((prev) =>
        prev.map((r) =>
          r.id === roundId
            ? { ...r, status: "failed", errorMessage: (err as Error).message }
            : r,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // 用此图继续：把某轮输出图片作为本轮参考（前端无法直接复用 URL 为 File，展示提示即可）
  const continueWithImage = (outputUrl: string) => {
    // 滚动到底部，展示上下文已引用
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* 对话历史 */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
          minHeight: 0,
        }}
      >
        {historyLoading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
            加载中...
          </div>
        ) : rounds.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              color: "var(--text-muted)",
            }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
            <p style={{ margin: 0, fontSize: "0.875rem" }}>在下方输入提示词开始生成</p>
            <p style={{ margin: 0, fontSize: "0.78rem" }}>每轮图片可自动作为下轮参考（上下文连续编辑）</p>
          </div>
        ) : (
          <>
          {rounds.map((round, index) => (
            <div key={round.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* 用户 prompt 气泡 */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div
                  style={{
                    maxWidth: "80%",
                    background: "var(--bg-raised)",
                    border: "1px solid var(--border)",
                    borderRadius: "12px 12px 4px 12px",
                    padding: "10px 14px",
                    fontSize: "0.85rem",
                    color: "var(--text-primary)",
                    lineHeight: 1.6,
                  }}
                >
                  {/* 参考图缩略 */}
                  {round.referenceFiles.length > 0 && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                      {round.referenceFiles.map((f, fi) => {
                        const objUrl = URL.createObjectURL(f);
                        return (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={fi}
                            src={objUrl}
                            alt=""
                            onLoad={() => URL.revokeObjectURL(objUrl)}
                            style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }}
                          />
                        );
                      })}
                    </div>
                  )}
                  {/* 上下文引用标记 */}
                  {useContext && index > 0 && (() => {
                    const prevSuccess = [...rounds.slice(0, index)].reverse().find(
                      (r) => r.status === "succeeded" && r.outputUrl,
                    );
                    return prevSuccess ? (
                      <div style={{ fontSize: "0.7rem", color: "var(--accent)", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                        <span>↩ 引用上轮图片</span>
                      </div>
                    ) : null;
                  })()}
                  {round.prompt}
                </div>
              </div>

              {/* 生成结果 */}
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    maxWidth: "85%",
                    background: "var(--bg-base)",
                    border: "1px solid var(--border)",
                    borderRadius: "4px 12px 12px 12px",
                    overflow: "hidden",
                  }}
                >
                  {round.status === "succeeded" && round.outputUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={round.outputUrl}
                        alt="generated"
                        style={{ width: "100%", display: "block", maxHeight: 480, objectFit: "contain", background: "var(--bg-raised)" }}
                      />
                      <div
                        style={{
                          padding: "10px 14px",
                          display: "flex",
                          gap: 8,
                          borderTop: "1px solid var(--border)",
                        }}
                      >
                        <a
                          href={round.outputUrl}
                          download
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            padding: "5px 12px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "transparent",
                            color: "var(--text-secondary)",
                            fontSize: "0.75rem",
                            textDecoration: "none",
                            cursor: "pointer",
                          }}
                        >
                          下载
                        </a>
                        <button
                          type="button"
                          onClick={() => continueWithImage(round.outputUrl!)}
                          style={{
                            padding: "5px 12px",
                            borderRadius: 6,
                            border: "1px solid var(--accent)",
                            background: "var(--accent-glow)",
                            color: "var(--accent)",
                            fontSize: "0.75rem",
                            cursor: "pointer",
                          }}
                        >
                          基于此图继续
                        </button>
                      </div>
                    </>
                  ) : round.status === "succeeded" && round.responseText ? (
                    <div
                      style={{
                        padding: "16px 18px",
                        color: "var(--text-primary)",
                        fontSize: "0.85rem",
                        lineHeight: 1.8,
                        whiteSpace: "pre-wrap",
                        maxWidth: 560,
                      }}
                    >
                      {round.responseText}
                    </div>
                  ) : round.status === "failed" ? (
                    <div style={{ padding: "14px 16px", color: "var(--error)", fontSize: "0.82rem" }}>
                      生成失败{round.errorMessage ? `：${round.errorMessage}` : ""}
                    </div>
                  ) : (
                    <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            height: 4,
                            background: "var(--bg-raised)",
                            borderRadius: 2,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${getProgressWidth(round.status)}%`,
                              background: "var(--accent)",
                              borderRadius: 2,
                              transition: "width 0.5s ease",
                            }}
                          />
                        </div>
                      </div>
                      <span style={{ fontSize: "0.75rem", color: "var(--accent)", fontFamily: "JetBrains Mono, monospace", whiteSpace: "nowrap" }}>
                        {round.status === "queued" ? "排队中..." : "生成中..."}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "16px 20px",
          background: "var(--bg-surface)",
        }}
      >
        {/* 会话级固定参考图缩略图 */}
        {sessionPinnedUrls.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: "0.75rem", color: "var(--text-muted)" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              <span>固定参考图（每轮自动携带）</span>
              <button
                type="button"
                onClick={() => setSessionPinnedUrls([])}
                style={{
                  marginLeft: 2,
                  padding: "1px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: "0.7rem",
                  cursor: "pointer",
                }}
              >
                全部清除
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {sessionPinnedUrls.map((url, i) => (
                <div key={url} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`固定参考图 ${i + 1}`}
                    style={{
                      width: 48,
                      height: 48,
                      objectFit: "cover",
                      borderRadius: 6,
                      border: "1.5px solid var(--accent)",
                      display: "block",
                    }}
                  />
                  <button
                    type="button"
                    title="移除此参考图"
                    onClick={() => setSessionPinnedUrls((prev) => prev.filter((_, idx) => idx !== i))}
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: "rgba(0,0,0,0.7)",
                      color: "#fff",
                      border: "none",
                      cursor: "pointer",
                      fontSize: "0.6rem",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 上下文开关 */}
        {lastSuccessOutputUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: "0.78rem", color: "var(--text-muted)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={useContext}
                onChange={(e) => setUseContext(e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              自动引用上轮图片作为参考（上下文编辑）
            </label>
          </div>
        )}

        {/* 待上传参考图预览 */}
        {pendingFiles.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            {pendingPreviews.map((url, i) => (
              <div key={i} style={{ position: "relative" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }}
                />
                <button
                  type="button"
                  onClick={() => removePendingFile(i)}
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "rgba(0,0,0,0.7)",
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.6rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <textarea
              className="input-field"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit(e as any);
                }
              }}
              placeholder="描述你想要生成的图片... (Enter 发送，Shift+Enter 换行，Ctrl+V 粘贴参考图)"
              rows={3}
              style={{ resize: "none", paddingRight: 44, minHeight: 72 }}
              disabled={submitting || !selectedModel}
            />
            {/* 参考图上传按钮 */}
            <label
              title="上传参考图"
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                cursor: "pointer",
                color: "var(--text-muted)",
                lineHeight: 1,
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={(e) => {
                  const selected = Array.from(e.target.files ?? []);
                  if (selected.length > 0) {
                    setPendingFiles((prev) => [...prev, ...selected].slice(0, 9));
                  }
                  e.target.value = "";
                }}
                style={{ display: "none" }}
              />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </label>
          </div>

          <button
            className="btn-primary"
            type="submit"
            disabled={submitting || !prompt.trim() || !selectedModel}
            style={{ minWidth: 64, flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
          >
            {submitting ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </form>

        {!selectedModel && (
          <p style={{ margin: "8px 0 0", fontSize: "0.75rem", color: "var(--error)" }}>
            未配置可用模型，请先到系统设置中配置文字生图模型。
          </p>
        )}
      </div>
    </div>
  );
}
