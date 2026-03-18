"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { getToken } from "../lib/auth";

const SIZE_OPTIONS = [
  { value: "1024x1024", label: "1:1" },
  { value: "1024x1536", label: "2:3" },
  { value: "1536x1024", label: "3:2" },
];

const FORMAT_OPTIONS = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

interface ImageGeneratorProps {
  onCreated: () => void;
  generating?: boolean;
}

export default function ImageGenerator({ onCreated, generating = false }: ImageGeneratorProps) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [format, setFormat] = useState("png");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    const token = getToken();
    if (!token) return;

    try {
      setLoading(true);
      setError("");
      await api.createImage(token, { prompt: prompt.trim(), size, outputFormat: format });
      onCreated();
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

      {/* 尺寸选择 */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          SIZE
        </label>
        <div style={{ display: "flex", gap: 8 }}>
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

      {/* 格式选择 */}
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
        disabled={loading || generating || !prompt.trim()}
        style={{ width: "100%" }}
      >
        {loading ? "提交中..." : generating ? "生成中..." : "生成图片"}
      </button>
    </form>
  );
}
