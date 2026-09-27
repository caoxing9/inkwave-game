"use client";

import { useEffect, useRef, useState } from "react";

// Overlay text follows the in-game language toggle (reported with each metrics message).
const TEXT = {
  en: { waiting: 'Waiting for players', server: 'WSS dedicated server', fast: 'Dedicated realtime channel', compat: 'Compatibility channel', host: 'Host', lowFps: 'Low frame rate. Try lowering graphics quality in Settings.', congested: 'Network congested, merging stale positions.', highPing: 'High network latency. Try playing on the same network.' },
  zh: { waiting: '等待玩家', server: 'WSS 专用服务器', fast: '独立实时通道', compat: '兼容通道', host: '房主', lowFps: '画面帧率偏低，可在设置中降低画质。', congested: '网络拥堵，正在合并过期位置。', highPing: '网络延迟偏高，可尝试同一网络。' },
};

export default function Home() {
  const [src, setSrc] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [metrics, setMetrics] = useState<{ fps: number; ping: number | null; queued: number; fast: boolean; server: boolean; host: boolean; lang?: string } | null>(null);
  useEffect(() => {
    setSrc(`/game/index.html${window.location.search}${window.location.hash}`);
    const receive = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'inkwave-invite' && typeof e.data.search === 'string') {
        const next = new URLSearchParams(e.data.search);
        const url = new URL(location.href);
        for (const key of ['mode', 'room', 'server', 'key', 'lobby']) {
          url.searchParams.delete(key);
          if (next.has(key)) url.searchParams.set(key, next.get(key)!);
        }
        url.hash = '';
        history.replaceState(null, '', url.pathname + url.search);
        return;
      }
      if (e.data?.type !== 'inkwave-metrics') return;
      setMetrics(e.data.active ? e.data : null);
    };
    addEventListener('message', receive);
    return () => removeEventListener('message', receive);
  }, []);
  const t = TEXT[metrics?.lang === 'zh' ? 'zh' : 'en'];
  return <main className="fixed inset-0 bg-[#0d1020]">
    {src && <iframe ref={frame} src={src} title="INKWAVE · Turf War" className="h-full w-full border-0" allow="fullscreen; autoplay; clipboard-write" allowFullScreen />}
    {metrics && <div className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-lg border border-white/15 bg-slate-950/85 px-3 py-2 text-xs text-white shadow-lg" aria-live="polite">
      <div className="flex gap-3 font-mono"><span className={metrics.fps < 40 ? 'text-amber-300' : 'text-emerald-300'}>{metrics.fps} FPS</span><span>{metrics.ping == null ? t.waiting : `${metrics.ping} ms`}</span><span>{metrics.server ? t.server : metrics.fast ? t.fast : t.compat}{metrics.host ? ` · ${t.host}` : ''}</span></div>
      {(metrics.fps < 40 || (metrics.ping ?? 0) > 150 || metrics.queued > 16) && <div className="mt-1 text-amber-200">{metrics.fps < 40 ? t.lowFps : metrics.queued > 16 ? t.congested : t.highPing}</div>}
    </div>}
  </main>;
}
