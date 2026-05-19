import { NextResponse } from 'next/server';
import { getUserByApiKey, getMessages, saveMessage, isMuted, isKicked, getTypingUsers } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const room = searchParams.get('room');
  const since = searchParams.get('since');
  if (!room) return NextResponse.json({ error: 'ROOM_REQUIRED' }, { status: 400 });
  const messages = getMessages(room);
  const filtered = since ? messages.filter(m => m.timestamp > Number(since)) : messages;
  
  const typingUsers = getTypingUsers(room);
  
  return NextResponse.json(filtered, {
    headers: {
      'X-Typing-Users': typingUsers.join(','),
      'Access-Control-Expose-Headers': 'X-Typing-Users' // Ensure the header is accessible in remote clients/browsers
    }
  });
}

export async function POST(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const user = getUserByApiKey(callerKey);
  if (!user) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  try {
    const { room, ciphertext, iv, sender } = await request.json();
    if (!room || !ciphertext || !iv || !sender) return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    if (sender !== user.username) return NextResponse.json({ error: 'SENDER_MISMATCH' }, { status: 403 });

    // Check mute
    const mute = isMuted(sender);
    if (mute) {
      const remaining = Math.ceil((mute.until - Date.now()) / 60000);
      return NextResponse.json({ error: `MUTED: ${remaining} min remaining. Reason: ${mute.reason}` }, { status: 403 });
    }

    // Check kick
    if (isKicked(room, sender)) {
      return NextResponse.json({ error: 'KICKED: You are banned from this room.' }, { status: 403 });
    }

    const msg = saveMessage({ room, ciphertext, iv, sender, timestamp: Date.now() });
    return NextResponse.json(msg);
  } catch {
    return NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 });
  }
}
