"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { getToken, getRole } from "../../../lib/auth";
import { tiktokApi, TiktokAccountSummary, TiktokAccountStatus } from "../../../lib/tiktok";

const STATUS_LABEL: Record<TiktokAccountStatus, { label: string; bg: string; color: string; border: string }> = {
  active: { label: "正常", bg: "rgba(16,185,129,0.1)", color: "#10b981", border: "rgba(16,185,129,0.2)" },
  cookie_expired: { label: "Cookie 过期", bg: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "rgba(245,158,11,0.25)" },
  captcha_blocked: { label: "验证码拦截", bg: "rgba(249,115,22,0.1)", color: "#f97316", border: "rgba(249,115,22,0.25)" },
  error: { label: "异常", bg: "rgba(239,68,68,0.1)", color: "#ef4444", border: "rgba(239,68,68,0.2)" },
  disabled: { label: "已停用", bg: "#F1F5F9", color: "#94A3B8", border: "#E2E8F0" },
};

function formatNumber(n: number | string) {
  const v = typeof n === "string" ? Number(n) : n;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(v);
}

function formatCents(cents: string) {
  const v = Number(cents) / 100;
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(iso: string | null) {
  if (!iso) return "从未";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export default function TiktokListPage() {
  const router = useRouter();
  const [items, setItems] = useState<TiktokAccountSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | TiktokAccountStatus>("");
  const [scope, setScope] = useState<"all" | "mine">("mine");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [modal, setModal] = useState<"create" | { type: "upload"; id: string; handle: string } | { type: "delete"; id: string; handle: string } | null>(null);
  const [newHandle, setNewHandle] = useState("");
  const [newNickname, setNewNickname] = useState("");
  const [newInterval, setNewInterval] = useState(60);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const token = typeof window !== "undefined" ? getToken() : null;
  const role = typeof window !== "undefined" ? getRole() : null;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const data = await tiktokApi.listAccounts(token, {
        q: q || undefined,
        status: statusFilter || undefined,
        scope: role === "admin" ? scope : "mine",
        page,
        pageSize,
      });
      setItems(data.items);
      setTotal(data.total);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, q, statusFilter, scope, page, role]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setPage(1); void load(); }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, statusFilter, scope, load]);

  useEffect(() => { void load(); }, [page, load]);

  const handleCreate = async () => {
    if (!token || !newHandle) return;
    try {
      setSubmitting(true);
      const h = newHandle.startsWith("@") ? newHandle : `@${newHandle}`;
      await tiktokApi.createAccount(token, { handle: h, nickname: newNickname || undefined, scrapeIntervalMin: newInterval });
      setModal(null);
      setNewHandle("");
      setNewNickname("");
      setNewInterval(60);
      setPage(1);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefresh = async (id: string) => {
    if (!token) return;
    try {
      setRefreshingId(id);
      await tiktokApi.refreshAccount(token, id);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!token) return;
    try {
      setSubmitting(true);
      await tiktokApi.deleteAccount(token, id);
      setModal(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-enter">
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1.4rem", color: "var(--text-primary)", margin: 0 }}>
          TikTok 数据
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "inherit", marginTop: 4 }}>
          TIKTOK DASHBOARD
        </p>
      </div>

      {/* 工具条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 280 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="input-field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 handle / 昵称"
            style={{ paddingLeft: 36, width: "100%" }}
          />
        </div>

        <select
          className="btn-ghost"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TiktokAccountStatus | "")}
          style={{ minWidth: 120 }}
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="cookie_expired">Cookie 过期</option>
          <option value="captcha_blocked">验证码拦截</option>
          <option value="error">异常</option>
          <option value="disabled">已停用</option>
        </select>

        {role === "admin" && (
          <div style={{ display: "flex", border: "1px solid #E2E8F0", borderRadius: 8, padding: 2, background: "#F8FAFC" }}>
            {(["mine", "all"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setScope(v)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: "pointer",
                  background: scope === v ? "#FFFFFF" : "transparent",
                  color: scope === v ? "#2563EB" : "#94A3B8",
                  boxShadow: scope === v ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {v === "mine" ? "仅我的" : "所有人"}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={() => setModal("create")}>+ 新建账号</button>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "#ef4444", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* 列表 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ height: 200, background: "#F1F5F9", borderRadius: 12, animation: "pulse 1.5s infinite" }} />
          ))
        ) : items.length === 0 ? (
          <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 60, color: "#94A3B8" }}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1" style={{ marginBottom: 16 }}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
            <div style={{ fontSize: "0.875rem" }}>暂无 TikTok 账号</div>
            <button className="btn-primary" onClick={() => setModal("create")} style={{ marginTop: 16 }}>
              + 创建第一个账号
            </button>
          </div>
        ) : (
          items.map((acc) => {
            const st = STATUS_LABEL[acc.status];
            const isRefreshing = refreshingId === acc.id;
            return (
              <div
                key={acc.id}
                onClick={() => router.push(`/tiktok/${acc.id}`)}
                style={{
                  background: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: 12,
                  padding: 16,
                  cursor: "pointer",
                  transition: "all 0.15s",
                  position: "relative",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#2563EB";
                  e.currentTarget.style.boxShadow = "0 4px 16px rgba(37,99,235,0.12)";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#E2E8F0";
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.transform = "none";
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "#0F172A" }}>{acc.handle}</div>
                    {acc.nickname && <div style={{ fontSize: "0.75rem", color: "#94A3B8", marginTop: 2 }}>{acc.nickname}</div>}
                  </div>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 9999,
                      fontSize: "0.7rem",
                      fontWeight: 500,
                      background: st.bg,
                      color: st.color,
                      border: `1px solid ${st.border}`,
                    }}
                  >
                    {st.label}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                  {[
                    { label: "粉丝", value: formatNumber(acc.followerCount) },
                    { label: "视频", value: formatNumber(acc.videoCount) },
                    { label: "GMV", value: formatCents(acc.totalGmvCents) },
                    { label: "订单", value: formatNumber(acc.totalOrders) },
                  ].map((m) => (
                    <div key={m.label}>
                      <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "#0F172A" }}>{m.value}</div>
                      <div style={{ fontSize: "0.65rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.08em" }}>{m.label}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #E2E8F0", paddingTop: 10 }}>
                  <span style={{ fontSize: "0.7rem", color: "#94A3B8" }}>{timeAgo(acc.lastScrapedAt)}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRefresh(acc.id); }}
                      style={{ ...buttonIconStyle, opacity: isRefreshing ? 0.5 : 1 }}
                      title="刷新"
                      disabled={isRefreshing}
                    >
                      {isRefreshing ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" transform="rotate(-90 12 12)">
                            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
                          </circle>
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="23 4 23 10 17 10" />
                          <polyline points="1 20 1 14 7 14" />
                          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setModal({ type: "upload", id: acc.id, handle: acc.handle }); }}
                      style={buttonIconStyle}
                      title="上传 Cookie"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setModal({ type: "delete", id: acc.id, handle: acc.handle }); }}
                      style={buttonIconStyle}
                      title="删除"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 分页 */}
      {!loading && total > pageSize && (
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 24 }}>
          <button className="btn-ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>‹</button>
          {Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                border: "none",
                fontSize: "0.8rem",
                cursor: "pointer",
                background: p === page ? "#2563EB" : "transparent",
                color: p === page ? "#fff" : "#475569",
              }}
            >
              {p}
            </button>
          ))}
          <button className="btn-ghost" onClick={() => setPage((p) => p + 1)} disabled={page >= Math.ceil(total / pageSize)}>›</button>
        </div>
      )}

      {/* 创建弹窗 */}
      {modal === "create" && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 440 }}>
            <div style={{ borderBottom: "2px solid #2563EB", paddingBottom: 12, marginBottom: 20 }}>
              <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "#2563EB", margin: 0, fontSize: "1rem" }}>新建 TikTok 账号</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>Handle *</label>
                <input className="input-field" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} placeholder="fashion_sara" />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>昵称</label>
                <input className="input-field" value={newNickname} onChange={(e) => setNewNickname(e.target.value)} placeholder="显示名称（可选）" />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>抓取间隔 (min)</label>
                <input className="input-field" type="number" min={15} max={1440} value={newInterval} onChange={(e) => setNewInterval(Number(e.target.value))} />
              </div>
              {error && <div style={{ fontSize: "0.8rem", color: "#ef4444" }}>{error}</div>}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn-ghost" onClick={() => setModal(null)} type="button">取消</button>
                <button className="btn-primary" onClick={handleCreate} disabled={submitting || !newHandle} type="button">{submitting ? "创建中..." : "创建"}</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 上传 Cookie 弹窗 */}
      {modal && typeof modal === "object" && modal.type === "upload" && createPortal(
        <UploadCookieModal
          handle={modal.handle}
          accountId={modal.id}
          token={token!}
          onClose={() => setModal(null)}
          onSuccess={() => { setModal(null); setError(""); }}
        />,
        document.body,
      )}

      {/* 删除确认弹窗 */}
      {modal && typeof modal === "object" && modal.type === "delete" && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 400 }}>
            <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#ef4444", margin: "0 0 8px" }}>确认删除</h3>
            <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 20 }}>
              确定要删除账号 <strong style={{ color: "#0F172A" }}>{(modal as any).handle}</strong> 吗？该账号的所有历史数据将被永久删除，无法恢复。
            </p>
            {error && <div style={{ fontSize: "0.8rem", color: "#ef4444", marginBottom: 12 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn-ghost" onClick={() => setModal(null)} type="button">取消</button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleDelete((modal as any).id)}
                style={{ background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: "0.875rem", cursor: "pointer", opacity: submitting ? 0.5 : 1 }}
              >
                {submitting ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

const buttonIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#94A3B8",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  padding: 0,
};

function UploadCookieModal({ handle, accountId, token, onClose, onSuccess }: {
  handle: string;
  accountId: string;
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");

  const handleUpload = async () => {
    if (!file) return;
    try {
      setUploading(true);
      await tiktokApi.uploadCookie(token, accountId, file);
      onSuccess();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 440 }}>
        <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#0F172A", margin: "0 0 8px" }}>
          上传 Cookie — {handle}
        </h3>
        <p style={{ color: "#475569", fontSize: "0.8rem", marginBottom: 16 }}>
          选择 Playwright storage_state JSON 文件（通过浏览器的 Application {"{'>'}"} Cookies {"{'>'}"} Export 导出）
        </p>
        <input
          type="file"
          accept=".json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ marginBottom: 16, width: "100%" }}
        />
        {err && <div style={{ fontSize: "0.8rem", color: "#ef4444", marginBottom: 12 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={handleUpload} disabled={uploading || !file}>{uploading ? "上传中..." : "上传"}</button>
        </div>
      </div>
    </div>
  );
}
