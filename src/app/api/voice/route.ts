/**
 * /api/voice — WebRTC Signaling Endpoint
 * GET  ?room=hash&since=timestamp — poll for signaling messages
 * POST {room, sender, type, target?, data} — send signaling message
 */
import { NextResponse } from 'next/server';
import { getUserByApiKey, getVoiceSignals, saveVoiceSignal, updateVoicePresence, removeVoicePresence } from '@/lib/db';

export async function GET(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const authUser = getUserByApiKey(callerKey);
  if (!authUser) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const room  = searchParams.get('room');
  const since = searchParams.get('since');
  const user  = searchParams.get('user');

  if (!room) return NextResponse.json({ error: 'ROOM_REQUIRED' }, { status: 400 });

  if (user && user === authUser.username) {
    try { updateVoicePresence(room, user); } catch {}
  }

  try {
    const signals = getVoiceSignals(room, Number(since || 0));
    return NextResponse.json(signals);
  } catch {
    return NextResponse.json({ error: 'INVALID_ROOM' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const user = getUserByApiKey(callerKey);
  if (!user) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  try {
    const { room, type, target, data } = await request.json();
    if (!room || !type || !data) return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    
    if (type === 'leave') {
      removeVoicePresence(room, user.username);
    }
    
    const signal = saveVoiceSignal({ room, sender: user.username, type, target, data, timestamp: Date.now() });
    return NextResponse.json(signal);
  } catch {
    return NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 });
  }
}
