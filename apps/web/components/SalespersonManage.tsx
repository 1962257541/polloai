"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiProvider, SalespersonInfo } from "../lib/api";
import { getToken } from "../lib/auth";

interface ModalState {
  type: "create" | "apikey" | "delete";
  userId?: string;
  userEmail?: string;
  existingHasKey?: boolean;
}

export default function SalespersonManage() {
  const [list, setList] = useState<SalespersonInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [error, setError] = useState("");

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiUrlInput, setApiUrlInput] = useState("");
  const [apiProviderInput, setApiProviderInput] = useState<ApiProvider>("yunwu");
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

  useEffect(() => {
    void load();
  }, [load]);

  const resetModalState = () => {
    setModal(null);
    setError("");
    setApiKeyInput("");
    setApiUrlInput("");
    setApiProviderInput("yunwu");
  };

  const handleCreate = async () => {
    const token = getToken();
    if (!token || !newEmail || !newPassword) return;

    try {
      setSubmitting(true);
      setError("");
      await api.createSalesperson(token, {
        email: newEmail,
        name: newName || undefined,
        password: newPassword,
      });
      setModal(null);
      setNewEmail("");
      setNewName("");
      setNewPassword("");
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
      await api.updateSalespersonApiConfig(token, modal.userId, apiKeyInput || undefined, apiUrlInput, apiProviderInput);
      resetModalState();
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.95rem", color: "var(--text-primary)", margin: 0 }}>
          账号管理
        </h3>
        <button className="btn-ghost" onClick={() => setModal({ type: "create" })} style={{ fontSize: "0.8rem" }}>
          + 创建账号
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
            gridTemplateColumns: "1fr 1fr 90px 120px 180px",
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
          <span>ROLE</span>
          <span>API</span>
          <span>ACTIONS</span>
        </div>

        {loading ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            加载中...
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            暂无可用账号
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
              }}
            >
              <span style={{ color: "var(--text-primary)", fontFamily: "inherit", fontSize: "0.75rem" }}>
                {user.email}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>{user.name || "-"}</span>
              <span style={{ color: user.role === "admin" ? "var(--accent)" : "var(--text-secondary)" }}>
                {user.role === "admin" ? "管理员" : "业务员"}
              </span>
              <span>
                {user.hasApiKey && user.hasApiUrl ? (
                  <span className="badge-success">已配置</span>
                ) : user.hasApiKey ? (
                  <span className="badge-muted">仅 Key</span>
                ) : (
                  <span className="badge-muted">未配置</span>
                )}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                  onClick={() => {
                    setApiKeyInput("");
                    setApiUrlInput(user.apiUrl || "");
                    setApiProviderInput(user.apiProvider || "yunwu");
                    setModal({
                      type: "apikey",
                      userId: user.id,
                      userEmail: user.email,
                      existingHasKey: user.hasApiKey,
                    });
                  }}
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
                resetModalState();
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
                maxWidth: 440,
                maxHeight: "90vh",
                overflowY: "auto",
              }}
            >
              {modal.type === "create" && (
                <>
                  <div style={{ borderBottom: "2px solid var(--accent)", paddingBottom: 12, marginBottom: 20 }}>
                    <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "var(--accent)", margin: 0, fontSize: "1rem" }}>
                      创建业务员账号
                    </h3>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        EMAIL *
                      </label>
                      <input className="input-field" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        NAME
                      </label>
                      <input className="input-field" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="显示名称（可选）" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        PASSWORD *
                      </label>
                      <input className="input-field" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 8 位" />
                    </div>
                    {error && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{error}</div>}
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <button className="btn-ghost" onClick={resetModalState} type="button">
                        取消
                      </button>
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
                    <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "var(--accent)", margin: 0, fontSize: "1rem" }}>
                      配置 API 中转站
                    </h3>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 4, marginBottom: 0 }}>
                      {modal.userEmail}
                    </p>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        中转站供应商 *
                      </label>
                      <select
                        className="input-field"
                        value={apiProviderInput}
                        onChange={(e) => setApiProviderInput(e.target.value as ApiProvider)}
                      >
                        <option value="yunwu">yunwu（同步图片 / create-query 视频）</option>
                        <option value="apimart">apib.ai（APIMart 异步任务制）</option>
                        <option value="doubao">doubao（自部署反代，豆包 Seedance 视频）</option>
                        <option value="qichen">七辰 API（gpt-image-2 / sd2 / veo-omni-flash）</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        API KEY *
                      </label>
                      <input
                        className="input-field"
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={modal.existingHasKey ? "已配置，重新输入即覆盖" : "sk-..."}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.7rem", fontFamily: "inherit", color: "var(--text-muted)", marginBottom: 6, letterSpacing: "0.05em" }}>
                        BASE URL *
                      </label>
                      <input
                        className="input-field"
                        type="text"
                        value={apiUrlInput}
                        onChange={(e) => setApiUrlInput(e.target.value)}
                        placeholder={
                          apiProviderInput === "apimart"
                            ? "https://api.apib.ai/v1"
                            : apiProviderInput === "doubao"
                              ? "http://doubao-2api:8088"
                              : apiProviderInput === "qichen"
                                ? "https://api.qichen001.asia/v1"
                                : "https://your-proxy.example.com/v1beta"
                        }
                      />
                      <p style={{ margin: "6px 0 0", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        {apiProviderInput === "apimart"
                          ? "apib.ai 请填 https://api.apib.ai/v1，图片/视频走异步任务制"
                          : apiProviderInput === "doubao"
                            ? "豆包反代填服务地址（例如 http://doubao-2api:8088）；API KEY 填该服务的 API_MASTER_KEY；仅支持视频"
                            : apiProviderInput === "qichen"
                              ? "七辰 API 填 https://api.qichen001.asia/v1；图片模型 gpt-image-2，视频模型 sd2 或 veo-omni-flash"
                              : "yunwu 等保持原有地址格式"}
                      </p>
                    </div>
                    {error && <div style={{ fontSize: "0.8rem", color: "var(--error)" }}>{error}</div>}
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <button className="btn-ghost" onClick={resetModalState} type="button">
                        取消
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleSetApiKey}
                        disabled={submitting || (!apiKeyInput && !modal.existingHasKey) || !apiUrlInput}
                        type="button"
                      >
                        {submitting ? "保存中..." : "保存"}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {modal.type === "delete" && (
                <>
                  <h3 style={{ fontFamily: "inherit", fontWeight: 700, color: "var(--error)", marginBottom: 12, fontSize: "1rem" }}>
                    确认删除
                  </h3>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: 20 }}>
                    确定要删除账号 <strong style={{ color: "var(--text-primary)" }}>{modal.userEmail}</strong> 吗？该操作不可撤销。
                  </p>
                  {error && <div style={{ fontSize: "0.8rem", color: "var(--error)", marginBottom: 12 }}>{error}</div>}
                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <button className="btn-ghost" onClick={() => setModal(null)} type="button">
                      取消
                    </button>
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
          document.body,
        )}
    </div>
  );
}
