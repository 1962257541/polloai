"use client";

import { useEffect, useRef, useState } from "react";
import { api, ImageApiType } from "../lib/api";
import { getToken } from "../lib/auth";

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

interface ImageGeneratorProps {
  onCreated: () => void;
  generating?: boolean;
  /** 预填的参考图 URL（上下文模式下传入上轮输出图片） */
  contextImageUrl?: string;
  onContextImageUrlConsumed?: () => void;
}

export default function ImageGenerator({
  onCreated,
  generating = false,
  contextImageUrl,
  onContextImageUrlConsumed,
}: ImageGeneratorProps) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [format, setFormat] = useState("png");
  const [imageApiType, setImageApiType] = useState<ImageApiType>("gemini-native");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 同步预览 URL
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  // Ctrl+V 粘贴图片追加到参考图列表
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []).filter((i) =>
        i.type.startsWith("image/"),
      );
      if (items.length === 0) return;
      const pasted = items
        .map((i) => i.getAsFile())
        .filter((f): f is File => Boolean(f));
      if (pasted.length > 0) {
        setFiles((prev) => [...prev, ...pasted].slice(0, 9));
        setError("");
      }
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, []);

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
          setError("当前账号未配置可用的文字生图模型，请先到系统设置中配置。");
        }
      } catch (e) {
        if (!active) return;
        setError((e as Error).message);
      } finally {
        if (active) setConfigLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  const addFiles = (newFiles: File[]) => {
    const valid = newFiles.filter((f) =>
      ["image/png", "image/jpeg", "image/webp"].includes(f.type),
    );
    if (valid.length < newFiles.length) {
      setError("仅支持 PNG、JPEG 或 WebP 参考图。");
    } else {
      setError("");
    }
    setFiles((prev) => [...prev, ...valid].slice(0, 9));
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    const token = getToken();
    if (!token) return;

    if (!selectedModel) {
      setError("请先选择一个文字生图模型。");
      return;
    }

    if (files.length > 0 && imageApiType !== "gemini-native") {
      setError("参考图当前仅支持 Gemini 模式，请切换图片接口类型。");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await api.createImage(
        token,
        {
          prompt: prompt.trim(),
          model: selectedModel,
          size,
          outputFormat: format,
          imageApiType,
        },
        files.length > 0 ? files : undefined,
      );
      onCreated();
      onContextImageUrlConsumed?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <h2
        style={{
          fontFamily: "Syne, sans-serif",
          fontWeight: 700,
          fontSize: "1rem",
          color: "var(--text-primary)",
          margin: 0,
        }}
      >
        文字生图
      </h2>

      {/* Prompt */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          PROMPT
        </label>
        <textarea
          className="input-field"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想要生成的图片..."
          rows={5}
          style={{ resize: "vertical", minHeight: 120 }}
        />
      </div>

      {/* Model */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
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
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          IMAGE API TYPE
        </label>
        <select className="input-field" value={imageApiType} onChange={(e) => setImageApiType(e.target.value as ImageApiType)}>
          <option value="gemini-native">Gemini</option>
          <option value="openai-images">OpenAI Images</option>
        </select>
        <p style={{ margin: "8px 0 0", fontSize: "0.75rem", color: "var(--text-muted)" }}>
          参考图当前仅在 Gemini 模式下生效。
        </p>
      </div>

      {/* Reference Images */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <label style={{ fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em" }}>
            REFERENCE IMAGES {files.length > 0 ? `(${files.length}/9)` : ""}
          </label>
          {files.length > 0 && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setFiles([])}
              style={{ fontSize: "0.72rem", padding: "3px 8px" }}
            >
              清空全部
            </button>
          )}
        </div>

        {/* 已选图片列表 */}
        {files.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
              gap: 8,
              marginBottom: 10,
            }}
          >
            {files.map((f, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  borderRadius: 6,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  background: "var(--bg-raised)",
                  paddingBottom: "100%",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrls[i]}
                  alt={f.name}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  style={{
                    position: "absolute",
                    top: 3,
                    right: 3,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "rgba(0,0,0,0.6)",
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.65rem",
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
        )}

        {/* 上传区域 */}
        {files.length < 9 && (
          <label
            style={{
              display: "block",
              width: "100%",
              border: "1px dashed var(--border)",
              borderRadius: 8,
              padding: "14px 12px",
              textAlign: "center",
              cursor: "pointer",
              position: "relative",
              background: "transparent",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                if (selected.length > 0) addFiles(selected);
                e.target.value = "";
              }}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
            />
            <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
              点击上传或 Ctrl+V 粘贴参考图（可选，最多 9 张）
            </span>
          </label>
        )}

        {/* 上下文提示 */}
        {contextImageUrl && (
          <div style={{ marginTop: 8, fontSize: "0.75rem", color: "var(--accent)", display: "flex", alignItems: "center", gap: 6 }}>
            <span>已自动引用上轮图片作为参考</span>
          </div>
        )}
      </div>

      {/* Size */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          SIZE
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {SIZE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSize(opt.value)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${size === opt.value ? "var(--accent)" : "var(--border)"}`,
                background: size === opt.value ? "var(--accent-glow)" : "transparent",
                color: size === opt.value ? "var(--accent)" : "var(--text-secondary)",
                fontSize: "0.8rem",
                cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
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
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          FORMAT
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFormat(opt.value)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${format === opt.value ? "var(--accent)" : "var(--border)"}`,
                background: format === opt.value ? "var(--accent-glow)" : "transparent",
                color: format === opt.value ? "var(--accent)" : "var(--text-secondary)",
                fontSize: "0.8rem",
                cursor: "pointer",
                fontFamily: "JetBrains Mono, monospace",
                transition: "all 0.15s",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)" }}>
          {error}
        </div>
      )}

      <button
        className="btn-primary"
        type="submit"
        disabled={loading || generating || !prompt.trim() || !selectedModel}
        style={{ width: "100%" }}
      >
        {loading ? "提交中..." : generating ? "生成中..." : "生成图片"}
      </button>
    </form>
  );
}
