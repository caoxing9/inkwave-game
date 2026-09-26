// Invitation routing is shared by the lobby and its tests. A WSS invite never
// silently changes room systems, even while the dedicated server is unavailable.
export const DEFAULT_SERVER = 'socket-server.app.teable.cn:8443';
export function readInvite(url = new URL(location.href)) {
  const q = url.searchParams;
  const legacyRoom = new URLSearchParams(url.hash.slice(1)).get('room') || '';
  const requested = q.get('mode');
  const mode = ['public', 'wss', 'local'].includes(requested) ? requested
    : q.has('server') || q.has('key') ? 'wss'
    : q.get('room') || legacyRoom ? 'public' : null;
  return { mode, room: q.get('room') || legacyRoom, server: q.get('server') || DEFAULT_SERVER, key: q.get('key') || '', open: q.get('lobby') === '1' || !!(q.get('room') || legacyRoom) };
}
export function inviteUrl(base, mode, room = '', server = DEFAULT_SERVER, key = '') {
  const url = new URL(base);
  for (const k of ['mode', 'room', 'server', 'key', 'lobby']) url.searchParams.delete(k);
  url.hash = '';
  url.searchParams.set('mode', mode);
  url.searchParams.set('lobby', '1');
  if (room) url.searchParams.set('room', room);
  if (mode === 'wss') { url.searchParams.set('server', server); if (room && key) url.searchParams.set('key', key); }
  return url;
}
