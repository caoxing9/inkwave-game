import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_MEMBERS = 10;

// ---------------------------------------------------------------------------------------------- rooms
/** code → { code, host, members[], signals[], seq, started, updated, settings, relay:Set, packets[], packetSeq, lastPacket{} } */
const rooms = globalThis.inkwaveRooms ??= new Map();

const cleanName = (v) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, 16) : '');
const WEAPONS = new Set(['shooter', 'roller', 'charger', 'blaster']);
const publicRoom = (r) => ({
  code: r.code, host: r.host, started: r.started, settings: r.settings, relayMembers: [...r.relay],
  members: r.members.map(({ id, name, team, weapon }) => ({ id, name, team, weapon })),
});

function cleanup() {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const hostAlive = r.members.some((m) => m.id === r.host && now - m.seen < 10000);
    if (now - r.updated > 30 * 60000 || !hostAlive) { rooms.delete(code); continue; }
    r.members = r.members.filter((m) => now - m.seen < 10000);
  }
}
function auth(r, id, token) {
  return r.members.find((m) => m.id === id && m.token.length === token.length && timingSafeEqual(Buffer.from(m.token), Buffer.from(token)));
}
function balancedTeam(r) {
  const a = r.members.filter((m) => m.team === 0).length, b = r.members.filter((m) => m.team === 1).length;
  return a <= b ? 0 : 1;
}

function handleRooms(body) {
  cleanup();
  const b = body || {};
  if (b.action === 'create' || b.action === 'join') {
    const name = cleanName(b.name);
    if (!name) return [400, { error: 'Please enter a nickname' }];
    const member = { id: randomUUID(), token: randomBytes(24).toString('hex'), name, team: 0, weapon: WEAPONS.has(b.weapon) ? b.weapon : 'shooter', seen: Date.now() };
    let room;
    if (b.action === 'create') {
      if (rooms.size >= 100) return [429, { error: 'Too many rooms right now. Please try again later' }];
      let code;
      do { code = randomBytes(2).toString('hex').toUpperCase(); } while (rooms.has(code));
      room = { code, host: member.id, members: [member], signals: [], seq: 0, started: false, updated: Date.now(),
        settings: { mapId: 'tidewater', duration: 180, difficulty: 'normal' }, relay: new Set(), packets: [], packetSeq: 0, lastPacket: {} };
      rooms.set(code, room);
    } else {
      room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) return [404, { error: 'Room not found or closed. Check the room code' }];
      if (room.started) return [409, { error: 'The match has already started. Please wait for it to end' }];
      if (room.members.length >= MAX_MEMBERS) return [409, { error: `The room is full (${MAX_MEMBERS} players)` }];
      member.team = balancedTeam(room);
      room.members.push(member);
    }
    room.updated = Date.now();
    return [200, { room: publicRoom(room), id: member.id, token: member.token }];
  }

  const room = rooms.get(String(b.code || ''));
  if (!room) return [404, { error: 'The room is closed. Go back to the lobby and create a new one' }];
  const me = auth(room, String(b.id || ''), String(b.token || ''));
  if (!me) return [403, { error: 'Your room session has expired' }];
  me.seen = room.updated = Date.now();
  const isHost = me.id === room.host;

  switch (b.action) {
    case 'poll': break;
    case 'signal': {
      // star topology: host ↔ each member only
      if (!room.members.some((m) => m.id === b.to) || (!isHost && b.to !== room.host)) return [400, { error: 'Invalid connection target' }];
      room.signals.push({ seq: ++room.seq, from: me.id, to: b.to, data: b.data });
      if (room.signals.length > 1024) room.signals = room.signals.slice(-1024);
      break;
    }
    case 'fallback': {
      const target = isHost ? b.to : me.id;
      if (target === room.host || !room.members.some((m) => m.id === target)) return [400, { error: 'Invalid relay target' }];
      room.relay.add(target);
      break;
    }
    case 'profile': {
      if (b.name) me.name = cleanName(b.name) || me.name;
      if (WEAPONS.has(b.weapon)) me.weapon = b.weapon;
      if (b.team === 0 || b.team === 1) {
        if (room.members.filter((m) => m.team === b.team && m !== me).length >= 5) return [409, { error: 'That team is full (5 players)' }];
        me.team = b.team;
      }
      break;
    }
    case 'settings': {
      if (!isHost) return [403, { error: 'Only the host can change match settings' }];
      const s = b.settings || {};
      if (typeof s.mapId === 'string') room.settings.mapId = s.mapId.slice(0, 32);
      if ([90, 180].includes(s.duration)) room.settings.duration = s.duration;
      if (['easy', 'normal', 'hard'].includes(s.difficulty)) room.settings.difficulty = s.difficulty;
      break;
    }
    case 'start': if (!isHost) return [403, { error: 'Only the host can start the match' }]; room.started = true; break;
    case 'end': if (isHost) room.started = false; break;
    case 'leave':
      if (isHost) rooms.delete(room.code);
      else { room.members = room.members.filter((m) => m.id !== me.id); room.relay.delete(me.id); }
      return [200, { ok: true }];
    default: return [400, { error: 'Unknown action' }];
  }

  // ---- HTTP fallback relay: clients submit packets for (or via) the host with each poll, and fetch their own packets on the next poll
  if (b.action === 'poll') {
    const incoming = Array.isArray(b.packets) ? b.packets : [];
    if (incoming.length > 64) return [400, { error: 'Too many relay messages' }];
    const since = Number(b.packetSince) || 0;
    const now = Date.now();
    room.packets = room.packets.filter((p) => now - p.at < 30000 && !(p.to === me.id && p.seq <= since));
    for (const p of incoming) {
      if (!Number.isSafeInteger(p?.id) || p.id <= (room.lastPacket[me.id] || 0)) continue;   // dedupe retries
      room.lastPacket[me.id] = p.id;
      const peer = isHost ? p.to : me.id;
      if (typeof p.to !== 'string' || (!isHost && p.to !== room.host) || !room.relay.has(peer)) continue;
      if (!room.members.some((m) => m.id === p.to)) continue;
      room.packets.push({ seq: ++room.packetSeq, from: me.id, to: p.to, data: p.data, at: now });
    }
    if (room.packets.length > 4096) room.packets = room.packets.slice(-4096);
  }
  const packets = room.packets.filter((p) => p.to === me.id && p.seq > (Number(b.packetSince) || 0)).slice(0, 128);
  return [200, {
    room: publicRoom(room), seq: room.seq,
    signals: room.signals.filter((s) => s.to === me.id && s.seq > (Number(b.since) || 0)),
    packets, packetSeq: packets.length ? packets[packets.length - 1].seq : Number(b.packetSince) || 0,
  }];
}


function localOnly(req) {
  const host = (req.headers.get('host') || new URL(req.url).host).split(':')[0];
  return process.env.NODE_ENV !== 'production' && (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.'));
}
export async function GET(req) {
  return Response.json({ multiplayer: localOnly(req), mode: localOnly(req) ? 'lan-server' : 'public-peer' }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(req) {
  if (!localOnly(req)) return Response.json({ error: 'The public site uses free direct signaling. Download the LAN version for server relay.' }, { status: 503 });
  try {
    const raw = await req.text();
    if (raw.length > 200000) return Response.json({ error: 'Request too large' }, { status: 413 });
    const [status, data] = handleRooms(JSON.parse(raw));
    return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Invalid request format' }, { status: 400 }); }
}
