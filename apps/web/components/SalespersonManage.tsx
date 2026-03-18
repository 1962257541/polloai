"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, SalespersonInfo } from "../lib/api";
import { getToken } from "../lib/auth";

interface ModalState {
  type: "create" | "apikey" | "delete";
  userId?: string;
  userEmail?: string;
  existingApiUrl?: string;
  existingHasKey?: boolean;
}

export default function SalespersonManage() {
  const [list, setList] = useState<SalespersonInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [error, setError] = useState("");

  // 创建表单
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // API 配置表单
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiUrlInput, setApiUrlInput] = useState("");
  const [imageModelInput, setImageModelInput] = useState("");
  const [imageApiTypeInput, setImageApiTypeInput] = useState<"openai-images" | "gemini-native">("openai-images");
  const [videoModelInput, setVideoModelInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      setLoading(true);
      const data = await api.listSalespersons(token);
      setList(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const token = getToken();
    if (!token || !newEmail || !newPassword) return;
    try {
      setSubmitting(true);
      setError("");
      await api.createSalesperson(token, { email: newEmail, name: newName || undefined, password: newPassword });
      setModal(null);
      setNewEmail(""); setNewName(""); setNewPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetApiKey = async () => {
    const token = getToken();
    if (!token || !modal?.userId || (!apiKeyInput && !modal.existingHasKey) || !apiUrlInput) return;
    try {
      setSubmitting(true);
      setError("");
      await api.updateSalespersonApiConfig(token, modal.userId, apiKeyInput, apiUrlInput, imageModelInput || undefined, imageApiTypeInput, videoModelInput || undefined);
      setModal(null);
      setApiKeyInput("");
      setApiUrlInput("");
      setImageModelInput("");
      setImageApiTypeInput("openai-images");
      setVideoModelInput("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    const token = getToken();
    if (!token || !modal?.userId) return;
    try {
      setSubmitting(true);
      setError("");
      await api.deleteSalesperson(token, modal.userId);
      setModal(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {/* 标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: 0 }}>
          账户管理
        </h3>
        <button className="btn-ghost" onClick={() => setModal({ type: "create" })} style={{ fontSize: "0.8rem" }}>
          + 创建账户
        </button>
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "10px 12px", fontSize: "0.8rem", color: "var(--error)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* 表格 */}
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {/* 表头 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 90px 120px 180px",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            fontSize: "0.65rem",
            fontFamily: "JetBrains Mono, monospace",
            color: "var(--text-muted)",
            letterSpacing: "0.1em",
          }}
        >
          <span>EMAIL</span>
          <span>NAME</span>
          <span>ROLE</span>
          <span>API KEY</span>
          <span>ACTIONS</span>
        </div>

        {loading ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            加载中...
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            暂无业务员账户
          </div>
        ) : (
          list.map((user) => (
            <div
              key={user.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 90px 120px 180px",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                fontSize: "0.8rem",
                alignItems: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-raised)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: "var(--text-primary)", fontFamily: "JetBrains Mono, monospace", fontSize: "0.75rem" }}>
                {user.email}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>{user.name || "—"}</span>
              <span>
                {user.role === "admin"
                  ? <span style={{ color: "var(--accent)", fontSize: "0.75rem", fontFamily: "JetBrains Mono, monospace" }}>管理员</span>
                  : <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem", fontFamily: "JetBrains Mono, monospace" }}>业务员</span>
                }
              </span>
              <span>
                {user.hasApiKey && user.hasApiUrl
                  ? <span className="badge-success">已完整配置</span>
                  : user.hasApiKey && !user.hasApiUrl
                    ? <span className="badge-muted">仅 Key</span>
                    : <span className="badge-muted">未配置</span>
                }
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                  onClick={() => { setApiKeyInput(""); setApiUrlInput(user.apiUrl || ""); setImageModelInput(user.imageModel || ""); setImageApiTypeInput((user.imageApiType as any) || "openai-images"); setVideoModelInput(user.videoModel || ""); setModal({ type: "apikey", userId: user.id, userEmail: user.email, existingHasKey: user.hasApiKey }); }}
                >
                  Key
                </button>
                {user.role !== "admin" && (
                  <button
                    className="btn-danger"
                    onClick={() => setModal({ type: "delete", userId: user.id, userEmail: user.email })}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 模态框 */}
      {modal && createPortal(
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
          onClick={(e) => { if (e.target === e.currentTarget) { setModal(null); setError(""); } }}
        >
          <div
            style={{
              background: "var(--bg-overlay)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "28px",
              width: "calc(100% - 32px)",
              maxWidth: 440,
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            {modal.type === "create" && (
              <>
                <div style={{ borderBottom: "2px solid var(--accent)", paddingBottom: 12, marginBottom: 20 }}>
                  <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, color: "var(--accent)", margin: 0, fontSize: "1rem" }}>
                    创建业务员账户
                  </h3>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>EMAIL *</label>
                    <input className="input-field" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>NAME</label>
                    <input className="input-field" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="显示名称（可选）" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>PASSWORD *（最少8位）</label>
                    <input className="input-field" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" />
                  </div>
                  {error && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{error}</div>}
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                    <button className="btn-ghost" onClick={() => { setModal(null); setError(""); }} type="button">取消</button>
                    <button className="btn-primary" onClick={handleCreate} disabled={submitting || !newEmail || !newPassword} type="button">
                      {submitting ? "创建中..." : "创建"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {modal.type === "apikey" && (
              <>
                <div style={{ borderBottom: "2px solid var(--accent)", paddingBottom: 12, marginBottom: 20 }}>
                  <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, color: "var(--accent)", margin: 0, fontSize: "1rem" }}>
                    配置 API 中转站
                  </h3>
                  <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 4, marginBottom: 0 }}>{modal.userEmail}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>GEMINI API KEY *</label>
                    <input className="input-field" type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder={modal.existingHasKey ? "已配置，重新输入即覆盖" : "AIza..."} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>中转站 BASE URL *</label>
                    <input className="input-field" type="text" value={apiUrlInput} onChange={(e) => setApiUrlInput(e.target.value)} placeholder="https://your-proxy.example.com/v1beta" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>图片模型（可选）</label>
                    <input className="input-field" type="text" value={imageModelInput} onChange={(e) => setImageModelInput(e.target.value)} placeholder="gemini-2.0-flash-preview-image-generation" />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>图片接口类型</label>
                    <select
                      className="input-field"
                      value={imageApiTypeInput}
                      onChange={(e) => setImageApiTypeInput(e.target.value as any)}
                      style={{ cursor: "pointer" }}
                    >
                      <option value="openai-images">OpenAI Images（/v1/images/generations）</option>
                      <option value="gemini-native">Gemini Native（/v1beta/generateContent）</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "JetBrains Mono, monospace", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>视频模型（可选）</label>
                    <input className="input-field" type="text" value={videoModelInput} onChange={(e) => setVideoModelInput(e.target.value)} placeholder="veo-2.0-generate-001" />
                  </div>
                  {error && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{error}</div>}
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                    <button className="btn-ghost" onClick={() => { setModal(null); setError(""); setApiKeyInput(""); setApiUrlInput(""); setImageModelInput(""); setImageApiTypeInput("openai-images"); setVideoModelInput(""); }} type="button">取消</button>
                    <button className="btn-primary" onClick={handleSetApiKey} disabled={submitting || (!apiKeyInput && !modal.existingHasKey) || !apiUrlInput} type="button">
                      {submitting ? "保存中..." : "保存"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {modal.type === "delete" && (
              <>
                <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, color: "var(--error)", marginBottom: 12, fontSize: "1rem" }}>
                  确认删除
                </h3>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: 20 }}>
                  确定要删除账户 <strong style={{ color: "var(--text-primary)" }}>{modal.userEmail}</strong> 吗？此操作不可撤销，该用户的所有任务记录也将被删除。
                </p>
                {error && <div style={{ fontSize: "0.8rem", color: "var(--error)", marginBottom: 12 }}>{error}</div>}
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn-ghost" onClick={() => { setModal(null); setError(""); }} type="button">取消</button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={handleDelete}
                    style={{
                      background: "#ef4444",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "8px 16px",
                      fontSize: "0.875rem",
                      cursor: "pointer",
                      opacity: submitting ? 0.5 : 1,
                    }}
                  >
                    {submitting ? "删除中..." : "确认删除"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
