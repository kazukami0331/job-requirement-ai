import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 画面は `/dashboard` だけになったので、`/` を開いてもそこへ送る。
   * ブックマークや共有済みのURLを生かすため。
   * 恒久リダイレクト(308)にするとブラウザに焼き付いて戻せなくなるので一時(307)にしておく。
   */
  async redirects() {
    return [{ source: "/", destination: "/dashboard", permanent: false }];
  },
};

export default nextConfig;
