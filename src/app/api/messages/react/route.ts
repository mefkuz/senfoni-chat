import { NextResponse } from 'next/server';
import { getUserByApiKey, toggleReaction } from '@/lib/db';

export async function POST(req: Request) {
  try {
    const apiKey = req.headers.get('X-Caller-Key');
    if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
    const user = getUserByApiKey(apiKey);
    if (!user) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    const body = await req.json();
    const { roomHash, messageId, emoji } = body;
    if (!roomHash || !messageId || !emoji) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const success = toggleReaction(roomHash, messageId, user.username, emoji);
    if (!success) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
