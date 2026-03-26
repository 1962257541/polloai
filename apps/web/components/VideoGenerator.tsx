"use client";

import { useEffect, useState } from "react";
import MaterialLibraryModal from "./MaterialLibraryModal";
import { api, Material } from "../lib/api";
import { getToken } from "../lib/auth";

const DURATION_OPTIONS = [
  { value: 4, label: "4s" },
  { value: 6, label: "6s" },
  { value: 8, label: "8s" },
];

const SIZE_OPTIONS = [
  { value: "1280x720", label: "16:9", aspectRatio: "16:9" as const },
  { value: "720x1280", label: "9:16", aspectRatio: "9:16" as const },
];

type AspectRatioValue = "16:9" | "9:16";
type GeneratorTab = "single" | "batch";

interface VideoGeneratorProps {
  onCreated: () => void;
}

function sizeToAspectRatio(size: string) {
  return SIZE_OPTIONS.find((item) => item.value === size)?.aspectRatio || "16:9";
}

export default function VideoGenerator({ onCreated }: VideoGeneratorProps) {
  const [activeTab, setActiveTab] = useState<GeneratorTab>("single");

  // 单个生成状态
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [size, setSize] = useState("1280x720");
  const [duration, setDuration] = useState(4);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 批量生成状态
  const [batchPrompt, setBatchPrompt] = useState("");
  const [batchMaterials, setBatchMaterials] = useState<Material[]>([]);
  const [batchSize, setBatchSize] = useState("1280x720");
  const [batchDuration, setBatchDuration] = useState(4);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState("");
  const [batchError, setBatchError] = useState("");
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  // 素材库弹窗
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryMode, setLibraryMode] = useState<"single" | "batch">("single");

  const canSubmit = Boolean(imageUrl.trim() || selectedMaterial);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let active = true;
    void (async () => {
      try {
        setConfigLoading(true);
        const info = await api.getMyInfo(token);
        if (!active) return;
        const models = info.videoModels || (info.videoModel ? [info.videoModel] : []);
        setAvailableModels(models);
        setSelectedModel((current) => (current && models.includes(current) ? current : models[0] || ""));
        if (models.length === 0) {
          setError("当前账号未配置可用的图生视频模型，请先到系统设置中配置。");
        }
      } catch (requestError) {
        if (!active) return;
        setError((requestError as Error).message);
      } finally {
        if (active) setConfigLoading(false);
      }
    })();

    return () => { active = false; };
  }, []);

  const openLibrary = (mode: "single" | "batch") => {
    setLibraryMode(mode);
    setLibraryOpen(true);
  };

  const handleLibraryApply = (selected: Material[]) => {
    if (libraryMode === "single") {
      setSelectedMaterial(selected[0] ?? null);
      if (selected[0]) setImageUrl("");
      setError("");
    } else {
      setBatchMaterials(selected);
      setBatchError("");
      setBatchResult("");
    }
    setLibraryOpen(false);
  };

  const handleSingleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !canSubmit) return;

    const token = getToken();
    if (!token) return;
    if (!selectedModel) {
      setError("请先选择一个图生视频模型。");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await api.createVideoFromImage(
        token,
        {
          prompt: prompt.trim(),
          model: selectedModel,
          imageUrl: selectedMaterial ? selectedMaterial.url : imageUrl || undefined,
          aspectRatio: sizeToAspectRatio(size),
          size,
          durationSec: duration,
        },
      );
      onCreated();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleBatchSubmit = async () => {
    const token = getToken();
    if (!token || batchMaterials.length === 0 || !batchPrompt.trim()) return;
    if (!selectedModel) {
      setBatchError("请先选择一个图生视频模型。");
      return;
    }

    setBatchSubmitting(true);
    setBatchError("");
    setBatchResult("");
    setBatchProgress({ current: 0, total: batchMaterials.length });

    let succeeded = 0;
    const errors: string[] = [];

    try {
      // 串行逐个提交，完成一个再处理下一个
      for (let i = 0; i < batchMaterials.length; i++) {
        const material = batchMaterials[i];
        setBatchProgress({ current: i + 1, total: batchMaterials.length });
        try {
          await api.createVideoFromImage(token, {
            prompt: batchPrompt.trim(),
            model: selectedModel,
            imageUrl: material.url,
            aspectRatio: sizeToAspectRatio(batchSize),
            size: batchSize,
            durationSec: batchDuration,
          });
          succeeded++;
          if (succeeded === 1) onCreated(); // 第一个成功后立即刷新列表
        } catch (err) {
          errors.push(`第 ${i + 1} 张（${material.name}）：${(err as Error).message}`);
        }
      }

      setBatchResult(`已提交 ${succeeded}/${batchMaterials.length} 条任务。`);
      if (errors.length > 0) setBatchError(errors.slice(0, 3).join("；"));
      if (succeeded > 1) onCreated(); // 全部完成后再刷新一次
    } finally {
      setBatchSubmitting(false);
      setBatchProgress({ current: 0, total: 0 });
    }
  };

  const renderModelSelect = (label: string) => (
    <div>
      <label
        style={{
          display: "block",
          fontSize: "0.7rem",
          fontFamily: "JetBrains Mono, monospace",
          color: "var(--text-muted)",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {label}
      </label>
      <select
        className="input-field"
        value={selectedModel}
        onChange={(event) => setSelectedModel(event.target.value)}
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
  );

  const renderSizeSelect = (value: string, onChange: (v: string) => void) => (
    <div>
      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
        ASPECT RATIO
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        {SIZE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: `1px solid ${value === option.value ? "var(--accent)" : "var(--border)"}`,
              background: value === option.value ? "var(--accent-glow)" : "transparent",
              color: value === option.value ? "var(--accent)" : "var(--text-secondary)",
              fontSize: "0.8rem",
              cursor: "pointer",
              fontFamily: "JetBrains Mono, monospace",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  const renderDurationSelect = (value: number, onChange: (v: number) => void) => (
    <div>
      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
        DURATION
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        {DURATION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: `1px solid ${value === option.value ? "var(--accent)" : "var(--border)"}`,
              background: value === option.value ? "var(--accent-glow)" : "transparent",
              color: value === option.value ? "var(--accent)" : "var(--text-secondary)",
              fontSize: "0.8rem",
              cursor: "pointer",
              fontFamily: "JetBrains Mono, monospace",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div
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
        <div>
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
        </div>

        {/* Tab 切换 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
            padding: 4,
            borderRadius: 999,
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
          }}
        >
          {[
            { key: "single" as const, label: "单个生成" },
            { key: "batch" as const, label: "批量生成" },
          ].map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "10px 14px",
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "#03130f" : "var(--text-secondary)",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 单个生成 */}
        {activeTab === "single" ? (
          <form onSubmit={handleSingleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                PROMPT
              </label>
              <textarea
                className="input-field"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述视频动作和镜头效果..."
                rows={3}
                style={{ resize: "vertical", minHeight: 88 }}
              />
            </div>

            {renderModelSelect("MODEL")}

            {/* 图片来源 */}
            <div>
              <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                INPUT IMAGE
              </label>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn-ghost" onClick={() => openLibrary("single")}>
                  {selectedMaterial ? "重新选择" : "从素材库选择"}
                </button>
                {selectedMaterial && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => { setSelectedMaterial(null); setError(""); }}
                  >
                    清除
                  </button>
                )}
              </div>

              {/* 已选素材预览 */}
              {selectedMaterial && (
                <div
                  style={{
                    marginTop: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "var(--bg-raised)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedMaterial.url}
                    alt={selectedMaterial.name}
                    style={{ width: "100%", display: "block", maxHeight: 220, objectFit: "cover" }}
                  />
                  <div style={{ padding: "10px 14px", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    {selectedMaterial.name}
                  </div>
                </div>
              )}

              {/* 或输入 URL */}
              {!selectedMaterial && (
                <input
                  className="input-field"
                  type="url"
                  value={imageUrl}
                  onChange={(event) => setImageUrl(event.target.value)}
                  placeholder="或直接输入图片 URL"
                  style={{ marginTop: 10 }}
                />
              )}
            </div>

            {renderSizeSelect(size, setSize)}
            {renderDurationSelect(duration, setDuration)}

            {error && (
              <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)" }}>
                {error}
              </div>
            )}

            <button
              className="btn-primary"
              type="submit"
              disabled={loading || !prompt.trim() || !canSubmit || !selectedModel}
              style={{ width: "100%" }}
            >
              {loading ? "提交中..." : "生成视频"}
            </button>
          </form>
        ) : (
          /* 批量生成 */
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {renderModelSelect("MODEL")}

            {/* 统一 Prompt */}
            <div>
              <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                PROMPT（统一应用于所有素材）
              </label>
              <textarea
                className="input-field"
                value={batchPrompt}
                onChange={(e) => setBatchPrompt(e.target.value)}
                placeholder="描述视频动作和镜头效果，将应用于所有选中的素材..."
                rows={3}
                style={{ resize: "vertical", minHeight: 88 }}
              />
            </div>

            {/* 选择素材 */}
            <div>
              <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                SELECT MATERIALS（可多选）
              </label>
              <button type="button" className="btn-ghost" onClick={() => openLibrary("batch")}>
                {batchMaterials.length > 0 ? `已选 ${batchMaterials.length} 张，重新选择` : "从素材库选择图片"}
              </button>
            </div>

            {/* 已选素材缩略图 */}
            {batchMaterials.length > 0 && (
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 8 }}>
                  已选 {batchMaterials.length} 张素材，将依次串行生成 {batchMaterials.length} 个视频任务：
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 8 }}>
                  {batchMaterials.map((m) => (
                    <div key={m.id} style={{ position: "relative", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)", paddingBottom: "100%", background: "var(--bg-raised)" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={m.url}
                        alt={m.name}
                        loading="lazy"
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                      />
                      <button
                        type="button"
                        onClick={() => setBatchMaterials((prev) => prev.filter((x) => x.id !== m.id))}
                        style={{
                          position: "absolute",
                          top: 2,
                          right: 2,
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "rgba(0,0,0,0.6)",
                          color: "#fff",
                          border: "none",
                          cursor: "pointer",
                          fontSize: "0.6rem",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {renderSizeSelect(batchSize, setBatchSize)}
            {renderDurationSelect(batchDuration, setBatchDuration)}

            {/* 串行进度条 */}
            {batchSubmitting && batchProgress.total > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                  正在处理第 {batchProgress.current} / {batchProgress.total} 个任务...
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "var(--bg-raised)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 2,
                      background: "var(--accent)",
                      width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </div>
            )}

            {batchResult && <div style={{ fontSize: "0.8rem", color: "var(--success)" }}>{batchResult}</div>}
            {batchError && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{batchError}</div>}

            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleBatchSubmit()}
              disabled={batchSubmitting || batchMaterials.length === 0 || !selectedModel || !batchPrompt.trim()}
            >
              {batchSubmitting
                ? `提交中（${batchProgress.current}/${batchProgress.total}）...`
                : `批量生成视频（${batchMaterials.length} 个任务）`}
            </button>
          </div>
        )}
      </div>

      <MaterialLibraryModal
        open={libraryOpen}
        mode={libraryMode}
        selectedIds={
          libraryMode === "single"
            ? selectedMaterial ? [selectedMaterial.id] : []
            : batchMaterials.map((m) => m.id)
        }
        onClose={() => setLibraryOpen(false)}
        onApply={handleLibraryApply}
      />
    </>
  );
}
