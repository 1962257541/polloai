"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, SalespersonInfo } from "../lib/api";
import { getToken } from "../lib/auth";
import SearchableMultiSelect from "./SearchableMultiSelect";

interface ModalState {
  userId: string;
  userEmail: string;
}

export default function ModelConfigManage() {
  const [list, setList] = useState<SalespersonInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [videoModels, setVideoModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;

    try {
      setLoading(true);
      setError("");
      const data = await api.listSalespersons(token);
      setList(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeModal = () => {
    setModal(null);
    setCatalog([]);
    setCatalogLoading(false);
    setImageModels([]);
    setVideoModels([]);
    setError("");
  };

  const openModal = async (user: SalespersonInfo) => {
    const token = getToken();
    if (!token) return;

    setModal({ userId: user.id, userEmail: user.email });
    setImageModels(user.imageModels || (user.imageModel ? [user.imageModel] : []));
    setVideoModels(user.videoModels || (user.videoModel ? [user.videoModel] : []));

    try {
      setCatalogLoading(true);
      setError("");
      const data = await api.getUserModelCatalog(token, user.id);
      setCatalog(data.models || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleSave = async () => {
    const token = getToken();
    if (!token || !modal) return;

    try {
      setSubmitting(true);
      setError("");
      await api.updateUserModelConfig(token, modal.userId, { imageModels, videoModels });
      closeModal();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: 0 }}>
          模型配置
        </h3>
        <button className="btn-ghost" onClick={() => void load()} style={{ fontSize: "0.8rem" }}>
          刷新列表
        </button>
      </div>

      {error && !modal && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 1fr 140px 140px 120px",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            fontSize: "0.65rem",
            fontFamily: "inherit",
            color: "var(--text-muted)",
            letterSpacing: "0.1em",
          }}
        >
          <span>EMAIL</span>
          <span>NAME</span>
          <span>IMAGE MODELS</span>
          <span>VIDEO MODELS</span>
          <span>ACTIONS</span>
        </div>

        {loading ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            加载中...
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            暂无可配置账号
          </div>
        ) : (
          list.map((user) => (
            <div
              key={user.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 1fr 140px 140px 120px",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ color: "var(--text-primary)", fontFamily: "inherit", fontSize: "0.75rem" }}>
                {user.email}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>{user.name || "-"}</span>
              <span style={{ color: "var(--text-secondary)" }}>{(user.imageModels || []).length}</span>
              <span style={{ color: "var(--text-secondary)" }}>{(user.videoModels || []).length}</span>
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                  onClick={() => void openModal(user)}
                >
                  配置
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {modal &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              backdropFilter: "blur(4px)",
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                closeModal();
              }
            }}
          >
            <div
              style={{
                background: "var(--bg-overlay)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "28px",
                width: "calc(100% - 32px)",
                maxWidth: 960,
                maxHeight: "90vh",
                overflowY: "auto",
              }}
            >
              <div style={{ borderBottom: "2px solid var(--accent)", paddingBottom: 12, marginBottom: 20 }}>
                <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "var(--accent)", margin: 0, fontSize: "1rem" }}>
                  配置可用模型
                </h3>
                <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 4, marginBottom: 0 }}>
                  {modal.userEmail}
                </p>
              </div>

              {catalogLoading ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-muted)" }}>
                  正在加载远端模型目录...
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                  <SearchableMultiSelect
                    label="文字生图可用模型"
                    options={catalog}
                    value={imageModels}
                    onChange={setImageModels}
                    emptyText="没有可用的图片模型"
                  />
                  <SearchableMultiSelect
                    label="图生视频可用模型"
                    options={catalog}
                    value={videoModels}
                    onChange={setVideoModels}
                    emptyText="没有可用的视频模型"
                  />
                </div>
              )}

              {error && (
                <div style={{ marginTop: 16, fontSize: "0.8rem", color: "var(--error)" }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
                <button className="btn-ghost" onClick={closeModal} type="button">
                  取消
                </button>
                <button className="btn-primary" onClick={handleSave} disabled={submitting || catalogLoading} type="button">
                  {submitting ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
