"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, Material } from "../lib/api";
import { getToken } from "../lib/auth";
import UploadProgressBar from "./UploadProgressBar";

export type MaterialLibraryMode = "single" | "batch";

interface MaterialLibraryModalProps {
  open: boolean;
  mode: MaterialLibraryMode;
  selectedIds: string[];
  onClose: () => void;
  onApply: (selected: Material[]) => void;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MaterialLibraryModal({
  open,
  mode,
  selectedIds,
  onClose,
  onApply,
}: MaterialLibraryModalProps) {
  const [items, setItems] = useState<Material[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    currentFileIndex: number;
    totalFiles: number;
    currentFileName: string;
    percent: number;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const token = getToken() ?? "";

  const loadMaterials = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await api.listMaterials(token, { mediaType: "image", limit: 100 });
      setItems(result.items);
    } catch (e: any) {
      setMessage(e.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // 打开时加载素材、初始化选中状态
  useEffect(() => {
    if (!open) return;
    setSelection(selectedIds);
    setMessage("");
    void loadMaterials();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+V 粘贴上传
  useEffect(() => {
    if (!open) return;
    const handler = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!item) return;
      const file = item.getAsFile();
      if (file) void handleUpload(file, 0, 1);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (file: File, fileIndex: number, totalFiles: number) => {
    if (!token) return;
    setUploading(true);
    setMessage("");
    setUploadProgress({
      currentFileIndex: fileIndex,
      totalFiles,
      currentFileName: file.name,
      percent: 0,
    });
    try {
      const material = await api.uploadMaterial(token, file, (percent) => {
        setUploadProgress((prev) => (prev ? { ...prev, percent } : prev));
      });
      setItems((prev) => [material, ...prev]);
      setSelection((prev) => {
        if (mode === "single") return [material.id];
        return [...prev, material.id];
      });
      setMessage(`已上传：${file.name}`);
    } catch (e: any) {
      setMessage(e.message ?? "上传失败");
    } finally {
      if (fileIndex === totalFiles - 1) {
        setUploading(false);
        setUploadProgress(null);
      }
    }
  };

  const toggleSelection = (id: string) => {
    setSelection((prev) => {
      if (mode === "single") return prev[0] === id ? [] : [id];
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  };

  const handleApply = () => {
    const selected = items.filter((m) => selection.includes(m.id));
    onApply(selected);
  };

  if (!open) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(2, 6, 23, 0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "min(920px, 100%)",
          maxHeight: "80vh",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          boxShadow: "0 18px 60px rgba(15, 23, 42, 0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                fontFamily: "inherit",
                fontWeight: 700,
                fontSize: "1rem",
                color: "var(--text-primary)",
              }}
            >
              素材库
            </h3>
            <p style={{ margin: "6px 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              {mode === "batch" ? "多选图片后统一生成视频。" : "选择一张图片用于生成视频。"}
              支持 Ctrl+V 粘贴上传。
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
        </div>

        {/* 内容区 */}
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", flex: 1 }}>
          {/* 操作栏 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label
              className="btn-ghost"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
            >
              {uploading ? "上传中..." : "上传图片"}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  (async () => {
                    for (let i = 0; i < files.length; i++) {
                      await handleUpload(files[i], i, files.length);
                    }
                    setUploading(false);
                    setUploadProgress(null);
                  })();
                  e.currentTarget.value = "";
                }}
                style={{ display: "none" }}
                disabled={uploading}
              />
            </label>
            <button type="button" className="btn-ghost" onClick={loadMaterials} disabled={loading}>
              {loading ? "加载中..." : "刷新"}
            </button>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              已选 {selection.length} 项
            </span>
          </div>

          {/* 消息提示 */}
          {message && (
            <div
              style={{
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-raised)",
                padding: "10px 12px",
                fontSize: "0.78rem",
                color: "var(--text-secondary)",
              }}
            >
              {message}
            </div>
          )}

          {/* 上传进度条 */}
          {uploading && uploadProgress && (
            <UploadProgressBar
              currentFileIndex={uploadProgress.currentFileIndex}
              totalFiles={uploadProgress.totalFiles}
              currentFileName={uploadProgress.currentFileName}
              percent={uploadProgress.percent}
            />
          )}

          {/* 素材网格 */}
          {items.length === 0 && !loading ? (
            <div
              style={{
                minHeight: 220,
                border: "1px dashed var(--border)",
                borderRadius: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                fontSize: "0.82rem",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <span>素材库暂无图片</span>
              <span style={{ fontSize: "0.75rem" }}>上传图片或生成图片后会自动出现在这里</span>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
                gap: 14,
              }}
            >
              {items.map((material) => {
                const active = selection.includes(material.id);
                return (
                  <button
                    key={material.id}
                    type="button"
                    onClick={() => toggleSelection(material.id)}
                    style={{
                      border: active ? "2px solid var(--accent)" : "1px solid var(--border)",
                      background: active ? "var(--accent-glow)" : "var(--bg-base)",
                      borderRadius: 12,
                      padding: 0,
                      overflow: "hidden",
                      cursor: "pointer",
                      textAlign: "left",
                      position: "relative",
                    }}
                  >
                    {/* 选中角标 */}
                    {active && (
                      <div
                        style={{
                          position: "absolute",
                          top: 6,
                          right: 6,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          color: "#000",
                          fontSize: "0.65rem",
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          zIndex: 2,
                        }}
                      >
                        ✓
                      </div>
                    )}

                    {/* AI 生成标签 */}
                    {material.source === "generated" && (
                      <div
                        style={{
                          position: "absolute",
                          top: 6,
                          left: 6,
                          background: "rgba(245,158,11,0.85)",
                          color: "#000",
                          fontSize: "0.6rem",
                          padding: "2px 5px",
                          borderRadius: 4,
                          fontWeight: 600,
                          zIndex: 2,
                        }}
                      >
                        AI
                      </div>
                    )}

                    <div
                      style={{
                        height: 112,
                        background: "var(--bg-raised)",
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={material.url}
                        alt={material.name}
                        loading="lazy"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    </div>

                    <div style={{ padding: 10 }}>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={material.name}
                      >
                        {material.name}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>{formatFileSize(material.sizeBytes)}</span>
                        <span>{active ? "已选中" : mode === "batch" ? "多选" : "选中"}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div
          style={{
            padding: "16px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            已选择 {selection.length} 项
            {mode === "batch" && selection.length > 0 && `，将生成 ${selection.length} 个视频任务`}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleApply}
              disabled={selection.length === 0}
            >
              确认选择
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
