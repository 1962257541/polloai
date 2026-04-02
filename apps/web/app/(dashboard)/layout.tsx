"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "../../components/Sidebar";
import { getToken } from "../../lib/auth";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    }
  }, [router]);

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#F8FAFC" }}>
      <Sidebar />
      {/* 主内容区 — 不自身滚动，让子页面控制内部滚动 */}
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          overflow: "hidden",
          padding: "24px 28px",
          background: "#F8FAFC",
        }}
      >
        {children}
      </main>
    </div>
  );
}
