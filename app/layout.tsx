import type React from "react"
import type { Metadata } from "next"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"
import { ErrorReporter, ConsoleReporter, ReactErrorBoundary } from "@/components/error-reporter"
import { AppAnalytics } from "@/components/app-analytics"

export const metadata: Metadata = {
  title: "INKWAVE · 墨浪对战",
  description: "和朋友一起加入 4v4 涂墨对战，创建房间、选择武器，争夺属于你们的地盘。",
  icons: "/favicon.ico",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">
        <ReactErrorBoundary>
          {children}
        </ReactErrorBoundary>
        <Toaster />
        <ErrorReporter />
        <ConsoleReporter />
        <AppAnalytics />
      </body>
    </html>
  );
}
