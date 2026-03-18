"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { saveAuth, UserRole } from "../../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    try {
      setLoading(true);
      setError("");
      const result = await api.login(email, password);
      saveAuth(result.token, result.user.role as UserRole, result.user.email);

      if (result.user.role === "admin") {
        router.push("/settings");
      } else {
        router.push("/image");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen grid-bg flex items-center justify-center p-4"
      style={{ background: "var(--bg-base)" }}
    >
      {/* 背景射线装饰 */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden
      >
        <div
          style={{
            position: "absolute",
            bottom: "-20%",
            right: "-10%",
            width: "600px",
            height: "600px",
            background: "radial-gradient(circle, rgba(245,158,11,0.06) 0%, transparent 70%)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "10%",
            left: "-5%",
            width: "400px",
            height: "400px",
            background: "radial-gradient(circle, rgba(245,158,11,0.03) 0%, transparent 70%)",
            borderRadius: "50%",
          }}
        />
      </div>

      <div className="w-full max-w-sm animate-fade-up">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mb-2 flex items-center justify-center gap-2">
            <span
              style={{
                display: "inline-block",
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--accent)",
                clipPath: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)",
              }}
            />
            <h1
              className="text-2xl tracking-wide"
              style={{ fontFamily: "Syne, sans-serif", fontWeight: 800, color: "var(--accent)" }}
            >
              POLLO AI
            </h1>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "JetBrains Mono, monospace" }}>
            INTERNAL TOOL
          </p>
        </div>

        {/* 登录卡片 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "32px",
            backdropFilter: "blur(20px)",
          }}
        >
          <h2
            style={{
              fontFamily: "Syne, sans-serif",
              fontWeight: 700,
              fontSize: "1.1rem",
              color: "var(--text-primary)",
              marginBottom: 24,
            }}
          >
            登录
          </h2>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label
                style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 6, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em" }}
              >
                EMAIL
              </label>
              <input
                className="input-underline"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                autoComplete="email"
                required
              />
            </div>

            <div>
              <label
                style={{ display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 6, fontFamily: "JetBrains Mono, monospace", letterSpacing: "0.05em" }}
              >
                PASSWORD
              </label>
              <input
                className="input-underline"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <div
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: "0.8rem",
                  color: "#ef4444",
                }}
              >
                {error}
              </div>
            )}

            <button
              className="btn-primary"
              type="submit"
              disabled={loading || !email || !password}
              style={{ width: "100%", marginTop: 8 }}
            >
              {loading ? "登录中..." : "登录"}
            </button>
          </form>
        </div>

        <p
          style={{
            textAlign: "center",
            marginTop: 20,
            fontSize: "0.75rem",
            color: "var(--text-muted)",
            fontFamily: "JetBrains Mono, monospace",
          }}
        >
          内部工具 · 请联系管理员获取账号
        </p>
      </div>
    </div>
  );
}
