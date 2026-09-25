"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [src, setSrc] = useState<string>();
  useEffect(() => { setSrc(`/game/index.html${window.location.search}${window.location.hash}`); }, []);
  return <main className="fixed inset-0 bg-[#0d1020]">
    {src && <iframe src={src} title="INKWAVE · 墨浪对战" className="h-full w-full border-0" allow="fullscreen; autoplay; clipboard-write" allowFullScreen />}
  </main>;
}
