/**
 * GET /api/rooms
 * Lists all available rooms. Requires a valid API key.
 */
import { NextResponse } from 'next/server';
import { getAllRooms, getUserByApiKey, getVoicePresence } from '@/lib/db';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function GET(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');

  if (!callerKey) {
    await delay(500);
    return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  }

  const user = getUserByApiKey(callerKey);
  if (!user) {
    await delay(1000);
    return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });
  }

  const rooms = getAllRooms().map(r => ({
    name:      r.name,
    roomHash:  r.roomHash,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    type:      r.type || 'text',
    activeUsers: r.type === 'voice' ? getVoicePresence(r.roomHash) : undefined,
  }));

  return NextResponse.json({ rooms });
}
