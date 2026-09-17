import type { Metadata } from "next";
import "./globals.css";
import NavBar from "@/components/dashboard/NavBar";

export const metadata: Metadata = {
  title: "採用ダッシュボード",
  description: "週次の応募状況モニタリングと求人要件ヒアリング",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
