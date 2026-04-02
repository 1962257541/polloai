"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../../../lib/auth";
import { api, Material } from "../../../lib/api";
import UploadProgressBar from "../../../components/UploadProgressBar";

/** 预览弹层 */
function PreviewModal({ material, onClose }: { material: Material; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          maxWidth: "90vw",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        {material.mediaType === "video" ? (
          <video
            src={material.url}
            controls
            autoPlay
            style={{ maxWidth: "85vw", maxHeight: "80vh", borderRadius: 8, display: "block" }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={material.url}
            alt={material.name}
            style={{ maxWidth: "85vw", maxHeight: "80vh", borderRadius: 8, display: "block", objectFit: "contain" }}
          />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.6)" }}>{material.name}</span>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 6,
              padding: "4px 14px",
              color: "#fff",
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            关闭 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

type TabType = "all" | "image" | "video";

const PAGE_SIZE = 20;

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 通过 fetch + blob 下载单个文件到本地 */
async function downloadFile(url: string, filename: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function MaterialsPage() {
  const [tab, setTab] = useState<TabType>("all");
  const [items, setItems] = useState<Material[]>([]);
  // cursor 历史栈：第 i 页的起始 cursor（第 0 页为 undefined）
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [currentPage, setCurrentPage] = useState(0); // 0-indexed
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    currentFileIndex: number;
    totalFiles: number;
    currentFileName: string;
    percent: number;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 勾选状态
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 预览
  const [preview, setPreview] = useState<Material | null>(null);

  const token = getToken() ?? "";

  const fetchPage = useCallback(
    async (cursor: string | undefined) => {
      setLoading(true);
      setSelected(new Set());
      try {
        const mediaType = tab === "all" ? undefined : tab;
        const result = await api.listMaterials(token, { mediaType, cursor, limit: PAGE_SIZE });
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setTotal(result.total ?? 0);
      } catch (e: any) {
        setMessage(e.message ?? "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [tab, token],
  );

  // 切换 tab 时重置到第 0 页
  useEffect(() => {
    setCursorStack([undefined]);
    setCurrentPage(0);
    setNextCursor(null);
    void fetchPage(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token]);

  const goNextPage = async () => {
    if (!nextCursor) return;
    const newPage = currentPage + 1;
    const newStack = [...cursorStack];
    // 如果是新页（没有缓存的 cursor），推入栈
    if (newStack.length <= newPage) {
      newStack.push(nextCursor);
      setCursorStack(newStack);
    }
    setCurrentPage(newPage);
    await fetchPage(nextCursor);
  };

  const goPrevPage = async () => {
    if (currentPage === 0) return;
    const newPage = currentPage - 1;
    setCurrentPage(newPage);
    await fetchPage(cursorStack[newPage]);
  };

  // 全局粘贴上传
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!item) return;
      const file = item.getAsFile();
      if (file) void handleUploadFile(file, 0, 1);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleUploadFile = async (file: File, fileIndex: number, totalFiles: number) => {
    setUploading(true);
    setMessage(null);
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
      setMessage("上传成功");
    } catch (e: any) {
      setMessage(e.message ?? "上传失败");
    } finally {
      if (fileIndex === totalFiles - 1) {
        setUploading(false);
        setUploadProgress(null);
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    (async () => {
      for (let i = 0; i < files.length; i++) {
        await handleUploadFile(files[i], i, files.length);
      }
      setUploading(false);
      setUploadProgress(null);
    })();
    e.target.value = "";
  };

  // 批量删除
  const handleBatchDelete = async () => {
    const targets = items.filter((m) => selected.has(m.id));
    if (targets.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${targets.length} 个素材？此操作不可恢复。`)) return;
    setDeleting(true);
    setMessage(null);
    try {
      await Promise.all(targets.map((m) => api.deleteMaterial(token, m.id)));
      const deletedIds = new Set(targets.map((m) => m.id));
      setItems((prev) => prev.filter((m) => !deletedIds.has(m.id)));
      setSelected(new Set());
      setMessage(`已删除 ${targets.length} 个素材`);
    } catch (e: any) {
      setMessage(e.message ?? "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // 勾选操作
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((m) => m.id)));
    }
  };

  // 批量下载
  const handleBatchDownload = async () => {
    const targets = items.filter((m) => selected.has(m.id));
    if (targets.length === 0) return;
    setDownloading(true);
    setMessage(null);
    try {
      // 串行下载，避免同时打开大量弹窗
      for (const m of targets) {
        await downloadFile(m.url, m.name);
        // 短暂间隔，防止浏览器拦截
        await new Promise((r) => setTimeout(r, 300));
      }
      setMessage(`已下载 ${targets.length} 个文件`);
    } catch (e: any) {
      setMessage(e.message ?? "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  const TAB_LABELS: { key: TabType; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
  ];

  const allSelected = items.length > 0 && selected.size === items.length;
  const partialSelected = selected.size > 0 && selected.size < items.length;

  return (
    <div style={{ width: "100%" }}>
      {/* 预览弹层 */}
      {preview && <PreviewModal material={preview} onClose={() => setPreview(null)} />}
      {/* 页头 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "inherit",
              fontWeight: 700,
              fontSize: "1.5rem",
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            素材库
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", margin: "4px 0 0" }}>
            管理上传和 AI 生成的图片与视频
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* 批量操作按钮（有勾选时显示） */}
          {selected.size > 0 && (
            <>
              <button
                onClick={handleBatchDownload}
                disabled={downloading || deleting}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "0.82rem",
                  cursor: downloading ? "not-allowed" : "pointer",
                  opacity: downloading ? 0.6 : 1,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {downloading ? "下载中..." : `下载 (${selected.size})`}
              </button>

              <button
                onClick={handleBatchDelete}
                disabled={deleting || downloading}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: "1px solid rgba(239,68,68,0.4)",
                  background: "transparent",
                  color: "#ef4444",
                  fontSize: "0.82rem",
                  cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {deleting ? "删除中..." : `删除 (${selected.size})`}
              </button>
            </>
          )}

          <button
            className="btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            {uploading ? (
              "上传中..."
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                上传素材
              </>
            )}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {TAB_LABELS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "1px solid",
              borderColor: tab === key ? "var(--accent)" : "var(--border)",
              background: tab === key ? "var(--accent-glow)" : "transparent",
              color: tab === key ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: tab === key ? 500 : 400,
              transition: "all 0.15s",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 消息提示 */}
      {message && (
        <div
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            fontSize: "0.8rem",
            marginBottom: 16,
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

      {/* 工具栏：全选 + 提示 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {items.length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = partialSelected;
                }}
                onChange={toggleSelectAll}
                style={{ width: 15, height: 15, accentColor: "var(--accent)", cursor: "pointer" }}
              />
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {allSelected ? "取消全选" : "全选本页"}
                {selected.size > 0 && `（已选 ${selected.size}）`}
              </span>
            </label>
          )}
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          支持 Ctrl+V 粘贴图片直接上传
        </span>
      </div>

      {/* 素材网格 */}
      {items.length === 0 && !loading ? (
        <div
          style={{
            textAlign: "center",
            padding: "80px 0",
            color: "var(--text-muted)",
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 12px", display: "block", opacity: 0.4 }}>
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <p style={{ margin: 0, fontSize: "0.875rem" }}>暂无素材</p>
          <p style={{ margin: "4px 0 0", fontSize: "0.8rem" }}>上传图片或生成图片后将出现在这里</p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
          }}
        >
          {items.map((material) => (
            <MaterialCard
              key={material.id}
              material={material}
              selected={selected.has(material.id)}
              onToggleSelect={toggleSelect}
              onPreview={setPreview}
            />
          ))}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-muted)", fontSize: "0.8rem" }}>
          加载中...
        </div>
      )}

      {/* 分页控件 */}
      {!loading && items.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            marginTop: 28,
            paddingBottom: 16,
          }}
        >
          <button
            onClick={goPrevPage}
            disabled={currentPage === 0}
            style={{
              padding: "6px 18px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: currentPage === 0 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: currentPage === 0 ? "not-allowed" : "pointer",
              fontSize: "0.875rem",
              transition: "all 0.15s",
            }}
          >
            ← 上一页
          </button>

          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", textAlign: "center", whiteSpace: "nowrap" }}>
            第 {currentPage + 1} / {Math.ceil(total / PAGE_SIZE) || 1} 页
            <span style={{ color: "var(--border)", margin: "0 6px" }}>·</span>
            共 {total} 个
          </span>

          <button
            onClick={goNextPage}
            disabled={!nextCursor}
            style={{
              padding: "6px 18px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: !nextCursor ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: !nextCursor ? "not-allowed" : "pointer",
              fontSize: "0.875rem",
              transition: "all 0.15s",
            }}
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  );
}

function MaterialCard({
  material,
  selected,
  onToggleSelect,
  onPreview,
}: {
  material: Material;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onPreview: (material: Material) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--bg-raised)",
        border: "1px solid",
        position: "relative",
        transition: "border-color 0.15s",
        borderColor: selected ? "var(--accent)" : hovered ? "rgba(255,255,255,0.2)" : "var(--border)",
      }}
    >
      {/* 预览区（点击打开预览） */}
      <div
        onClick={() => onPreview(material)}
        style={{ width: "100%", paddingBottom: "100%", position: "relative", background: "var(--bg-overlay)", cursor: "zoom-in" }}
      >
        {material.mediaType === "video" ? (
          <video
            src={material.url}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            muted
            preload="metadata"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={material.url}
            alt={material.name}
            loading="lazy"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}

        {/* 悬浮预览提示 */}
        {hovered && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                background: "rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6,
                padding: "5px 12px",
                color: "#fff",
                fontSize: "0.75rem",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              预览
            </div>
          </div>
        )}

        {/* 来源标签 */}
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            background: material.source === "generated" ? "rgba(245,158,11,0.85)" : "rgba(30,30,40,0.8)",
            color: material.source === "generated" ? "#000" : "var(--text-secondary)",
            fontSize: "0.65rem",
            padding: "2px 6px",
            borderRadius: 4,
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {material.source === "generated" ? "AI生成" : "上传"}
        </div>

        {/* 勾选框（右上角，阻止冒泡避免触发预览） */}
        <div
          style={{ position: "absolute", top: 6, right: 6 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(material.id);
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              border: `2px solid ${selected ? "var(--accent)" : "rgba(255,255,255,0.7)"}`,
              background: selected ? "var(--accent)" : "rgba(0,0,0,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all 0.12s",
            }}
          >
            {selected && (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <polyline points="2,6 5,9 10,3" stroke="#000" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        </div>
      </div>

      {/* 信息区 */}
      <div style={{ padding: "8px 10px" }}>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={material.name}
        >
          {material.name}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, gap: 4 }}>
          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
            {formatFileSize(material.sizeBytes)}
          </span>
        </div>
      </div>
    </div>
  );
}
