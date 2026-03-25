"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../../../lib/auth";
import { api, Material } from "../../../lib/api";

type TabType = "all" | "image" | "video";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


export default function MaterialsPage() {
  const [tab, setTab] = useState<TabType>("all");
  const [items, setItems] = useState<Material[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const token = getToken() ?? "";

  const loadMore = useCallback(
    async (cursor?: string, reset?: boolean) => {
      if (loading) return;
      setLoading(true);
      try {
        const mediaType = tab === "all" ? undefined : tab;
        const result = await api.listMaterials(token, { mediaType, cursor, limit: 20 });
        setItems((prev) => (reset ? result.items : [...prev, ...result.items]));
        setNextCursor(result.nextCursor);
      } catch (e: any) {
        setMessage(e.message ?? "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [tab, token, loading],
  );

  // 切换 tab 时重新加载
  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void (async () => {
      setLoading(true);
      try {
        const mediaType = tab === "all" ? undefined : tab;
        const result = await api.listMaterials(token, { mediaType, limit: 20 });
        setItems(result.items);
        setNextCursor(result.nextCursor);
      } catch (e: any) {
        setMessage(e.message ?? "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, token]);

  // 无限滚动
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect();
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && nextCursor && !loading) {
          void loadMore(nextCursor);
        }
      },
      { threshold: 0.1 },
    );
    if (sentinelRef.current) observerRef.current.observe(sentinelRef.current);
    return () => observerRef.current?.disconnect();
  }, [nextCursor, loading, loadMore]);

  // 全局粘贴上传
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!item) return;
      const file = item.getAsFile();
      if (file) void handleUploadFile(file);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [token]);

  const handleUploadFile = async (file: File) => {
    setUploading(true);
    setMessage(null);
    try {
      const material = await api.uploadMaterial(token, file);
      setItems((prev) => [material, ...prev]);
      setMessage("上传成功");
    } catch (e: any) {
      setMessage(e.message ?? "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    // 串行上传
    (async () => {
      for (const file of files) {
        await handleUploadFile(file);
      }
    })();
    e.target.value = "";
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMaterial(token, id);
      setItems((prev) => prev.filter((m) => m.id !== id));
    } catch (e: any) {
      setMessage(e.message ?? "删除失败");
    }
  };

  const TAB_LABELS: { key: TabType; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
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
              fontFamily: "Syne, sans-serif",
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

      {/* 提示：可粘贴上传 */}
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginBottom: 16,
        }}
      >
        支持 Ctrl+V 粘贴图片直接上传
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
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((material) => (
            <MaterialCard
              key={material.id}
              material={material}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* 哨兵 div（无限滚动触发点） */}
      <div ref={sentinelRef} style={{ height: 1 }} />

      {loading && (
        <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-muted)", fontSize: "0.8rem" }}>
          加载中...
        </div>
      )}
    </div>
  );
}

function MaterialCard({
  material,
  onDelete,
}: {
  material: Material;
  onDelete: (id: string) => void;
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
        border: "1px solid var(--border)",
        position: "relative",
        transition: "border-color 0.15s",
        borderColor: hovered ? "var(--accent)" : "var(--border)",
      }}
    >
      {/* 预览区 */}
      <div style={{ width: "100%", paddingBottom: "100%", position: "relative", background: "var(--bg-overlay)" }}>
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

        {/* 悬浮操作按钮 */}
        {hovered && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <button
              onClick={() => onDelete(material.id)}
              title="删除"
              style={{
                background: "var(--error)",
                color: "#fff",
                border: "none",
                borderRadius: 5,
                padding: "5px 10px",
                cursor: "pointer",
                fontSize: "0.75rem",
                fontWeight: 600,
              }}
            >
              删除
            </button>
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
