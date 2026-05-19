import { NextResponse } from 'next/server';
import { getUserByApiKey, updateTypingStatus } from '@/lib/db';

export async function POST(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const user = getUserByApiKey(callerKey);
  if (!user) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  try {
    const { room, username, isTyping } = await request.json();
    if (!room || !username || typeof isTyping !== 'boolean') {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }
    if (username !== user.username) {
      return NextResponse.json({ error: 'USERNAME_MISMATCH' }, { status: 403 });
    }

    updateTypingStatus(room, username, isTyping);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 });
  }
}
