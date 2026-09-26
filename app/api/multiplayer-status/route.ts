// Only probe the fixed first-party server; invitation URLs cannot choose a target.
export async function GET() {
  try {
    const response = await fetch('https://socket-server.app.teable.cn:8443/status', {
      next: { revalidate: 30 }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Status unavailable');
    const status = await response.json();
    if (status.ok !== true || typeof status.version !== 'string') throw new Error('Invalid status');
    return Response.json({ state: status.inkwaveProtocol === 1 ? 'ready' : 'pending' });
  } catch {
    return Response.json({ state: 'unknown' });
  }
}
