"use client";

import { CSSProperties, useCallback, useEffect, useState } from "react";
import { api, VolcConfigUpdate, VolcConfigView } from "../lib/api";
import { getToken } from "../lib/auth";

const TOOL_VERSION_OPTIONS = [
  { value: "standard", label: "标准版 (standard)" },
  { value: "professional", label: "专业版 (professional)" },
];
// 空值 = 使用原始分辨率（不传 resolution）
const RESOLUTION_OPTIONS = [
  { value: "", label: "原始分辨率" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "2k", label: "2k" },
  { value: "4k", label: "4k" },
];

const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: "0.8rem",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  color: "var(--text-muted)",
  marginBottom: 6,
  letterSpacing: "0.05em",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 700,
  color: "var(--text-secondary)",
  letterSpacing: "0.08em",
  margin: "0 0 14px",
};

type FormState = {
  host: string;
  toolVersion: string;
  resolution: string;
};

const EMPTY_FORM: FormState = {
  host: "",
  toolVersion: "standard",
  resolution: "",
};

export default function VolcEnhanceConfig() {
  const [view, setView] = useState<VolcConfigView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      setLoading(true);
      setError("");
      const data = await api.getVolcConfig(token);
      setView(data);
      setForm({
        host: data.host,
        toolVersion: data.toolVersion || "standard",
        resolution: data.resolution,
      });
      setApiKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSuccess("");
  };

  const handleSave = async () => {
    const token = getToken();
    if (!token) return;
    try {
      setSaving(true);
      setError("");
      setSuccess("");
      const payload: VolcConfigUpdate = { ...form };
      // API Key 留空 = 保持不变
      if (apiKey.trim()) payload.apiKey = apiKey.trim();

      const data = await api.updateVolcConfig(token, payload);
      setView(data);
      setApiKey("");
      setSuccess("配置已保存，立即生效（无需重启 worker）");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        加载中...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: 0 }}>
          画质提升（火山引擎 AI MediaKit）
        </h3>
        <span
          style={{
            fontSize: "0.7rem",
            padding: "3px 10px",
            borderRadius: 999,
            background: view?.configured ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.1)",
            color: view?.configured ? "var(--success, #22c55e)" : "var(--error)",
            border: `1px solid ${view?.configured ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.2)"}`,
          }}
        >
          {view?.configured ? "已配置" : "未配置 API Key"}
        </span>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginTop: 0, marginBottom: 24, lineHeight: 1.6 }}>
        视频「画质提升 / 超分」走火山引擎 AI MediaKit 画质增强 API（Bearer Token 鉴权，平台级统一计费，对所有账号生效）。
        保存后立即生效，无需重启 worker；留空数据库则回退环境变量默认值。
      </p>

      {/* 凭证 */}
      <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <h4 style={sectionTitleStyle}>访问凭证</h4>
        <div>
          <label style={labelStyle}>MediaKit API Key（Bearer Token）</label>
          <input
            type="password"
            style={inputStyle}
            value={apiKey}
            placeholder={view?.hasApiKey ? `已配置 ${view.apiKey}（留空不修改）` : "未配置，请填入 Bearer Token"}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSuccess("");
            }}
          />
        </div>
      </section>

      {/* 增强参数 */}
      <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <h4 style={sectionTitleStyle}>增强参数</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>工具版本 (tool_version)</label>
            <select style={inputStyle} value={form.toolVersion} onChange={(e) => setField("toolVersion", e.target.value)}>
              {TOOL_VERSION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>默认目标分辨率</label>
            <select style={inputStyle} value={form.resolution} onChange={(e) => setField("resolution", e.target.value)}>
              {RESOLUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
          默认分辨率仅在任务未指定时生效；用户在「画质提升」弹窗里选定的分辨率优先。
        </p>
      </section>

      {/* 接口参数（高级） */}
      <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}>
        <h4 style={sectionTitleStyle}>接口参数（高级）</h4>
        <div>
          <label style={labelStyle}>API Host</label>
          <input
            style={inputStyle}
            value={form.host}
            placeholder="mediakit.cn-beijing.volces.com"
            onChange={(e) => setField("host", e.target.value)}
          />
        </div>
      </section>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)", marginBottom: 16 }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "var(--success, #22c55e)", marginBottom: 16 }}>
          {success}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button className="btn-ghost" type="button" onClick={() => void load()} disabled={saving}>
          重置
        </button>
        <button className="btn-primary" type="button" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
