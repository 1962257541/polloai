"use client";

import { useEffect, useState } from "react";
import ImageChatWindow from "../../../components/ImageChatWindow";
import ImageSessionList from "../../../components/ImageSessionList";
import { api, ImageApiType } from "../../../lib/api";
import { getToken } from "../../../lib/auth";

const SIZE_OPTIONS = [
  { value: "1024x1024", label: "1:1" },
  { value: "1024x1536", label: "2:3" },
  { value: "1536x1024", label: "3:2" },
  { value: "1024x1792", label: "9:16" },
];

const FORMAT_OPTIONS = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

export default function ImagePage() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [imageApiType, setImageApiType] = useState<ImageApiType>("gemini-native");
  const [size, setSize] = useState("1024x1024");
  const [format, setFormat] = useState("png");
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionRefreshTrigger, setSessionRefreshTrigger] = useState(0);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let active = true;
    void (async () => {
      try {
        setConfigLoading(true);
        const info = await api.getMyInfo(token);
        if (!active) return;
        const models = info.imageModels || (info.imageModel ? [info.imageModel] : []);
        setAvailableModels(models);
        setSelectedModel((current) => (current && models.includes(current) ? current : models[0] || ""));
        if (models.length === 0) {
          setConfigError("当前账号未配置可用的文字生图模型，请先到系统设置中配置。");
        }
      } catch (e) {
        if (!active) return;
        setConfigError((e as Error).message);
      } finally {
        if (active) setConfigLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  return (
    <div
      className="page-enter"
      style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px)", minHeight: 0 }}
    >
      {/* 主体：左配置 | 中对话 | 右历史会话 — 撑满剩余高度 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px 1fr 260px",
          gap: 16,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* 左：配置面板 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 20,
            overflowY: "auto",
          }}
        >
          <h2
            style={{
              fontWeight: 600,
              fontSize: "0.9rem",
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            生成配置
          </h2>

          {/* Model */}
          <div>
            <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
              MODEL
            </label>
            <select
              className="input-field"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={configLoading || availableModels.length === 0}
            >
              {availableModels.length === 0 ? (
                <option value="">{configLoading ? "加载模型中..." : "未配置可用模型"}</option>
              ) : (
                availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))
              )}
            </select>
          </div>

          {/* Image API Type */}
          <div>
            <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
              IMAGE API TYPE
            </label>
            <select
              className="input-field"
              value={imageApiType}
              onChange={(e) => setImageApiType(e.target.value as ImageApiType)}
            >
              <option value="gemini-native">Gemini</option>
              <option value="openai-images">OpenAI Images</option>
            </select>
            <p style={{ margin: "6px 0 0", fontSize: "0.72rem", color: "var(--text-muted)" }}>
              参考图/上下文仅在 Gemini 模式生效。
            </p>
          </div>

          {/* Size */}
          <div>
            <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
              SIZE
            </label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSize(opt.value)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 20,
                    border: `1px solid ${size === opt.value ? "var(--accent)" : "var(--border)"}`,
                    background: size === opt.value ? "var(--accent-glow)" : "transparent",
                    color: size === opt.value ? "var(--accent)" : "var(--text-secondary)",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.15s",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Format */}
          <div>
            <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
              FORMAT
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFormat(opt.value)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 20,
                    border: `1px solid ${format === opt.value ? "var(--accent)" : "var(--border)"}`,
                    background: format === opt.value ? "var(--accent-glow)" : "transparent",
                    color: format === opt.value ? "var(--accent)" : "var(--text-secondary)",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.15s",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {configError && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.78rem", color: "var(--error)" }}>
              {configError}
            </div>
          )}

          {/* 使用说明 */}
          <div
            style={{
              marginTop: "auto",
              padding: "12px",
              background: "var(--bg-raised)",
              borderRadius: 8,
              fontSize: "0.72rem",
              color: "var(--text-muted)",
              lineHeight: 1.7,
            }}
          >
            <strong style={{ color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>使用提示</strong>
            • Enter 发送，Shift+Enter 换行<br />
            • Ctrl+V 在输入框内粘贴参考图<br />
            • 勾选"自动引用上轮图片"实现连续编辑<br />
            • 生成图片自动保存到素材库（24h）
          </div>
        </div>

        {/* 中：对话窗口 */}
        <ImageChatWindow
          availableModels={availableModels}
          selectedModel={selectedModel}
          size={size}
          outputFormat={format}
          imageApiType={imageApiType}
          sessionId={currentSessionId}
          onSessionCreated={(id) => {
            setCurrentSessionId(id);
            setSessionRefreshTrigger((n) => n + 1);
          }}
        />

        {/* 右：历史会话列表 */}
        <ImageSessionList
          currentSessionId={currentSessionId}
          onSelectSession={(id) => setCurrentSessionId(id)}
          onNewSession={() => setCurrentSessionId(null)}
          refreshTrigger={sessionRefreshTrigger}
        />
      </div>
    </div>
  );
}
