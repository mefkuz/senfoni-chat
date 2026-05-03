import { NextResponse } from 'next/server';
import {
  getUserByApiKey, getUserByName, getAllUsers,
  createUser, deleteUser, regenerateApiKey,
  getAllRooms, createRoom, deleteRoom,
  kickUser, unkickUser, muteUser, unmuteUser, isMuted,
} from '@/lib/db';
import { MELODI_API_KEY, ADMIN_USERNAME } from '@/lib/constants';
import crypto from 'crypto';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function hashRoomName(name: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('senfoni-room-' + name));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function POST(request: Request) {
  const masterKey = request.headers.get('X-Senfoni-Key');
  const callerKey = request.headers.get('X-Caller-Key');

  try {
    const body = await request.json();
    const { action, name, username, room, duration, reason } = body;

    if (action === 'check-user') {
      return NextResponse.json({ exists: !!getUserByName(name) });
    }

    if (action === 'list-rooms' && callerKey) {
      const caller = getUserByApiKey(callerKey);
      if (!caller) { await delay(1000); return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }
      const rooms = getAllRooms().map(r => ({ name: r.name, roomHash: r.roomHash, createdAt: r.createdAt, createdBy: r.createdBy, type: r.type || 'text' }));
      return NextResponse.json({ rooms });
    }

    // Admin-only below
    if (masterKey !== MELODI_API_KEY) {
      await delay(1000);
      return NextResponse.json({ error: 'ACCESS_DENIED' }, { status: 403 });
    }

    switch (action) {
      case 'create-user': {
        if (!name) return NextResponse.json({ error: 'Username required.' }, { status: 400 });
        if (name === ADMIN_USERNAME) return NextResponse.json({ error: 'Reserved.' }, { status: 400 });
        const r = createUser(name, ADMIN_USERNAME);
        if ('error' in r) return NextResponse.json({ error: r.error }, { status: 409 });
        return NextResponse.json({ success: true, message: `User [${name}] created.`, apiKey: r.apiKey });
      }
      case 'delete-user': {
        if (!name) return NextResponse.json({ error: 'Username required.' }, { status: 400 });
        if (!deleteUser(name)) return NextResponse.json({ error: `User [${name}] not found or protected.` }, { status: 404 });
        return NextResponse.json({ success: true, message: `User [${name}] deleted.` });
      }
      case 'gen-api': {
        if (!name) return NextResponse.json({ error: 'Username required.' }, { status: 400 });
        const r = regenerateApiKey(name);
        if ('error' in r) return NextResponse.json({ error: r.error }, { status: 404 });
        return NextResponse.json({ success: true, message: `New API key for [${name}].`, apiKey: r.apiKey });
      }
      case 'list-users': {
        const users = getAllUsers().map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt, createdBy: u.createdBy }));
        return NextResponse.json({ users });
      }
      case 'create-room': {
        if (!name) return NextResponse.json({ error: 'Room name required.' }, { status: 400 });
        const h = await hashRoomName(name);
        const r = createRoom(name, h, ADMIN_USERNAME, body.type === 'voice' ? 'voice' : 'text');
        if (r.error) return NextResponse.json({ error: r.error }, { status: 409 });
        return NextResponse.json({ success: true, message: `${body.type === 'voice' ? 'Voice Room' : 'Room'} [#${name}] created.` });
      }
      case 'delete-room': {
        if (!name) return NextResponse.json({ error: 'Room name required.' }, { status: 400 });
        const h = await hashRoomName(name);
        if (!deleteRoom(h)) return NextResponse.json({ error: `Room [#${name}] not found.` }, { status: 404 });
        return NextResponse.json({ success: true, message: `Room [#${name}] deleted.` });
      }
      case 'kick': {
        if (!username || !room) return NextResponse.json({ error: 'Username and room required.' }, { status: 400 });
        if (username === ADMIN_USERNAME) return NextResponse.json({ error: 'Cannot kick admin.' }, { status: 403 });
        const h = await hashRoomName(room);
        kickUser(h, username);
        return NextResponse.json({ success: true, message: `User [${username}] kicked from [#${room}].` });
      }
      case 'unkick': {
        if (!username || !room) return NextResponse.json({ error: 'Username and room required.' }, { status: 400 });
        const h = await hashRoomName(room);
        unkickUser(h, username);
        return NextResponse.json({ success: true, message: `User [${username}] unkicked from [#${room}].` });
      }
      case 'mute': {
        if (!username) return NextResponse.json({ error: 'Username required.' }, { status: 400 });
        if (username === ADMIN_USERNAME) return NextResponse.json({ error: 'Cannot mute admin.' }, { status: 403 });
        const dur = parseInt(duration) || 10;
        muteUser(username, dur, ADMIN_USERNAME, reason || 'No reason');
        return NextResponse.json({ success: true, message: `User [${username}] muted for ${dur} minutes.` });
      }
      case 'unmute': {
        if (!username) return NextResponse.json({ error: 'Username required.' }, { status: 400 });
        if (!unmuteUser(username)) return NextResponse.json({ error: `User [${username}] is not muted.` }, { status: 404 });
        return NextResponse.json({ success: true, message: `User [${username}] unmuted.` });
      }
      default:
        return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const masterKey = request.headers.get('X-Senfoni-Key');
  if (masterKey !== MELODI_API_KEY) {
    await delay(1000);
    return NextResponse.json({ error: 'ACCESS_DENIED' }, { status: 403 });
  }
  const users = getAllUsers().map(u => ({ username: u.username, role: u.role, apiKey: u.apiKey, createdAt: u.createdAt }));
  const rooms = getAllRooms();
  return NextResponse.json({ stats: { users: users.length, rooms: rooms.length }, users, rooms });
}
