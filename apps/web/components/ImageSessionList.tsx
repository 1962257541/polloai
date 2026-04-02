"use client";

import { useEffect, useRef, useState } from "react";
import { api, SessionSummary } from "../lib/api";
import { getToken } from "../lib/auth";

interface ImageSessionListProps {
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  refreshTrigger?: number; // 外部触发刷新（新会话创建后递增）
}

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

export default function ImageSessionList({
  currentSessionId,
  onSelectSession,
  onNewSession,
  refreshTrigger,
}: ImageSessionListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const token = getToken() ?? "";

  const loadSessions = async (replace = true) => {
    if (!token) return;
    if (replace) setLoading(true);
    try {
      const res = await api.listSessions(token, "text_to_image", 30, replace ? 0 : sessions.length);
      if (replace) {
        setSessions(res.items);
      } else {
        setSessions((prev) => {
          const existingIds = new Set(prev.map((s) => s.sessionId));
          return [...prev, ...res.items.filter((s) => !existingIds.has(s.sessionId))];
        });
      }
      setHasMore(res.items.length === 30);
    } finally {
      if (replace) setLoading(false);
      else setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadSessions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshTrigger]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startEdit = (session: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.sessionId);
    setEditingTitle(session.title);
  };

  const commitEdit = async (sessionId: string) => {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    setSessions((prev) =>
      prev.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)),
    );
    try {
      await api.renameSession(token, sessionId, title);
    } catch {
      // 回滚（重新加载）
      void loadSessions(true);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        overflow: "hidden",
      }}
    >
      {/* 顶部 */}
      <div
        style={{
          padding: "16px 16px 12px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
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
            onClick={() => void loadSessions(true)}
            title="刷新"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              padding: 2,
              lineHeight: 1,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: currentSessionId === null ? "var(--accent-glow)" : "transparent",
            color: currentSessionId === null ? "var(--accent)" : "var(--text-secondary)",
            fontSize: "0.82rem",
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "all 0.15s",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          新建对话
        </button>
      </div>

      {/* 会话列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: "20px 16px", textAlign: "center", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            加载中...
          </div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: "20px 16px", textAlign: "center", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            暂无历史对话
          </div>
        ) : (
          <>
            {sessions.map((session) => {
              const isActive = session.sessionId === currentSessionId;
              const isEditing = editingId === session.sessionId;
              return (
                <div
                  key={session.sessionId}
                  onClick={() => !isEditing && onSelectSession(session.sessionId)}
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
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-raised)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent";
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
                    {session.outputUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={session.outputUrl}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="m21 15-5-5L5 21" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* 内容 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => void commitEdit(session.sessionId)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitEdit(session.sessionId);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          width: "100%",
                          background: "var(--bg-raised)",
                          border: "1px solid var(--accent)",
                          borderRadius: 4,
                          padding: "2px 6px",
                          fontSize: "0.8rem",
                          color: "var(--text-primary)",
                          outline: "none",
                        }}
                      />
                    ) : (
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
                        {session.title || "未命名对话"}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        {timeAgo(session.latestCreatedAt)}
                      </span>
                      {session.taskCount > 1 && (
                        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "inherit" }}>
                          · {session.taskCount} 张
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 编辑按钮 */}
                  <button
                    type="button"
                    onClick={(e) => startEdit(session, e)}
                    title="重命名"
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
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.5"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </div>
              );
            })}

            {hasMore && (
              <div style={{ padding: "10px 16px" }}>
                <button
                  type="button"
                  onClick={() => {
                    setLoadingMore(true);
                    void loadSessions(false);
                  }}
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
  );
}
