"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [src, setSrc] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [metrics, setMetrics] = useState<{ fps: number; ping: number | null; queued: number; fast: boolean; server: boolean; host: boolean } | null>(null);
  useEffect(() => {
    setSrc(`/game/index.html${window.location.search}${window.location.hash}`);
    const receive = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.type !== 'inkwave-metrics') return;
      setMetrics(e.data.active ? e.data : null);
    };
    addEventListener('message', receive);
    return () => removeEventListener('message', receive);
  }, []);
  return <main className="fixed inset-0 bg-[#0d1020]">
    {src && <iframe ref={frame} src={src} title="INKWAVE · 墨浪对战" className="h-full w-full border-0" allow="fullscreen; autoplay; clipboard-write" allowFullScreen />}
    {metrics && <div className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-lg border border-white/15 bg-slate-950/85 px-3 py-2 text-xs text-white shadow-lg" aria-live="polite">
      <div className="flex gap-3 font-mono"><span className={metrics.fps < 40 ? 'text-amber-300' : 'text-emerald-300'}>{metrics.fps} FPS</span><span>{metrics.ping == null ? '等待玩家' : `${metrics.ping} ms`}</span><span>{metrics.server ? 'WSS 专用服务器' : metrics.fast ? '独立实时通道' : '兼容通道'}{metrics.host ? ' · 房主' : ''}</span></div>
      {(metrics.fps < 40 || (metrics.ping ?? 0) > 150 || metrics.queued > 16) && <div className="mt-1 text-amber-200">{metrics.fps < 40 ? '画面帧率偏低，可在设置中降低画质。' : metrics.queued > 16 ? '网络拥堵，正在合并过期位置。' : '网络延迟偏高，可尝试同一网络。'}</div>}
    </div>}
  </main>;
}
