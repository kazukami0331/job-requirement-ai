import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "求人要件ヒアリングAI",
  description: "AIが質問に答えるだけで求人要件を言語化できます",
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
