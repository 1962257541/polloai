"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import MaterialLibraryModal from "./MaterialLibraryModal";
import { api, Material } from "../lib/api";
import { getToken } from "../lib/auth";

const DURATION_OPTIONS = [
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 15, label: "15s" },
];

const OMNI_FLASH_DURATION_OPTIONS = [
  { value: 6, label: "6s" },
  { value: 8, label: "8s" },
];

const SIZE_OPTIONS = [
  { value: "1280x720", label: "16:9", aspectRatio: "16:9" as const },
  { value: "720x1280", label: "9:16", aspectRatio: "9:16" as const },
];

type GeneratorTab = "single" | "batch";

interface VideoGeneratorProps {
  onCreated: () => void;
}

function sizeToAspectRatio(size: string) {
  return SIZE_OPTIONS.find((item) => item.value === size)?.aspectRatio || "16:9";
}

function isOmniFlashVideoModel(model: string) {
  return /(^|[-_\/])omni[-_]?flash($|[-_\/])|gemini[-_]?omni[-_]?flash/i.test(model);
}

function videoDurationOptions(model: string) {
  return isOmniFlashVideoModel(model) ? OMNI_FLASH_DURATION_OPTIONS : DURATION_OPTIONS;
}

export default function VideoGenerator({ onCreated }: VideoGeneratorProps) {
  const [activeTab, setActiveTab] = useState<GeneratorTab>("single");

  // 单个生成状态（支持多张参考图合成 1 个任务）
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [selectedMaterials, setSelectedMaterials] = useState<Material[]>([]);
  const [size, setSize] = useState("1280x720");
  const [duration, setDuration] = useState(5);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 批量生成状态（每张图 1 个任务）
  const [batchPrompt, setBatchPrompt] = useState("");
  const [batchMaterials, setBatchMaterials] = useState<Material[]>([]);
  const [batchSize, setBatchSize] = useState("1280x720");
  const [batchDuration, setBatchDuration] = useState(5);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState("");
  const [batchError, setBatchError] = useState("");
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  // 素材库弹窗（两个 tab 都用多选）
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTarget, setLibraryTarget] = useState<"single" | "batch">("single");

  // 提示词输入区挂载点（位于页面中间预览栏底部，与文字生图一致）
  const [promptHost, setPromptHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPromptHost(document.getElementById("video-prompt-slot"));
  }, []);

  const canSubmit = Boolean(imageUrl.trim() || selectedMaterials.length > 0);

  const isSingle = activeTab === "single";
  const promptSubmitting = isSingle ? loading : batchSubmitting;
  const promptSubmitDisabled = isSingle
    ? loading || !prompt.trim() || !canSubmit || !selectedModel
    : batchSubmitting || batchMaterials.length === 0 || !batchPrompt.trim() || !selectedModel;

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

  useEffect(() => {
    if (!selectedModel || !isOmniFlashVideoModel(selectedModel)) return;
    if (![6, 8].includes(duration)) setDuration(6);
    if (![6, 8].includes(batchDuration)) setBatchDuration(6);
  }, [selectedModel, duration, batchDuration]);

  const openLibrary = (target: "single" | "batch") => {
    setLibraryTarget(target);
    setLibraryOpen(true);
  };

  const handleLibraryApply = (selected: Material[]) => {
    if (libraryTarget === "single") {
      const capped = selected.slice(0, 9);
      setSelectedMaterials(capped);
      if (capped.length > 0) setImageUrl("");
      setError(selected.length > 9 ? "图生视频最多 9 张参考图，已自动保留前 9 张。" : "");
    } else {
      setBatchMaterials(selected);
      setBatchError("");
      setBatchResult("");
    }
    setLibraryOpen(false);
  };

  const handleSingleSubmit = async () => {
    if (!prompt.trim() || !canSubmit) return;

    const token = getToken();
    if (!token) return;
    if (!selectedModel) {
      setError("请先选择一个图生视频模型。");
      return;
    }

    const imageUrls = [
      ...selectedMaterials.map((m) => m.url),
      ...(imageUrl.trim() ? [imageUrl.trim()] : []),
    ];

    try {
      setLoading(true);
      setError("");
      await api.createVideoFromImage(token, {
        prompt: prompt.trim(),
        model: selectedModel,
        imageUrls,
        aspectRatio: sizeToAspectRatio(size),
        size,
        durationSec: duration,
      });
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
          if (succeeded === 1) onCreated();
        } catch (err) {
          errors.push(`第 ${i + 1} 张（${material.name}）：${(err as Error).message}`);
        }
      }

      setBatchResult(`已提交 ${succeeded}/${batchMaterials.length} 条任务。`);
      if (errors.length > 0) setBatchError(errors.slice(0, 3).join("；"));
      if (succeeded > 1) onCreated();
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
          fontFamily: "inherit",
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
      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
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
              fontFamily: "inherit",
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
      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
        DURATION
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        {videoDurationOptions(selectedModel).map((option) => (
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
              fontFamily: "inherit",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  const renderThumbGrid = (materials: Material[], onRemove: (id: string) => void) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 6 }}>
      {materials.map((m) => (
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
            onClick={() => onRemove(m.id)}
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
  );

  return (
    <>
      {/* 整个生成器卡片：flex 列，撑满父容器高度 */}
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {/* Tab 切换 — 固定顶部 */}
        <div style={{ padding: "14px 16px 12px", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 6,
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
                    padding: "8px 14px",
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "#FFFFFF" : "var(--text-secondary)",
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
        </div>

        {/* 单个生成 */}
        {activeTab === "single" ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* 可滚动的表单内容区 */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 16 }}>
              {renderModelSelect("MODEL")}

              {/* 图片来源（可多选） */}
              <div>
                <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                  INPUT IMAGES（可多选，最多 9 张）
                </label>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" className="btn-ghost" onClick={() => openLibrary("single")}>
                    {selectedMaterials.length > 0 ? `已选 ${selectedMaterials.length} 张，重新选择` : "从素材库选择"}
                  </button>
                  {selectedMaterials.length > 0 && (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => { setSelectedMaterials([]); setError(""); }}
                    >
                      清除
                    </button>
                  )}
                </div>

                {selectedMaterials.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {renderThumbGrid(selectedMaterials, (id) =>
                      setSelectedMaterials((prev) => prev.filter((x) => x.id !== id)),
                    )}
                  </div>
                )}

                {selectedMaterials.length === 0 && (
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
                <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.18)", borderRadius: 8, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)" }}>
                  {error}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* 批量生成 */
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* 可滚动的表单内容区 */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 16 }}>
              {renderModelSelect("MODEL")}

              <div>
                <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
                  SELECT MATERIALS（可多选）
                </label>
                <button type="button" className="btn-ghost" onClick={() => openLibrary("batch")}>
                  {batchMaterials.length > 0 ? `已选 ${batchMaterials.length} 张，重新选择` : "从素材库选择图片"}
                </button>
              </div>

              {batchMaterials.length > 0 && (
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 8 }}>
                    已选 {batchMaterials.length} 张，将串行生成 {batchMaterials.length} 个任务：
                  </div>
                  {renderThumbGrid(batchMaterials, (id) =>
                    setBatchMaterials((prev) => prev.filter((x) => x.id !== id)),
                  )}
                </div>
              )}

              {renderSizeSelect(batchSize, setBatchSize)}
              {renderDurationSelect(batchDuration, setBatchDuration)}

              {batchSubmitting && batchProgress.total > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontFamily: "inherit" }}>
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
            </div>
          </div>
        )}
      </div>

      {/* 提示词输入区 — 渲染到中间预览栏底部（与文字生图布局一致） */}
      {promptHost &&
        createPortal(
          <div style={{ borderTop: "1px solid var(--border)", padding: "16px 20px", background: "var(--bg-surface)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <textarea
                className="input-field"
                value={isSingle ? prompt : batchPrompt}
                onChange={(e) => (isSingle ? setPrompt(e.target.value) : setBatchPrompt(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!promptSubmitDisabled) void (isSingle ? handleSingleSubmit() : handleBatchSubmit());
                  }
                }}
                placeholder={
                  isSingle
                    ? "描述视频动作和镜头效果... (Enter 发送，Shift+Enter 换行)"
                    : "描述视频动作和镜头效果，将应用于所有选中的素材... (Enter 发送，Shift+Enter 换行)"
                }
                rows={3}
                style={{ flex: 1, resize: "vertical", minHeight: 76 }}
                disabled={promptSubmitting}
              />
              <button
                className="btn-primary"
                type="button"
                onClick={() => void (isSingle ? handleSingleSubmit() : handleBatchSubmit())}
                disabled={promptSubmitDisabled}
                title={isSingle ? "生成视频" : `批量生成视频（${batchMaterials.length} 个任务）`}
                style={{ minWidth: 64, flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
              >
                {promptSubmitting ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
          </div>,
          promptHost,
        )}

      <MaterialLibraryModal
        open={libraryOpen}
        mode="batch"
        selectedIds={
          libraryTarget === "single"
            ? selectedMaterials.map((m) => m.id)
            : batchMaterials.map((m) => m.id)
        }
        onClose={() => setLibraryOpen(false)}
        onApply={handleLibraryApply}
      />
    </>
  );
}
