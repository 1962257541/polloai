"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { getToken } from "../../../../lib/auth";
import {
  tiktokApi,
  TiktokAccountDetail,
  TiktokAccountStatus,
  TiktokVideo,
  TiktokRecentStats,
} from "../../../../lib/tiktok";

const STATUS_LABEL: Record<TiktokAccountStatus, { label: string; bg: string; color: string; border: string }> = {
  active: { label: "正常", bg: "rgba(16,185,129,0.1)", color: "#10b981", border: "rgba(16,185,129,0.2)" },
  not_found: { label: "未找到", bg: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "rgba(245,158,11,0.25)" },
  rate_limited: { label: "反爬限流", bg: "rgba(249,115,22,0.1)", color: "#f97316", border: "rgba(249,115,22,0.25)" },
  error: { label: "异常", bg: "rgba(239,68,68,0.1)", color: "#ef4444", border: "rgba(239,68,68,0.2)" },
  disabled: { label: "已停用", bg: "#F1F5F9", color: "#94A3B8", border: "#E2E8F0" },
};

function formatNumber(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "0";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(Math.round(v));
}

function formatPublishedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
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

export default function TiktokDetailPage() {
  const router = useRouter();
  const params = useParams();
  const accountId = params.accountId as string;

  const [account, setAccount] = useState<TiktokAccountDetail | null>(null);
  const [videos, setVideos] = useState<TiktokVideo[]>([]);
  const [stats, setStats] = useState<TiktokRecentStats | null>(null);
  const [sortBy, setSortBy] = useState<"publishedAt" | "playCount">("publishedAt");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const token = mounted ? getToken() : null;

  const load = useCallback(async () => {
    if (!token || !accountId) return;
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
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, accountId, sortBy]);

  useEffect(() => { void load(); }, [load]);

  const handleRefresh = async () => {
    if (!token || refreshing) return;
    const beforeTs = account?.lastScrapedAt ? new Date(account.lastScrapedAt).getTime() : 0;
    setRefreshing(true);
    setError("");
    try {
      await tiktokApi.refreshAccount(token, accountId);
    } catch (e) {
      setError((e as Error).message);
      setRefreshing(false);
      return;
    }
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const acc = await tiktokApi.getAccount(token, accountId);
        const ts = acc.lastScrapedAt ? new Date(acc.lastScrapedAt).getTime() : 0;
        if (ts > beforeTs) {
          await load();
          setRefreshing(false);
          return;
        }
      } catch {
        // continue
      }
    }
    setError("采集超时（>120s），TikTok 反爬限流中，稍后再试");
    setRefreshing(false);
  };

  const handleDelete = async () => {
    if (!token) return;
    if (!confirm(`删除 ${account?.handle ?? account?.uid}？`)) return;
    try {
      await tiktokApi.deleteAccount(token, accountId);
      router.push("/tiktok");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (loading && !account) {
    return <div style={{ padding: 60, textAlign: "center", color: "#94A3B8" }}>加载中...</div>;
  }
  if (!account) {
    return <div style={{ padding: 60, textAlign: "center", color: "#94A3B8" }}>账号不存在</div>;
  }

  const st = STATUS_LABEL[account.status];

  return (
    <div className="page-enter">
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => router.push("/tiktok")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: "0.875rem", display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          返回列表
        </button>

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {account.avatarUrl ? (
            <img src={account.avatarUrl} alt="" style={{ width: 80, height: 80, borderRadius: 16, objectFit: "cover" }} />
          ) : (
            <div style={{ width: 80, height: 80, borderRadius: 16, background: "#F1F5F9" }} />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <h1 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1.3rem", color: "#0F172A", margin: 0 }}>
                {account.nickname || account.handle || account.uid}
              </h1>
              <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", fontWeight: 500, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>{st.label}</span>
              {account.salesTag && (
                <span style={{ padding: "2px 8px", borderRadius: 9999, fontSize: "0.7rem", background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>{account.salesTag}</span>
              )}
            </div>
            <div style={{ fontSize: "0.85rem", color: "#475569", marginTop: 4 }}>
              {account.handle || ""}
              {account.uid && <span style={{ marginLeft: 8, color: "#94A3B8" }}>UID: {account.uid}</span>}
            </div>
            {account.bioSignature && (
              <div style={{ fontSize: "0.8rem", color: "#64748B", marginTop: 6, whiteSpace: "pre-wrap" }}>{account.bioSignature}</div>
            )}
            <div style={{ fontSize: "0.7rem", color: "#94A3B8", marginTop: 6 }}>
              地区: <strong style={{ color: "#475569" }}>{account.region || "—"}</strong>
              <span style={{ marginLeft: 16 }}>分类: <strong style={{ color: "#475569" }}>{account.category || "—"}</strong></span>
              {account.note && <span style={{ marginLeft: 16 }}>备注: <strong style={{ color: "#475569" }}>{account.note}</strong></span>}
            </div>
            <div style={{ fontSize: "0.7rem", color: "#94A3B8", marginTop: 4 }}>
              最近抓取：{formatRelativeTime(account.lastScrapedAt)}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "#ef4444", marginBottom: 16 }}>
          {error}
        </div>
      )}
      {account.status === "rate_limited" && (
        <div style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "#9a3412", marginBottom: 16 }}>
          TikTok 反爬限流：{account.lastErrorMessage || "稍等几分钟后重试"}
        </div>
      )}

      {/* 顶部摘要 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr) 2fr", gap: 12, marginBottom: 20 }}>
        {[
          { label: "粉丝", value: formatNumber(account.followerCount) },
          { label: "关注", value: formatNumber(account.followingCount) },
          { label: "总点赞", value: formatNumber(account.heartCount) },
          { label: "作品总数", value: formatNumber(account.videoCount) },
        ].map((s) => (
          <div key={s.label} style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px 18px" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#0F172A" }}>{s.value}</div>
            <div style={{ fontSize: "0.65rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
          </div>
        ))}
        <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px 18px" }}>
          <div style={{ fontSize: "0.7rem", color: "#94A3B8", marginBottom: 6 }}>过去 15 天数据</div>
          {stats ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, fontSize: "0.85rem" }}>
              <div><div style={{ color: "#94A3B8", fontSize: "0.65rem" }}>视频</div><strong>{stats.videoCount}</strong></div>
              <div><div style={{ color: "#94A3B8", fontSize: "0.65rem" }}>总播放</div><strong>{formatNumber(stats.totalPlay)}</strong></div>
              <div><div style={{ color: "#94A3B8", fontSize: "0.65rem" }}>播粉比</div><strong>{stats.playFollowerRatio.toFixed(2)}</strong></div>
              <div><div style={{ color: "#94A3B8", fontSize: "0.65rem" }}>均播</div><strong>{formatNumber(stats.avgPlay)}</strong></div>
              <div><div style={{ color: "#94A3B8", fontSize: "0.65rem" }}>日均</div><strong>{stats.postsPerDay.toFixed(2)}</strong></div>
            </div>
          ) : <div style={{ color: "#94A3B8" }}>—</div>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
        <button className="btn-ghost" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "采集中..." : "↻ 立即刷新"}
        </button>
        {refreshing && <span style={{ fontSize: "0.75rem", color: "#94A3B8" }}>30–90 秒，请勿重复点击</span>}
        <div style={{ flex: 1 }} />
        <button className="btn-danger" onClick={handleDelete} disabled={refreshing}>🗑 删除</button>
      </div>

      {/* 视频表 */}
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, overflow: "hidden" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "56px 2fr 110px 80px 80px 80px 80px",
          padding: "10px 16px",
          borderBottom: "1px solid #E2E8F0",
          fontSize: "0.65rem",
          fontWeight: 600,
          color: "#94A3B8",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          background: "#F8FAFC",
        }}>
          <span>封面</span>
          <span>标题</span>
          <span>时长</span>
          <SortHeader label="发布" active={sortBy === "publishedAt"} onClick={() => setSortBy("publishedAt")} />
          <SortHeader label="播放" active={sortBy === "playCount"} onClick={() => setSortBy("playCount")} />
          <span>点赞</span>
          <span>评论</span>
        </div>

        {videos.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#94A3B8", fontSize: "0.85rem" }}>
            {account.videoCount > 0
              ? `账号有 ${account.videoCount} 个视频，但 TikTok 视频列表 API 暂未返回数据，点击"立即刷新"重试`
              : "暂无视频"}
          </div>
        ) : (
          videos.map((v) => (
            <a
              key={v.id}
              href={v.videoUrl || (account.handle ? `https://www.tiktok.com/${account.handle}/video/${v.videoId}` : "#")}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "grid",
                gridTemplateColumns: "56px 2fr 110px 80px 80px 80px 80px",
                padding: "10px 16px",
                borderBottom: "1px solid #E2E8F0",
                fontSize: "0.8rem",
                alignItems: "center",
                textDecoration: "none",
                color: "inherit",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#F8FAFC"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {v.coverUrl ? (
                <img src={v.coverUrl} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "cover" }} />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 6, background: "#F1F5F9" }} />
              )}
              <span style={{ color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title || "—"}</span>
              <span style={{ color: "#475569" }}>{formatDuration(v.durationMs)}</span>
              <span style={{ color: "#94A3B8" }}>{formatPublishedAt(v.publishedAt)}</span>
              <span style={{ color: "#0F172A", fontWeight: 600 }}>{formatNumber(v.playCount)}</span>
              <span style={{ color: "#475569" }}>{formatNumber(v.likeCount)}</span>
              <span style={{ color: "#475569" }}>{formatNumber(v.commentCount)}</span>
            </a>
          ))
        )}
      </div>
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
