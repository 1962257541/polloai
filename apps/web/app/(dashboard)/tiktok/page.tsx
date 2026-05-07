"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getToken, getRole } from "../../../lib/auth";
import {
  tiktokApi,
  TiktokAccountSummary,
  TiktokAccountDetail,
  TiktokAccountStatus,
  TiktokVideo,
  TiktokRecentStats,
} from "../../../lib/tiktok";

// ============== shared utilities ==============

const STATUS_LABEL: Record<TiktokAccountStatus, { label: string; bg: string; color: string; border: string }> = {
  active: { label: "正常", bg: "rgba(16,185,129,0.10)", color: "#059669", border: "rgba(16,185,129,0.25)" },
  not_found: { label: "未找到", bg: "rgba(245,158,11,0.10)", color: "#d97706", border: "rgba(245,158,11,0.25)" },
  rate_limited: { label: "反爬限流", bg: "rgba(249,115,22,0.10)", color: "#ea580c", border: "rgba(249,115,22,0.25)" },
  error: { label: "异常", bg: "rgba(239,68,68,0.10)", color: "#dc2626", border: "rgba(239,68,68,0.25)" },
  disabled: { label: "已停用", bg: "#F1F5F9", color: "#94A3B8", border: "#E2E8F0" },
};

function formatNumber(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "0";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(Math.round(v));
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function formatPublishedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}/${mm}/${dd} ${hh}:${mi}`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "从未";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function tiktokProfileUrl(account: { handle: string | null; uid: string | null }): string {
  if (account.handle) {
    const h = account.handle.startsWith("@") ? account.handle.slice(1) : account.handle;
    return `https://www.tiktok.com/@${h}`;
  }
  if (account.uid) return `https://www.tiktok.com/share/user/${account.uid}`;
  return "https://www.tiktok.com/";
}

function tiktokVideoUrl(account: { handle: string | null }, videoId: string): string {
  if (account.handle) {
    const h = account.handle.startsWith("@") ? account.handle.slice(1) : account.handle;
    return `https://www.tiktok.com/@${h}/video/${videoId}`;
  }
  return `https://www.tiktok.com/video/${videoId}`;
}

// ============== main page ==============

