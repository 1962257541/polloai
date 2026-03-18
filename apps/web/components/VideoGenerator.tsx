"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { getToken } from "../lib/auth";

const DURATION_OPTIONS = [
  { value: 4, label: "4s" },
  { value: 6, label: "6s" },
  { value: 8, label: "8s" },
];

const SIZE_OPTIONS = [
  { value: "1280x720", label: "16:9" },
  { value: "720x1280", label: "9:16" },
];

interface VideoGeneratorProps {
  onCreated: () => void;
  generating?: boolean;
}

export default function VideoGenerator({ onCreated, generating = false }: VideoGeneratorProps) {
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [size, setSize] = useState("1280x720");
  const [duration, setDuration] = useState(4);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = Boolean(imageUrl || file);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !canSubmit) return;

    const token = getToken();
    if (!token) return;

    try {
      setLoading(true);
      setError("");
      await api.createVideoFromImage(
        token,
        { prompt: prompt.trim(), imageUrl: imageUrl || undefined, size, durationSec: duration },
        file,
      );
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
        图生视频
      </h2>

      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          PROMPT
        </label>
        <textarea
          className="input-field"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述视频运动效果..."
          rows={3}
          style={{ resize: "vertical", minHeight: 80 }}
        />
      </div>

      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          INPUT IMAGE
        </label>
        <input
          className="input-field"
          type="url"
          value={imageUrl}
          onChange={(e) => { setImageUrl(e.target.value); if (e.target.value) setFile(undefined); }}
          placeholder="图片 URL（与上传文件二选一）"
          style={{ marginBottom: 8 }}
        />
        <div
          style={{
            border: `1px dashed ${file ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 6,
            padding: "12px",
            textAlign: "center",
            cursor: "pointer",
            position: "relative",
            transition: "border-color 0.15s",
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { setFile(e.target.files?.[0]); if (e.target.files?.[0]) setImageUrl(""); }}
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
          />
          <span style={{ fontSize: "0.8rem", color: file ? "var(--accent)" : "var(--text-muted)" }}>
            {file ? file.name : "点击或拖入图片文件"}
          </span>
        </div>
      </div>

      {/* 比例 */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          ASPECT RATIO
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

      {/* 时长 */}
      <div>
        <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          DURATION
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDuration(opt.value)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: `1px solid ${duration === opt.value ? "var(--accent)" : "var(--border)"}`,
                background: duration === opt.value ? "var(--accent-glow)" : "transparent",
                color: duration === opt.value ? "var(--accent)" : "var(--text-secondary)",
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
        disabled={loading || generating || !prompt.trim() || !canSubmit}
        style={{ width: "100%" }}
      >
        {loading ? "提交中..." : generating ? "生成中..." : "生成视频"}
      </button>
    </form>
  );
}
