"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getToken, getRole } from "../lib/auth";
import { tiktokApi, TiktokConfig, TiktokHealth } from "../lib/tiktok";

function useScraperHealth(token: string) {
  const [health, setHealth] = useState<TiktokHealth | null>(null);

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    const tick = async () => {
      try {
        const h = await tiktokApi.getHealth(token);
        if (mounted) setHealth(h);
      } catch {
        if (mounted) setHealth(null);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, [token]);

  return health;
}

export default function TiktokConfigManage() {
  const [config, setConfig] = useState<TiktokConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<"rotate" | "reset" | "confirmReset" | null>(null);

  const token = typeof window !== "undefined" ? getToken() : null;
  const role = typeof window !== "undefined" ? getRole() : null;
  const health = useScraperHealth(token || "");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const c = await tiktokApi.getTiktokConfig(token);
      setConfig(c);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async () => {
    if (!token || !config) return;
    try {
      setSaving(true);
      const updated = await tiktokApi.updateTiktokConfig(token, {
        affiliateOverviewUrl: config.affiliateOverviewUrl,
        scrapeTimeoutMs: config.scrapeTimeoutMs,
        browserPoolSize: config.browserPoolSize,
        defaultIntervalMin: config.defaultIntervalMin,
      });
      setConfig(updated);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async () => {
    if (!token) return;
    try {
      setSaving(true);
      const result = await tiktokApi.rotateCookieKey(token);
      setModal(null);
      await load();
      // 显示一次性明文（简化：仅 toast）
      alert(`密钥已旋转（32 字节），所有账号 Cookie 已失效，需重新上传。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!token) return;
    try {
      setSaving(true);
      await tiktokApi.resetCookieKey(token);
      setModal(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!token || role !== "admin") {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", padding: 40, textAlign: "center" }}>
        您无权访问此配置页面
      </div>
    );
  }

  return (
    <div>
      {/* 服务状态条 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          borderRadius: 8,
          border: `1px solid ${health?.online ? "rgba(16,185,129,0.3)" : health ? "rgba(239,68,68,0.3)" : "#E2E8F0"}`,
          background: health?.online ? "rgba(16,185,129,0.06)" : health ? "rgba(239,68,68,0.06)" : "#F8FAFC",
          marginBottom: 24,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: health?.online ? "#10b981" : health ? "#ef4444" : "#94A3B8",
            boxShadow: `0 0 0 2px ${health?.online ? "rgba(16,185,129,0.25)" : health ? "rgba(239,68,68,0.25)" : "rgba(148,163,184,0.25)"}`,
          }}
        />
        <span style={{ fontSize: "0.8rem", fontWeight: 500, color: health?.online ? "#10b981" : health ? "#ef4444" : "#94A3B8" }}>
          {health?.online
            ? `采集服务在线 · ${health.ageSeconds ?? 0} 秒前`
            : health
              ? "采集服务离线"
              : "采集服务状态未知"}
        </span>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "#ef4444", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Cookie 主密钥 */}
      <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: "0 0 12px" }}>
        Cookie 主密钥
      </h3>
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        {loading || !config ? (
          <div style={{ height: 120, background: "#F1F5F9", borderRadius: 8, animation: "pulse 1.5s infinite" }} />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "6px 0", fontSize: "0.875rem", marginBottom: 16 }}>
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase" }}>状态</span>
              <span style={{ color: "#0F172A", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: config.cookieKey.configured ? "#10b981" : "#94A3B8" }} />
                {config.cookieKey.configured ? "已配置" : "未配置"}
              </span>
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase" }}>字节长度</span>
              <span style={{ color: "#0F172A" }}>{config.cookieKey.byteLength ?? "-"}</span>
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase" }}>最近更新</span>
              <span style={{ color: "#0F172A" }}>{config.cookieKey.updatedAt ? new Date(config.cookieKey.updatedAt).toLocaleString() : "-"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {!config.cookieKey.configured && (
                  <button className="btn-primary" onClick={handleRotate} disabled={saving}>
                    {saving ? "处理中..." : "生成密钥"}
                  </button>
                )}
                {config.cookieKey.configured && (
                  <button className="btn-ghost" onClick={() => setModal("rotate")} disabled={saving}>
                    旋转密钥
                  </button>
                )}
              </div>
              {config.cookieKey.configured && (
                <button className="btn-danger" onClick={() => setModal("reset")} disabled={saving}>
                  重置密钥
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 抓取参数 */}
      <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: "0 0 12px" }}>
        抓取参数
      </h3>
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 20 }}>
        {loading || !config ? (
          <div style={{ height: 160, background: "#F1F5F9", borderRadius: 8, animation: "pulse 1.5s infinite" }} />
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", marginBottom: 6 }}>
                Affiliate URL
              </label>
              <input
                className="input-field"
                value={config.affiliateOverviewUrl}
                onChange={(e) => setConfig({ ...config, affiliateOverviewUrl: e.target.value })}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", marginBottom: 6 }}>
                  抓取超时 (ms)
                </label>
                <input
                  className="input-field"
                  type="number"
                  min={30000}
                  max={300000}
                  value={config.scrapeTimeoutMs}
                  onChange={(e) => setConfig({ ...config, scrapeTimeoutMs: Number(e.target.value) })}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", marginBottom: 6 }}>
                  浏览器池大小
                </label>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  max={20}
                  value={config.browserPoolSize}
                  onChange={(e) => setConfig({ ...config, browserPoolSize: Number(e.target.value) })}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", marginBottom: 6 }}>
                  默认抓取间隔 (min)
                </label>
                <input
                  className="input-field"
                  type="number"
                  min={15}
                  max={1440}
                  value={config.defaultIntervalMin}
                  onChange={(e) => setConfig({ ...config, defaultIntervalMin: Number(e.target.value) })}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn-ghost" onClick={load} type="button" disabled={saving}>
                取消
              </button>
              <button className="btn-primary" onClick={handleSave} disabled={saving} type="button">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* 弹窗 */}
      {modal && createPortal(
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}
        >
          <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, padding: 28, width: "calc(100% - 32px)", maxWidth: 400 }}>
            {modal === "rotate" && (
              <>
                <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#0F172A", margin: "0 0 8px" }}>旋转 Cookie 主密钥</h3>
                <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 20 }}>
                  旋转后所有现有 storage_state 将无法解密，所有非禁用账号将被标记为 Cookie 过期。是否继续？
                </p>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn-ghost" onClick={() => setModal(null)}>取消</button>
                  <button className="btn-primary" onClick={handleRotate} disabled={saving}>{saving ? "处理中..." : "确认旋转"}</button>
                </div>
              </>
            )}
            {modal === "reset" && (
              <>
                <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#ef4444", margin: "0 0 8px" }}>重置 Cookie 主密钥</h3>
                <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 20 }}>
                  这将删除主密钥，所有账号 Cookie 立即失效。此操作不可撤销。确认继续？
                </p>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn-ghost" onClick={() => setModal(null)}>取消</button>
                  <button className="btn-danger" onClick={() => setModal("confirmReset")} disabled={saving}>确认重置</button>
                </div>
              </>
            )}
            {modal === "confirmReset" && (
              <>
                <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1rem", color: "#ef4444", margin: "0 0 8px" }}>最终确认</h3>
                <p style={{ color: "#475569", fontSize: "0.875rem", marginBottom: 16 }}>
                  请输入 <strong>RESET</strong> 以确认删除所有加密 Cookie。
                </p>
                <input className="input-field" placeholder="RESET" id="reset-confirm" style={{ marginBottom: 16, width: "100%" }} />
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn-ghost" onClick={() => setModal(null)}>取消</button>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      const val = (document.getElementById("reset-confirm") as HTMLInputElement)?.value;
                      if (val === "RESET") handleReset();
                    }}
                    disabled={saving}
                  >
                    {saving ? "处理中..." : "确认删除"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
