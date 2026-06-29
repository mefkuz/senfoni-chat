/**
 * POST /api/auth
 * Validates an API key and returns user info.
 */
import { NextResponse } from 'next/server';
import { getUserByApiKey, getAllRooms } from '@/lib/db';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function POST(request: Request) {
  try {
    const { apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== 'string') {
      await delay(1000);
      return NextResponse.json({ valid: false, error: 'API_KEY_REQUIRED' }, { status: 400 });
    }

    const user = getUserByApiKey(apiKey.trim());

    if (!user) {
      await delay(1000); // brute-force protection
      return NextResponse.json({ valid: false, error: 'INVALID_API_KEY' }, { status: 401 });
    }

    // Auto-populate all keys for all users
    const roomKeys = { ...(user.roomKeys || {}) };
    const rooms = getAllRooms();
    for (const r of rooms) {
      if (r.roomKey) {
        roomKeys[r.name] = r.roomKey;
      }
    }

    return NextResponse.json({
      valid: true,
      username: user.username,
      role: user.role,
      lastRoom: user.lastRoom,
      lastRoomKey: user.lastRoomKey,
      roomKeys
    });
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
}
