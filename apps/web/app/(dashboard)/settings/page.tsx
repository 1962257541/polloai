"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getRole } from "../../../lib/auth";
import SalespersonManage from "../../../components/SalespersonManage";
import ModelConfigManage from "../../../components/ModelConfigManage";

export default function SettingsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"accounts" | "models">("accounts");

  useEffect(() => {
    if (getRole() !== "admin") {
      router.replace("/image");
    }
  }, [router]);

  return (
    <div className="page-enter">
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "1.4rem", color: "var(--text-primary)", margin: 0 }}>
          系统设置
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "inherit", marginTop: 4 }}>
          SYSTEM SETTINGS / ADMIN ONLY
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setTab("accounts")}
          style={{
            color: tab === "accounts" ? "var(--accent)" : undefined,
            borderColor: tab === "accounts" ? "var(--border-focus)" : undefined,
            background: tab === "accounts" ? "var(--accent-glow)" : undefined,
          }}
        >
          账号配置
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setTab("models")}
          style={{
            color: tab === "models" ? "var(--accent)" : undefined,
            borderColor: tab === "models" ? "var(--border-focus)" : undefined,
            background: tab === "models" ? "var(--accent-glow)" : undefined,
          }}
        >
          模型配置
        </button>
      </div>

      {tab === "accounts" ? <SalespersonManage /> : <ModelConfigManage />}
    </div>
  );
}
