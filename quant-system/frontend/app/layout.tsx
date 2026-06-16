import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A股量化选股系统",
  description: "趋势突破股票池 Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