export default function TiktokListPage() {
  const [items, setItems] = useState<TiktokAccountSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  type Modal =
    | "create"
    | { type: "edit"; account: TiktokAccountSummary }
    | { type: "delete"; id: string; handle: string }
    | { type: "detail"; accountId: string }
    | null;
  const [modal, setModal] = useState<Modal>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const token = mounted ? getToken() : null;
  const role = mounted ? getRole() : null;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const data = await tiktokApi.listAccounts(token, {
        q: q || undefined,
        scope: role === "admin" ? "all" : "mine",
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
  }, [token, q, page, role]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setPage(1); void load(); }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, load]);

  useEffect(() => { void load(); }, [page, load]);

  return (
    <div className="page-enter">
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1.4rem", color: "var(--text-primary)", margin: 0 }}>
          TikTok 数据
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 4 }}>
          TIKTOK PUBLIC PROFILE MONITOR
        </p>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 320 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="input-field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 handle / UID / 昵称 / 销售员"
            style={{ paddingLeft: 36, width: "100%" }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={() => setModal("create")}>+ 新建账号</button>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "10px 12px", fontSize: "0.8rem", color: "#dc2626", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ padding: 60, textAlign: "center", color: "#94A3B8" }}>加载中...</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: "#94A3B8", border: "1px dashed #E2E8F0", borderRadius: 12 }}>
          <div style={{ marginBottom: 12 }}>暂无 TikTok 账号</div>
          <button className="btn-primary" onClick={() => setModal("create")}>+ 创建第一个账号</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {items.map((acc) => (
            <AccountCard
              key={acc.id}
              account={acc}
              token={token!}
              onClickDetail={() => setModal({ type: "detail", accountId: acc.id })}
              onClickEdit={() => setModal({ type: "edit", account: acc })}
              onClickDelete={() => setModal({ type: "delete", id: acc.id, handle: acc.handle ?? acc.uid ?? acc.id })}
              onRefreshed={() => load()}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && total > pageSize && (
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 24 }}>
          <button className="btn-ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>‹</button>
          {Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: "none",
                fontSize: "0.8rem",
                fontWeight: 600,
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

      {/* Modals */}
      {modal === "create" && createPortal(
        <CreateAccountModal token={token!} onClose={() => setModal(null)} onSuccess={() => { setModal(null); setPage(1); void load(); }} />,
        document.body,
      )}
      {modal && typeof modal === "object" && modal.type === "edit" && createPortal(
        <EditAccountModal account={modal.account} token={token!} onClose={() => setModal(null)} onSuccess={() => { setModal(null); void load(); }} />,
        document.body,
      )}
      {modal && typeof modal === "object" && modal.type === "delete" && createPortal(
        <DeleteConfirmModal handle={modal.handle} id={modal.id} token={token!} onClose={() => setModal(null)} onSuccess={() => { setModal(null); void load(); }} />,
        document.body,
      )}
      {modal && typeof modal === "object" && modal.type === "detail" && createPortal(
        <DetailDrawer accountId={modal.accountId} token={token!} onClose={() => setModal(null)} />,
        document.body,
      )}
    </div>
  );
}

// ============== Account Card ==============

function AccountCard({
  account,
  token,
  onClickDetail,
  onClickEdit,
  onClickDelete,
  onRefreshed,
}: {
  account: TiktokAccountSummary;
  token: string;
  onClickDetail: () => void;
  onClickEdit: () => void;
  onClickDelete: () => void;
  onRefreshed: () => void;
}) {
  const [videos, setVideos] = useState<TiktokVideo[]>([]);
  const [stats, setStats] = useState<TiktokRecentStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hovered, setHovered] = useState(false);

  const fetchSubData = useCallback(async () => {
    try {
      const [vids, s] = await Promise.all([
        tiktokApi.listVideos(token, account.id, { limit: 6 }),
        tiktokApi.getRecentStats(token, account.id, 15),
      ]);
      setVideos(vids);
      setStats(s);
    } catch {
      /* ignore */
    }
  }, [token, account.id]);

  useEffect(() => { void fetchSubData(); }, [fetchSubData, account.lastScrapedAt]);

  // 首次抓取自动 poll
  useEffect(() => {
    if (account.lastScrapedAt || refreshing) return;
    if (account.status === "disabled") return;
    let cancelled = false;
    setRefreshing(true);
    const start = Date.now();
    const poll = async () => {
      while (!cancelled && Date.now() - start < 180_000) {
        await new Promise((r) => setTimeout(r, 4000));
        if (cancelled) return;
        try {
          const acc = await tiktokApi.getAccount(token, account.id);
          if (acc.lastScrapedAt) {
            if (!cancelled) { onRefreshed(); setRefreshing(false); }
            return;
          }
        } catch { /* continue */ }
      }
      if (!cancelled) setRefreshing(false);
    };
    void poll();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.lastScrapedAt]);

  const handleRefresh = async () => {
    if (refreshing) return;
    const beforeTs = account.lastScrapedAt ? new Date(account.lastScrapedAt).getTime() : 0;
    setRefreshing(true);
    try {
      await tiktokApi.refreshAccount(token, account.id);
    } catch (e) {
      alert((e as Error).message);
      setRefreshing(false);
      return;
    }
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const acc = await tiktokApi.getAccount(token, account.id);
        const ts = acc.lastScrapedAt ? new Date(acc.lastScrapedAt).getTime() : 0;
        if (ts > beforeTs) { onRefreshed(); setRefreshing(false); return; }
      } catch { /* continue */ }
    }
    setRefreshing(false);
  };

  const st = STATUS_LABEL[account.status];
  const isUid = !account.handle && !!account.uid;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClickDetail}
      style={{
        background: "#FFFFFF",
        border: `1px solid ${hovered ? "rgba(37,99,235,0.35)" : "#E2E8F0"}`,
        borderRadius: 14,
        padding: "16px 20px",
        display: "grid",
        gridTemplateColumns: "auto minmax(260px, 1.1fr) minmax(220px, 1fr) minmax(540px, 1.5fr)",
        gap: 20,
        alignItems: "stretch",
        cursor: "pointer",
        transition: "all 0.15s",
        boxShadow: hovered ? "0 6px 20px rgba(37,99,235,0.10)" : "0 1px 2px rgba(0,0,0,0.02)",
        transform: hovered ? "translateY(-1px)" : "none",
        position: "relative",
      }}
    >
      {/* 左：头像 + 来源 chip */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minWidth: 88 }}>
        <div style={{ position: "relative" }}>
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              style={{ width: 64, height: 64, borderRadius: 14, objectFit: "cover", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div style={{ width: 64, height: 64, borderRadius: 14, background: "linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)", display: "flex", alignItems: "center", justifyContent: "center", color: "#6366F1", fontSize: "1.4rem", fontWeight: 700 }}>
              {(account.nickname || account.handle || account.uid || "?").charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <span style={{
          padding: "3px 10px",
          borderRadius: 6,
          fontSize: "0.65rem",
          fontWeight: 700,
          letterSpacing: "0.05em",
          background: isUid ? "rgba(99,102,241,0.10)" : "rgba(20,184,166,0.10)",
          color: isUid ? "#6366f1" : "#0d9488",
          border: `1px solid ${isUid ? "rgba(99,102,241,0.20)" : "rgba(20,184,166,0.20)"}`,
        }}>
          {isUid ? "UID" : "HANDLE"}
        </span>
      </div>

      {/* 中：账号基本信息 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "1rem", fontWeight: 700, color: "#0F172A" }}>
            {account.nickname || account.handle || account.uid}
          </span>
          {account.salesTag && (
            <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 600, background: "rgba(244,63,94,0.10)", color: "#e11d48", border: "1px solid rgba(244,63,94,0.2)" }}>
              {account.salesTag}
            </span>
          )}
          <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 600, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
            {st.label}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: "0.8rem", color: "#475569", fontWeight: 500 }}>
            {account.handle || (account.uid ? `UID:${account.uid}` : "")}
          </span>
        </div>

        <div style={{ display: "flex", gap: 16, fontSize: "0.75rem", color: "#475569", marginTop: 2 }}>
          <span>地区：<strong style={{ color: "#0F172A" }}>{account.region || "—"}</strong></span>
          <span>分类：<strong style={{ color: "#0F172A" }}>{account.category || "—"}</strong></span>
          {account.note && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }} title={account.note}>
              备注：<strong style={{ color: "#0F172A" }}>{account.note}</strong>
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 22, marginTop: 6 }}>
          {[
            { label: "粉丝", value: formatNumber(account.followerCount) },
            { label: "点赞", value: formatNumber(account.heartCount) },
            { label: "作品", value: formatNumber(account.videoCount) },
          ].map((m) => (
            <div key={m.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: "0.62rem", color: "#94A3B8", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em" }}>{m.label}</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0F172A" }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 中右：过去 15 天 */}
      <div style={{
        background: "linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%)",
        borderRadius: 10,
        padding: "12px 14px",
        border: "1px solid #E2E8F0",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
      }}>
        <div style={{ fontSize: "0.62rem", color: "#64748B", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>
          过去 15 天
        </div>
        {stats ? (
          <div style={{ fontSize: "0.78rem", color: "#475569", lineHeight: 1.65 }}>
            <RowKV k="视频数量" v={stats.videoCount.toString()} />
            <RowKV k="总播放" v={formatNumber(stats.totalPlay)} />
            <RowKV k="播粉比" v={stats.playFollowerRatio.toFixed(2)} />
            <RowKV k="均播" v={formatNumber(stats.avgPlay)} />
            <RowKV k="日均发布" v={stats.postsPerDay.toFixed(2)} />
          </div>
        ) : (
          <div style={{ fontSize: "0.75rem", color: "#94A3B8" }}>—</div>
        )}
      </div>

      {/* 右：近 6 条 + actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.72rem", color: refreshing ? "#2563EB" : "#94A3B8", display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
            {refreshing && <Spinner size={12} />}
            {refreshing
              ? account.lastScrapedAt ? "重新采集中..." : "首次采集中..."
              : `近 6 条 · ${account.lastScrapedAt ? formatRelativeTime(account.lastScrapedAt) : "未抓取"}`}
          </span>
          <div style={{ display: "flex", gap: 4, opacity: hovered ? 1 : 0.6, transition: "opacity 0.15s" }}>
            <ActionBtn title="详情" onClick={(e) => { e.stopPropagation(); onClickDetail(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
            </ActionBtn>
            <ActionBtn title="编辑" onClick={(e) => { e.stopPropagation(); onClickEdit(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            </ActionBtn>
            <ActionBtn title={refreshing ? "采集中..." : "刷新"} disabled={refreshing} onClick={(e) => { e.stopPropagation(); handleRefresh(); }}>
              {refreshing ? <Spinner size={13} /> : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
              )}
            </ActionBtn>
            <ActionBtn title="删除" danger onClick={(e) => { e.stopPropagation(); onClickDelete(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </ActionBtn>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, overflowX: "auto", position: "relative" }}>
          {videos.length === 0 ? (
            <div style={{
              flex: 1, padding: 14, textAlign: "center",
              color: refreshing ? "#2563EB" : "#94A3B8",
              fontSize: "0.75rem",
              border: `1px dashed ${refreshing ? "#93C5FD" : "#E2E8F0"}`,
              borderRadius: 10,
              background: refreshing ? "rgba(37,99,235,0.04)" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              {refreshing && <Spinner size={12} />}
              {refreshing
                ? account.lastScrapedAt ? "正在重新采集..." : "正在采集，请稍候..."
                : account.status === "rate_limited" ? "TikTok 反爬限流中"
                  : account.lastScrapedAt ? "暂无视频" : "等待首次抓取..."}
            </div>
          ) : (
            <>
              {videos.slice(0, 6).map((v) => <VideoThumb key={v.id} video={v} compact />)}
              {refreshing && (
                <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.7)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10, gap: 6, color: "#2563EB", fontSize: "0.75rem", fontWeight: 600 }}>
                  <Spinner size={14} />采集中...
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RowKV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#64748B" }}>{k}</span>
      <strong style={{ color: "#0F172A" }}>{v}</strong>
    </div>
  );
}

function ActionBtn({ children, onClick, title, danger = false, disabled = false }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        border: "1px solid #E2E8F0",
        background: "#FFFFFF",
        color: danger ? "#dc2626" : "#475569",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
        transition: "all 0.12s",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = danger ? "#dc2626" : "#2563EB";
        e.currentTarget.style.background = danger ? "rgba(220,38,38,0.05)" : "rgba(37,99,235,0.05)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#E2E8F0";
        e.currentTarget.style.background = "#FFFFFF";
      }}
    >
      {children}
    </button>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeDasharray="31.4 31.4" transform="rotate(-90 12 12)">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function VideoThumb({ video, compact = false, onClick }: { video: TiktokVideo; compact?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  const w = compact ? 84 : "100%";
  const h = compact ? 110 : 200;
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        flex: compact ? "0 0 auto" : "1 1 auto",
        width: w,
        borderRadius: 10,
        overflow: "hidden",
        background: "#0F172A",
        cursor: onClick ? "pointer" : "default",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
      }}
    >
      {video.coverUrl ? (
        <img
          src={video.coverUrl}
          alt={video.title || video.videoId}
          style={{ width: "100%", height: h, objectFit: "cover", display: "block" }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <div style={{ width: "100%", height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: "0.7rem" }}>
          无封面
        </div>
      )}
      <span style={{ position: "absolute", top: 5, left: 5, padding: "2px 6px", fontSize: "0.65rem", fontWeight: 700, background: "rgba(0,0,0,0.7)", color: "#fff", borderRadius: 4 }}>
        ▶ {formatNumber(video.playCount)}
      </span>
      <span style={{ position: "absolute", top: 5, right: 5, padding: "2px 6px", fontSize: "0.65rem", fontWeight: 700, background: "rgba(0,0,0,0.7)", color: "#fff", borderRadius: 4 }}>
        {formatDuration(video.durationMs)}
      </span>
      <span style={{ position: "absolute", bottom: 5, left: 5, right: 5, padding: "2px 6px", fontSize: "0.6rem", fontWeight: 500, background: "rgba(0,0,0,0.7)", color: "#fff", borderRadius: 4, textAlign: "center" }}>
        {formatPublishedAt(video.publishedAt)}
      </span>
      {onClick && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(0,0,0,0.0)",
          display: "flex", alignItems: "center", justifyContent: "center",
          opacity: 0, transition: "all 0.15s",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.35)"; e.currentTarget.style.opacity = "1"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0)"; e.currentTarget.style.opacity = "0"; }}
        >
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(255,255,255,0.95)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#0F172A"><polygon points="5 3 19 12 5 21" /></svg>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== Detail Drawer ==============

function DetailDrawer({ accountId, token, onClose }: { accountId: string; token: string; onClose: () => void }) {
  const [account, setAccount] = useState<TiktokAccountDetail | null>(null);
  const [videos, setVideos] = useState<TiktokVideo[]>([]);
  const [stats, setStats] = useState<TiktokRecentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<"publishedAt" | "playCount">("publishedAt");
  const [playingVideo, setPlayingVideo] = useState<TiktokVideo | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [acc, vids, s] = await Promise.all([
        tiktokApi.getAccount(token, accountId),
        tiktokApi.listVideos(token, accountId, { sortBy }),
        tiktokApi.getRecentStats(token, accountId, 15),
      ]);
      setAccount(acc);
      setVideos(vids);
      setStats(s);
    } finally {
      setLoading(false);
    }
  }, [token, accountId, sortBy]);

  useEffect(() => { void load(); }, [load]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (playingVideo) setPlayingVideo(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, playingVideo]);

  const profileUrl = useMemo(() => account ? tiktokProfileUrl(account) : "#", [account]);

  return (
    <>
      {/* Backdrop + center container (click outside to close) */}
      <div
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={{
          position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", backdropFilter: "blur(4px)",
          zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 24,
          animation: "fadeIn 0.18s ease-out",
        }}
      >
      {/* Modal */}
      <div style={{
        width: "min(100%, 1080px)",
        maxHeight: "calc(100vh - 48px)",
        background: "#FFFFFF",
        borderRadius: 16,
        boxShadow: "0 24px 60px rgba(15,23,42,0.30)",
        display: "flex", flexDirection: "column",
        animation: "scaleIn 0.20s ease-out",
        overflow: "hidden",
      }}>
        {loading || !account ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8" }}>加载中...</div>
        ) : (
          <>
            {/* Header */}
            <div style={{
              padding: "20px 24px",
              borderBottom: "1px solid #E2E8F0",
              display: "flex",
              alignItems: "flex-start",
              gap: 16,
              background: "linear-gradient(180deg, #FAFBFF 0%, #FFFFFF 100%)",
            }}>
              {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" style={{ width: 72, height: 72, borderRadius: 16, objectFit: "cover", boxShadow: "0 4px 14px rgba(0,0,0,0.08)" }} />
              ) : (
                <div style={{ width: 72, height: 72, borderRadius: 16, background: "linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)", display: "flex", alignItems: "center", justifyContent: "center", color: "#6366F1", fontSize: "1.6rem", fontWeight: 700 }}>
                  {(account.nickname || account.handle || "?").charAt(0).toUpperCase()}
                </div>
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#0F172A" }}>
                    {account.nickname || account.handle || account.uid}
                  </h2>
                  <StatusChip status={account.status} />
                  {account.salesTag && (
                    <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 600, background: "rgba(244,63,94,0.10)", color: "#e11d48", border: "1px solid rgba(244,63,94,0.2)" }}>{account.salesTag}</span>
                  )}
                </div>

                <div style={{ marginTop: 4, fontSize: "0.85rem", color: "#475569" }}>
                  {account.handle && <span>{account.handle}</span>}
                  {account.handle && account.uid && <span style={{ color: "#CBD5E1", margin: "0 8px" }}>·</span>}
                  {account.uid && <span style={{ color: "#94A3B8" }}>UID: {account.uid}</span>}
                </div>

              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <button
                  onClick={onClose}
                  title="关闭 (ESC)"
                  style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #E2E8F0", background: "#FFFFFF", color: "#475569", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
                <a
                  href={profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "8px 14px", borderRadius: 8,
                    background: "#0F172A", color: "#FFFFFF",
                    fontSize: "0.78rem", fontWeight: 600, textDecoration: "none",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#1E293B"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#0F172A"; }}
                >
                  去 TikTok 主页
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                </a>
              </div>
            </div>

            {/* Body (scrollable) */}
            <div style={{ flex: 1, overflowY: "auto", padding: 24, background: "#F8FAFC", display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Section: 基本信息 */}
              <Section title="基本信息">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Pill icon="📍" label="地区" value={account.region} />
                  <Pill icon="🏷️" label="分类" value={account.category} />
                  <Pill icon="📝" label="备注" value={account.note} />
                </div>
                {account.bioSignature && (
                  <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", background: "#F8FAFC", borderRadius: 10, border: "1px solid #F1F5F9" }}>
                    <span style={{ fontSize: "0.95rem", lineHeight: "1.4" }}>✍️</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.7rem", color: "#94A3B8", fontWeight: 600, marginBottom: 2 }}>签名</div>
                      <div style={{ fontSize: "0.85rem", color: "#475569", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {account.bioSignature}
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              {/* Section: 统计数据 */}
              <Section title="统计数据">
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  borderRadius: 12,
                  background: "linear-gradient(135deg, #F8FAFC 0%, #F1F5F9 100%)",
                  overflow: "hidden",
                }}>
                  <BigStat label="粉丝" value={formatNumber(account.followerCount)} accent="#3B82F6" hasRight />
                  <BigStat label="关注" value={formatNumber(account.followingCount)} accent="#10B981" hasRight />
                  <BigStat label="总点赞" value={formatNumber(account.heartCount)} accent="#F43F5E" hasRight />
                  <BigStat label="作品总数" value={formatNumber(account.videoCount)} accent="#8B5CF6" />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, marginBottom: 12 }}>
                  <span style={{ flex: 1, height: 1, background: "linear-gradient(to right, transparent, #E2E8F0, transparent)" }} />
                  <span style={{ fontSize: "0.7rem", color: "#64748B", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.1em", display: "flex", alignItems: "center", gap: 6 }}>
                    📅 过去 15 天
                  </span>
                  <span style={{ flex: 1, height: 1, background: "linear-gradient(to right, transparent, #E2E8F0, transparent)" }} />
                </div>

                {stats ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 0 }}>
                    <SmallStat label="视频数量" value={stats.videoCount.toString()} hasRight />
                    <SmallStat label="总播放" value={formatNumber(stats.totalPlay)} hasRight />
                    <SmallStat label="播粉比" value={stats.playFollowerRatio.toFixed(2)} hasRight />
                    <SmallStat label="均播" value={formatNumber(stats.avgPlay)} hasRight />
                    <SmallStat label="日均发布" value={stats.postsPerDay.toFixed(2)} />
                  </div>
                ) : <div style={{ color: "#94A3B8", fontSize: "0.85rem", textAlign: "center", padding: 12 }}>—</div>}
              </Section>

              {/* Section: 视频列表 */}
              <Section
                title={`视频列表 (${videos.length})`}
                action={
                  <div style={{ display: "flex", border: "1px solid #E2E8F0", borderRadius: 8, padding: 2, background: "#F8FAFC" }}>
                    {(["publishedAt", "playCount"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSortBy(s)}
                        style={{
                          padding: "6px 12px", borderRadius: 6, border: "none",
                          fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                          background: sortBy === s ? "#FFFFFF" : "transparent",
                          color: sortBy === s ? "#2563EB" : "#94A3B8",
                          boxShadow: sortBy === s ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                        }}
                      >
                        {s === "publishedAt" ? "按发布" : "按播放"}
                      </button>
                    ))}
                  </div>
                }
              >
                {videos.length === 0 ? (
                  <div style={{ padding: 36, textAlign: "center", color: "#94A3B8", fontSize: "0.85rem" }}>
                    {account.videoCount > 0
                      ? `账号声明有 ${account.videoCount} 个视频，但 TikTok 视频列表 API 暂未返回数据`
                      : "暂无视频"}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                    {videos.map((v) => (
                      <VideoCard key={v.id} video={v} onClick={() => setPlayingVideo(v)} />
                    ))}
                  </div>
                )}
              </Section>
            </div>
          </>
        )}
      </div>
      </div>

      {/* Lightbox */}
      {playingVideo && account && createPortal(
        <VideoLightbox video={playingVideo} account={account} onClose={() => setPlayingVideo(null)} />,
        document.body,
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 700, color: "#0F172A" }}>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function Pill({ icon, label, value }: { icon: string; label: string; value: string | null }) {
  const has = !!value;
  return (
    <div
      title={value ?? ""}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        background: has ? "#F1F5F9" : "#FAFAFA",
        border: `1px solid ${has ? "#E2E8F0" : "#F1F5F9"}`,
        borderRadius: 9999,
        maxWidth: "100%",
      }}
    >
      <span style={{ fontSize: "0.95rem", lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: "0.7rem", color: "#94A3B8", fontWeight: 600 }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: has ? "#0F172A" : "#CBD5E1",
          fontWeight: 600,
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function BigStat({ label, value, accent, hasRight = false }: { label: string; value: string; accent: string; hasRight?: boolean }) {
  return (
    <div style={{
      padding: "20px 22px",
      borderRight: hasRight ? "1px solid #E2E8F0" : "none",
      position: "relative",
    }}>
      <div style={{
        position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
        width: 3, height: 28, borderRadius: "0 3px 3px 0",
        background: accent,
      }} />
      <div style={{ fontSize: "0.7rem", color: "#64748B", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{
        fontSize: "1.6rem",
        fontWeight: 700,
        color: "#0F172A",
        lineHeight: 1.1,
        letterSpacing: "-0.02em",
      }}>{value}</div>
    </div>
  );
}

function SmallStat({ label, value, hasRight = false }: { label: string; value: string; hasRight?: boolean }) {
  return (
    <div style={{
      padding: "8px 14px",
      borderRight: hasRight ? "1px dashed #E2E8F0" : "none",
      textAlign: "center",
    }}>
      <div style={{ fontSize: "0.65rem", color: "#94A3B8", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0F172A", lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

function StatusChip({ status }: { status: TiktokAccountStatus }) {
  const st = STATUS_LABEL[status];
  return (
    <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 600, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
      {st.label}
    </span>
  );
}

function VideoCard({ video, onClick }: { video: TiktokVideo; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "#FFFFFF",
        border: "1px solid #E2E8F0",
        borderRadius: 12,
        overflow: "hidden",
        cursor: "pointer",
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(37,99,235,0.4)";
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 6px 16px rgba(37,99,235,0.10)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#E2E8F0";
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <VideoThumb video={video} onClick={() => onClick()} />
      <div style={{ padding: "8px 10px" }}>
        <div style={{
          fontSize: "0.78rem", color: "#0F172A", fontWeight: 500,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          lineHeight: 1.4, minHeight: "2.2em",
        }}>
          {video.title || "—"}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: "0.7rem", color: "#94A3B8" }}>
          <span>♥ {formatNumber(video.likeCount)}</span>
          <span>💬 {formatNumber(video.commentCount)}</span>
          <span>↗ {formatNumber(video.shareCount)}</span>
        </div>
      </div>
    </div>
  );
}

// ============== Video Lightbox ==============

function VideoLightbox({ video, account, onClose }: {
  video: TiktokVideo;
  account: { handle: string | null; uid: string | null };
  onClose: () => void;
}) {
  const [iframeFailed, setIframeFailed] = useState(false);
  const tiktokEmbed = `https://www.tiktok.com/player/v1/${video.videoId}?autoplay=1&loop=1&music_info=0`;
  const externalUrl = tiktokVideoUrl(account, video.videoId);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15,23,42,0.92)", backdropFilter: "blur(8px)",
        zIndex: 2000,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
        animation: "fadeIn 0.18s ease-out",
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: "absolute", top: 16, right: 16,
          width: 40, height: 40, borderRadius: 10,
          background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.2)",
          color: "#FFF", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
        title="关闭 (ESC)"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      <div style={{ display: "flex", gap: 16, maxWidth: 1100, width: "100%", maxHeight: "90vh" }}>
        {/* Player */}
        <div style={{ flex: "0 0 360px", aspectRatio: "9 / 16", background: "#000", borderRadius: 14, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}>
          {!iframeFailed ? (
            <iframe
              src={tiktokEmbed}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
              onError={() => setIframeFailed(true)}
              style={{ width: "100%", height: "100%", border: "none" }}
            />
          ) : video.videoUrl ? (
            <video
              src={video.videoUrl}
              controls
              autoPlay
              loop
              style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
            />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", padding: 24, textAlign: "center", fontSize: "0.85rem" }}>
              视频源不可用，请打开 TikTok 主页查看
            </div>
          )}
        </div>

        {/* Meta */}
        <div style={{
          flex: "0 0 360px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 14,
          padding: 20,
          color: "#F1F5F9",
          display: "flex", flexDirection: "column", gap: 14,
        }}>
          <div>
            <div style={{ fontSize: "0.65rem", color: "#94A3B8", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>视频标题</div>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {video.title || "—"}
            </div>
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
            <Stat label="播放" value={formatNumber(video.playCount)} />
            <Stat label="点赞" value={formatNumber(video.likeCount)} />
            <Stat label="评论" value={formatNumber(video.commentCount)} />
            <Stat label="分享" value={formatNumber(video.shareCount)} />
            <Stat label="收藏" value={formatNumber(video.collectCount)} />
            <Stat label="时长" value={formatDuration(video.durationMs)} />
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }} />

          <div>
            <div style={{ fontSize: "0.65rem", color: "#94A3B8", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>发布于</div>
            <div style={{ fontSize: "0.8rem" }}>{formatPublishedAt(video.publishedAt)}</div>
          </div>

          <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flex: 1, textAlign: "center",
                padding: "10px 14px", borderRadius: 10,
                background: "#FFFFFF", color: "#0F172A",
                fontSize: "0.8rem", fontWeight: 600, textDecoration: "none",
              }}
            >
              在 TikTok 打开 ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: "0.65rem", color: "#94A3B8", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: "1rem", fontWeight: 700, color: "#FFF", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ============== Modals (create / edit / delete) ==============

function CreateAccountModal({ token, onClose, onSuccess }: { token: string; onClose: () => void; onSuccess: () => void }) {
  const [mode, setMode] = useState<"handle" | "uid">("handle");
  const [handle, setHandle] = useState("");
  const [uid, setUid] = useState("");
  const [salesTag, setSalesTag] = useState("");
  const [category, setCategory] = useState("");
  const [region, setRegion] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (mode === "handle" && !handle.trim()) { setErr("请输入 @username"); return; }
    if (mode === "uid" && !uid.trim()) { setErr("请输入 19 位数字 UID"); return; }
    try {
      setSubmitting(true);
      await tiktokApi.createAccount(token, {
        handle: mode === "handle" ? handle.trim().replace(/^@/, "") : undefined,
        uid: mode === "uid" ? uid.trim() : undefined,
        salesTag: salesTag.trim() || undefined,
        category: category.trim() || undefined,
        region: region.trim() || undefined,
        note: note.trim() || undefined,
      });
      onSuccess();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="新建 TikTok 账号" onClose={onClose}>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {(["handle", "uid"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: "10px 10px",
              borderRadius: 8,
              border: "1px solid",
              borderColor: mode === m ? "#2563EB" : "#E2E8F0",
              background: mode === m ? "rgba(37,99,235,0.05)" : "#FFFFFF",
              color: mode === m ? "#2563EB" : "#475569",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.12s",
            }}
          >
            {m === "handle" ? "@username" : "数字 UID"}
          </button>
        ))}
      </div>

      {mode === "handle" ? (
        <Field label="HANDLE *">
          <input className="input-field" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="leaguels（可不带 @ 前缀）" />
        </Field>
      ) : (
        <Field label="UID *">
          <input className="input-field" value={uid} onChange={(e) => setUid(e.target.value)} placeholder="7123348672050906155" />
        </Field>
      )}

      <Field label="销售员"><input className="input-field" value={salesTag} onChange={(e) => setSalesTag(e.target.value)} placeholder="如：张敏" /></Field>
      <Field label="地区"><input className="input-field" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="如：墨西哥" /></Field>
      <Field label="分类"><input className="input-field" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="如：女装与女士内衣" /></Field>
      <Field label="备注"><input className="input-field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" /></Field>

      {err && <div style={{ fontSize: "0.8rem", color: "#dc2626", marginBottom: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-ghost" onClick={onClose} type="button">取消</button>
        <button className="btn-primary" onClick={submit} disabled={submitting} type="button">{submitting ? "创建中..." : "创建并抓取"}</button>
      </div>
    </ModalShell>
  );
}

function EditAccountModal({ account, token, onClose, onSuccess }: { account: TiktokAccountSummary; token: string; onClose: () => void; onSuccess: () => void }) {
  const [salesTag, setSalesTag] = useState(account.salesTag ?? "");
  const [category, setCategory] = useState(account.category ?? "");
  const [region, setRegion] = useState(account.region ?? "");
  const [note, setNote] = useState(account.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    try {
      setSubmitting(true);
      await tiktokApi.updateAccount(token, account.id, {
        salesTag: salesTag.trim() || "",
        category: category.trim() || "",
        region: region.trim() || "",
        note: note.trim() || "",
      });
      onSuccess();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`编辑 ${account.handle ?? account.uid}`} onClose={onClose}>
      <Field label="销售员"><input className="input-field" value={salesTag} onChange={(e) => setSalesTag(e.target.value)} /></Field>
      <Field label="地区"><input className="input-field" value={region} onChange={(e) => setRegion(e.target.value)} /></Field>
      <Field label="分类"><input className="input-field" value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
      <Field label="备注"><input className="input-field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <div style={{ fontSize: "0.8rem", color: "#dc2626", marginBottom: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-ghost" onClick={onClose} type="button">取消</button>
        <button className="btn-primary" onClick={submit} disabled={submitting} type="button">{submitting ? "保存中..." : "保存"}</button>
      </div>
    </ModalShell>
  );
}

function DeleteConfirmModal({ id, handle, token, onClose, onSuccess }: { id: string; handle: string; token: string; onClose: () => void; onSuccess: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  return (
    <ModalShell title="确认删除" onClose={onClose} maxWidth={400}>
      <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 20 }}>
        确定要删除账号 <strong style={{ color: "#0F172A" }}>{handle}</strong> 吗？所有历史数据将被永久删除。
      </p>
      {err && <div style={{ fontSize: "0.8rem", color: "#dc2626", marginBottom: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-ghost" onClick={onClose} type="button">取消</button>
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            try {
              setSubmitting(true);
              await tiktokApi.deleteAccount(token, id);
              onSuccess();
            } catch (e) {
              setErr((e as Error).message);
              setSubmitting(false);
            }
          }}
          style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: "0.875rem", fontWeight: 600, cursor: "pointer", opacity: submitting ? 0.5 : 1 }}
        >
          {submitting ? "删除中..." : "确认删除"}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, onClose, maxWidth = 480, children }: { title: string; onClose: () => void; maxWidth?: number; children: React.ReactNode }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn 0.18s ease-out" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 16, padding: 24, width: "calc(100% - 32px)", maxWidth, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 50px rgba(15,23,42,0.20)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, marginBottom: 16, borderBottom: "2px solid #2563EB" }}>
          <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "#2563EB", margin: 0, fontSize: "1rem" }}>{title}</h3>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: "#94A3B8", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>{label}</label>
      {children}
    </div>
  );
}
