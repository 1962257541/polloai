"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getRole } from "../../../lib/auth";
import SalespersonManage from "../../../components/SalespersonManage";

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    if (getRole() !== "admin") {
      router.replace("/image");
    }
  }, [router]);

  return (
    <div className="page-enter">
      {/* 页面标题 */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: "1.4rem", color: "var(--text-primary)", margin: 0 }}>
          系统设置
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "JetBrains Mono, monospace", marginTop: 4 }}>
          SYSTEM SETTINGS · ADMIN ONLY
        </p>
      </div>

      <SalespersonManage />
    </div>
  );
}
