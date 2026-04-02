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
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "#F8FAFC" }}
    >
      {/* 背景装饰 */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div
          style={{
            position: "absolute",
            bottom: "-10%",
            right: "-5%",
            width: "500px",
            height: "500px",
            background: "radial-gradient(circle, rgba(37,99,235,0.05) 0%, transparent 70%)",
            borderRadius: "50%",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: "5%",
            left: "-5%",
            width: "400px",
            height: "400px",
            background: "radial-gradient(circle, rgba(37,99,235,0.03) 0%, transparent 70%)",
            borderRadius: "50%",
          }}
        />
      </div>

      <div className="w-full max-w-sm animate-fade-up">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mb-3 flex items-center justify-center gap-3">
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 12px rgba(37,99,235,0.3)",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <h1
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "#0F172A",
                letterSpacing: "-0.01em",
                margin: 0,
              }}
            >
              POLLO AI
            </h1>
          </div>
          <p style={{ color: "#94A3B8", fontSize: "0.8rem", margin: 0 }}>
            AI 创作平台
          </p>
        </div>

        {/* 登录卡片 */}
        <div
          style={{
            background: "#FFFFFF",
            border: "1px solid #E2E8F0",
            borderRadius: 16,
            padding: "32px",
            boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
          }}
        >
          <h2
            style={{
              fontWeight: 600,
              fontSize: "1.1rem",
              color: "#0F172A",
              marginBottom: 24,
              marginTop: 0,
            }}
          >
            欢迎回来
          </h2>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  color: "#475569",
                  marginBottom: 6,
                }}
              >
                邮箱
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
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  color: "#475569",
                  marginBottom: 6,
                }}
              >
                密码
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
                  background: "rgba(239,68,68,0.06)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 8,
                  padding: "10px 14px",
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
            color: "#94A3B8",
          }}
        >
          请联系管理员获取账号
        </p>
      </div>
    </div>
  );
}
