"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "../../components/Sidebar";
import { getToken, getUserEmail, getRole } from "../../lib/auth";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "salesperson">("salesperson");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    }
    setEmail(getUserEmail() ?? "");
    setRole((getRole() as "admin" | "salesperson") ?? "salesperson");
  }, [router]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#F8FAFC" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* 顶栏 Header */}
        <header
          style={{
            height: 56,
            flexShrink: 0,
            background: "#FFFFFF",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "0 24px",
            gap: 12,
          }}
        >
          {/* 用户邮箱 */}
          <span
            style={{
              fontSize: "0.8rem",
              color: "#94A3B8",
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {email}
          </span>

          {/* 角色 badge */}
          <span
            style={{
              fontSize: "0.7rem",
              fontWeight: 600,
              padding: "3px 10px",
              borderRadius: 12,
              background: role === "admin" ? "rgba(37,99,235,0.08)" : "#F1F5F9",
              color: role === "admin" ? "#2563EB" : "#94A3B8",
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            {role === "admin" ? "管理员" : "销售"}
          </span>
        </header>

        {/* 主内容区 */}
        <main
          style={{
            flex: 1,
            padding: "28px 32px",
            background: "#F8FAFC",
            minWidth: 0,
            overflowY: "auto",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
