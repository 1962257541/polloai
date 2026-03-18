import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "POLLO AI",
  description: "AI 图片与视频生成工具",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
