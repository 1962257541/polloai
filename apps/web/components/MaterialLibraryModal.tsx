"use client";

import { useEffect, useState } from "react";

export type MaterialLibraryMode = "single" | "batch";

interface MaterialLibraryModalProps {
  open: boolean;
  mode: MaterialLibraryMode;
  files: File[];
  message: string;
  selectedKeys: string[];
  onClose: () => void;
  onApply: () => void;
  onToggle: (key: string) => void;
  onUpload: (fileList: FileList | null) => void;
}

function normalizeImageKey(value: string) {
  return value.trim().replace(/^.*[\\/]/, "").toLowerCase();
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MaterialLibraryModal({
  open,
  mode,
  files,
  message,
  selectedKeys,
  onClose,
  onApply,
  onToggle,
  onUpload,
}: MaterialLibraryModalProps) {
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextPreviewUrls: Record<string, string> = {};
    for (const file of files) {
      nextPreviewUrls[normalizeImageKey(file.name)] = URL.createObjectURL(file);
    }
    setPreviewUrls(nextPreviewUrls);

    return () => {
      Object.values(nextPreviewUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  if (!open) return null;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
                fontFamily: "Syne, sans-serif",
                fontWeight: 700,
                fontSize: "1rem",
                color: "var(--text-primary)",
              }}
            >
              素材库
            </h3>
            <p style={{ margin: "6px 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              上传图片后即可在这里选择素材。支持 PNG、JPEG、WebP，同名文件会覆盖旧素材。
            </p>
          </div>

          <button type="button" className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label
              className="btn-ghost"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              上传图片
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  onUpload(event.target.files);
                  event.currentTarget.value = "";
                }}
                style={{ display: "none" }}
              />
            </label>

            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              {mode === "batch" ? "当前用于批量匹配，可多选。" : "当前用于单个图生视频，只会选中一张。"}
            </div>
          </div>

          {message && (
            <div
              style={{
                borderRadius: 8,
                border: "1px solid rgba(15, 23, 42, 0.1)",
                background: "var(--bg-raised)",
                padding: "10px 12px",
                fontSize: "0.78rem",
                color: "var(--text-secondary)",
              }}
            >
              {message}
            </div>
          )}

          {files.length === 0 ? (
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
              }}
            >
              还没有素材，先上传图片再选择。
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
                gap: 14,
              }}
            >
              {files.map((file) => {
                const key = normalizeImageKey(file.name);
                const active = selectedKeys.includes(key);

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onToggle(key)}
                    style={{
                      border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: active ? "var(--accent-glow)" : "var(--bg-base)",
                      borderRadius: 12,
                      padding: 0,
                      overflow: "hidden",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <div
                      style={{
                        height: 112,
                        background: "var(--bg-raised)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <img
                        src={previewUrls[key]}
                        alt={file.name}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    </div>

                    <div style={{ padding: 12 }}>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.name}
                      >
                        {file.name}
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        <span>{formatFileSize(file.size)}</span>
                        <span>{active ? "已选中" : mode === "batch" ? "点击多选" : "点击选中"}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

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
            已选择 {selectedKeys.length} 项
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onApply}
              disabled={selectedKeys.length === 0}
            >
              确认选择
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
