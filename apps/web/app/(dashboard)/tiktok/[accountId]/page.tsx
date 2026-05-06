"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { createPortal } from "react-dom";
import { getToken } from "../../../../lib/auth";
import { tiktokApi, TiktokAccountDetail, TiktokVideo, TiktokVideoMetric } from "../../../../lib/tiktok";

const STATUS_LABEL: Record<string, { label: string; bg: string; color: string; border: string }> = {
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

export default function TiktokDetailPage() {
  const router = useRouter();
  const params = useParams();
  const accountId = params.accountId as string;

  const [account, setAccount] = useState<TiktokAccountDetail | null>(null);
  const [videos, setVideos] = useState<TiktokVideo[]>([]);
  const [metrics, setMetrics] = useState<TiktokVideoMetric[] | null>(null);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"publishedAt" | "playCount" | "gmv" | "orderCount">("publishedAt");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<"upload" | "interval" | "delete" | null>(null);
  const [newInterval, setNewInterval] = useState(60);
  const [submitting, setSubmitting] = useState(false);

  const token = typeof window !== "undefined" ? getToken() : null;

  const load = useCallback(async () => {
    if (!token || !accountId) return;
    try {
      setLoading(true);
      const [acc, vids] = await Promise.all([
        tiktokApi.getAccount(token, accountId),
        tiktokApi.listVideos(token, accountId, sortBy),
      ]);
      setAccount(acc);
      setVideos(vids);
      setNewInterval(acc.scrapeIntervalMin);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, accountId, sortBy]);

  useEffect(() => { void load(); }, [load]);

  const handleRefresh = async () => {
    if (!token) return;
    try {
      setRefreshing(true);
      await tiktokApi.refreshAccount(token, accountId);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async () => {
    if (!token) return;
    try {
      setSubmitting(true);
      await tiktokApi.deleteAccount(token, accountId);
      router.push("/tiktok");
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  const handleUpdateInterval = async () => {
    if (!token || !account) return;
    try {
      setSubmitting(true);
      await tiktokApi.updateAccount(token, accountId, { scrapeIntervalMin: newInterval });
      setModal(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleExpand = async (videoId: string) => {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setMetrics(null);
      return;
    }
    setExpandedVideoId(videoId);
    if (token) {
      try {
        const m = await tiktokApi.listVideoMetrics(token, accountId, videoId, 7);
        setMetrics(m);
      } catch {
        setMetrics([]);
      }
    }
  };

  const st = account ? STATUS_LABEL[account.status] : null;

  return (
    <div className="page-enter">
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => router.push("/tiktok")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: "0.875rem", display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          返回列表
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1.2rem", color: "#0F172A", margin: 0 }}>
            {account?.handle ?? "..."}
          </h1>
          {st && (
            <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 500, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
              {st.label}
            </span>
          )}
        </div>
        {account?.nickname && <div style={{ fontSize: "0.8rem", color: "#94A3B8", marginTop: 2 }}>{account.nickname}</div>}
        <div style={{ fontSize: "0.7rem", color: "#94A3B8", marginTop: 4 }}>
          最近抓取：{timeAgo(account?.lastScrapedAt ?? null)}
        </div>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "#ef4444", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {account && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
            {[
              { label: "粉丝", value: formatNumber(account.followerCount) },
              { label: "视频", value: formatNumber(account.videoCount) },
              { label: "累计 GMV", value: formatCents(account.totalGmvCents) },
              { label: "订单", value: formatNumber(account.totalOrders) },
              { label: "佣金", value: formatCents(account.totalCommissionCents) },
            ].map((s, i) => (
              <div
                key={s.label}
                style={{
                  background: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: 12,
                  padding: "16px 20px",
                  borderLeft: i === 0 ? "3px solid #2563EB" : undefined,
                }}
              >
                <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#0F172A" }}>{s.value}</div>
                <div style={{ fontSize: "0.65rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? "⟳ 刷新中..." : "↻ 立即刷新"}
              </button>
              <button className="btn-ghost" onClick={() => setModal("upload")}>
                ⇧ 上传 Cookie
              </button>
              <button className="btn-ghost" onClick={() => setModal("interval")}>
                ⏱ {account.scrapeIntervalMin}min
              </button>
            </div>
            <button className="btn-danger" onClick={() => setModal("delete")}>🗑 删除账号</button>
          </div>
        </>
      )}

      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "56px 2fr 100px 90px 80px 70px 70px 80px 32px",
            padding: "10px 16px",
            borderBottom: "1px solid #E2E8F0",
            fontSize: "0.65rem",
            fontWeight: 600,
            color: "#94A3B8",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background: "#F8FAFC",
          }}
        >
          <span>封面</span>
          <span>标题</span>
          <span>发布时间</span>
          <SortHeader label="播放" active={sortBy === "playCount"} onClick={() => setSortBy("playCount")} />
          <span>点赞</span>
          <span>评论</span>
          <SortHeader label="GMV" active={sortBy === "gmv"} onClick={() => setSortBy("gmv")} />
          <SortHeader label="订单" active={sortBy === "orderCount"} onClick={() => setSortBy("orderCount")} />
          <span />
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#94A3B8" }}>加载中...</div>
        ) : videos.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#94A3B8" }}>暂无视频数据</div>
        ) : (
          videos.map((v) => (
            <div key={v.id}>
              <div
                onClick={() => toggleExpand(v.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px 2fr 100px 90px 80px 70px 70px 80px 32px",
                  padding: "10px 16px",
                  borderBottom: "1px solid #E2E8F0",
                  fontSize: "0.8rem",
                  alignItems: "center",
                  cursor: "pointer",
                  background: expandedVideoId === v.id ? "#F8FAFC" : "transparent",
                  borderLeft: expandedVideoId === v.id ? "2px solid #2563EB" : "2px solid transparent",
                }}
                onMouseEnter={(e) => { if (expandedVideoId !== v.id) e.currentTarget.style.background = "#F8FAFC"; }}
                onMouseLeave={(e) => { if (expandedVideoId !== v.id) e.currentTarget.style.background = "transparent"; }}
              >
                <img src={v.coverUrl || "/placeholder.png"} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover" }} />
                <span style={{ color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title || "-"}</span>
                <span style={{ color: "#94A3B8" }}>{v.publishedAt ? timeAgo(v.publishedAt) : "-"}</span>
                <span style={{ color: "#0F172A", fontWeight: 600 }}>{formatNumber(v.playCount)}</span>
                <span style={{ color: "#475569" }}>{formatNumber(v.likeCount)}</span>
                <span style={{ color: "#475569" }}>{formatNumber(v.commentCount)}</span>
                <span style={{ color: "#0F172A", fontWeight: 600 }}>{formatCents(v.gmvCents)}</span>
                <span style={{ color: "#475569" }}>{formatNumber(v.orderCount)}</span>
                <span style={{ color: "#94A3B8" }}>{expandedVideoId === v.id ? "▾" : "▸"}</span>
              </div>

              {expandedVideoId === v.id && metrics !== null && (
                <div style={{ background: "#F1F5F9", padding: 24, borderBottom: "1px solid #E2E8F0" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#0F172A", marginBottom: 12 }}>播放量趋势 (近 7 天)</div>
                  {metrics.length === 0 ? (
                    <div style={{ color: "#94A3B8", fontSize: "0.8rem" }}>暂无趋势数据</div>
                  ) : (
                    <SimpleLineChart data={metrics} />
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {modal && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          {modal === "upload" && (
            <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 440 }}>
              <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#0F172A", margin: "0 0 8px" }}>
                上传 Cookie — {account?.handle}
              </h3>
              <p style={{ color: "#475569", fontSize: "0.8rem", marginBottom: 16 }}>选择 Playwright storage_state JSON 文件</p>
              <UploadCookieForm accountId={accountId} token={token!} onSuccess={() => { setModal(null); setError(""); }} onClose={() => setModal(null)} />
            </div>
          )}

          {modal === "interval" && (
            <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 360 }}>
              <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#0F172A", margin: "0 0 16px" }}>修改抓取间隔</h3>
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6, textTransform: "uppercase", fontWeight: 600 }}>
                  间隔 (分钟，15–1440)
                </label>
                <input className="input-field" type="number" min={15} max={1440} value={newInterval} onChange={(e) => setNewInterval(Number(e.target.value))} style={{ width: "100%" }} />
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn-ghost" onClick={() => setModal(null)}>取消</button>
                <button className="btn-primary" onClick={handleUpdateInterval} disabled={submitting}>
                  {submitting ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}

          {modal === "delete" && (
            <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 400 }}>
              <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#ef4444", margin: "0 0 8px" }}>确认删除</h3>
              <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 20 }}>
                确定要删除账号 <strong style={{ color: "#0F172A" }}>{account?.handle}</strong> 吗？所有历史数据将被永久删除。
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn-ghost" onClick={() => setModal(null)} type="button">取消</button>
                <button type="button" disabled={submitting} onClick={handleDelete}
                  style={{ background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: "0.875rem", cursor: "pointer", opacity: submitting ? 0.5 : 1 }}
                >
                  {submitting ? "删除中..." : "确认删除"}
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function SortHeader({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{ cursor: "pointer", color: active ? "#2563EB" : "#94A3B8", display: "flex", alignItems: "center", gap: 4 }}
    >
      {label}
      {active && <span>▼</span>}
    </span>
  );
}

function SimpleLineChart({ data }: { data: TiktokVideoMetric[] }) {
  const values = data.map((d) => Number(d.playCount));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const w = 600;
  const h = 160;
  const pad = 20;
  const pts = data.map((_d, i) => {
    const x = pad + (i / (data.length - 1 || 1)) * (w - pad * 2);
    const y = h - pad - ((Number(values[i]) - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible" }}>
      <polyline fill="none" stroke="#2563EB" strokeWidth="2" points={pts} />
      {data.map((_d, i) => {
        const x = pad + (i / (data.length - 1 || 1)) * (w - pad * 2);
        const y = h - pad - ((Number(values[i]) - min) / range) * (h - pad * 2);
        return <circle key={i} cx={x} cy={y} r="3" fill="#2563EB" />;
      })}
    </svg>
  );
}

function UploadCookieForm({ accountId, token, onSuccess, onClose }: {
  accountId: string;
  token: string;
  onSuccess: () => void;
  onClose: () => void;
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
    <>
      <input type="file" accept=".json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ marginBottom: 16, width: "100%" }} />
      {err && <div style={{ fontSize: "0.8rem", color: "#ef4444", marginBottom: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button className="btn-primary" onClick={handleUpload} disabled={uploading || !file}>{uploading ? "上传中..." : "上传"}</button>
      </div>
    </>
  );
}
