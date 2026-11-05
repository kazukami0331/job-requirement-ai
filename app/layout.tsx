import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "採用モニタリング",
  description: "ジョブオプの応募エクスポートから、週次の応募状況と校舎ごとの充足状況を見る",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
