import { NextResponse } from 'next/server';
import { getUserByApiKey, getAllUsers, updateAvatar } from '@/lib/db';
import fs from 'fs';
import path from 'path';

export async function POST(req: Request) {
  try {
    const apiKey = req.headers.get('X-Caller-Key');
    if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
    const user = getUserByApiKey(apiKey);
    if (!user) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Ensure public/avatars exists
    const avatarsDir = path.join(process.cwd(), 'public', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    
    const ext = file.name.split('.').pop() || 'png';
    const fileName = `${user.username}_${Date.now()}.${ext}`;
    const filePath = path.join(avatarsDir, fileName);
    
    fs.writeFileSync(filePath, buffer);
    
    const avatarUrl = `/avatars/${fileName}`;
    updateAvatar(user.username, avatarUrl);
    
    return NextResponse.json({ success: true, avatarUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const apiKey = req.headers.get('X-Caller-Key');
    if (!apiKey || !getUserByApiKey(apiKey)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const users = getAllUsers();
    const avatars: Record<string, string> = {};
    users.forEach(u => {
      if (u.avatar) avatars[u.username] = u.avatar;
    });
    
    return NextResponse.json({ avatars });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const apiKey = req.headers.get('X-Caller-Key');
    if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
    const user = getUserByApiKey(apiKey);
    if (!user) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    updateAvatar(user.username, '');
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
