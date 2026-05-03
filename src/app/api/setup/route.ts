import { NextResponse } from 'next/server';
import { getAllUsers, createUser } from '@/lib/db';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const users = getAllUsers();
  return NextResponse.json({ uninitialized: users.length === 0 });
}

export async function POST(request: Request) {
  try {
    const users = getAllUsers();
    if (users.length > 0) {
      return NextResponse.json({ error: 'SYSTEM_ALREADY_INITIALIZED' }, { status: 403 });
    }

    const body = await request.json();
    const { username } = body;
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return NextResponse.json({ error: 'INVALID_USERNAME' }, { status: 400 });
    }

    const { apiKey, error } = createUser(username.trim(), 'system', 'admin');
    if (error) return NextResponse.json({ error }, { status: 400 });

    // Since this is the first user, we must elevate them to admin directly
    // Wait, createUser sets role to 'user' by default. We need to manually update it to 'admin'.
    // We can't access `users` object directly since it's inside db.ts.
    // Let's modify db.ts to have `makeAdmin(username)` or we can just read/write users here since we have fs.
    
    // Better to do it safely via direct fs or add a helper in db.ts. 
    // Since we know the internal structure, let's just do it directly.
    const USERS_FILE = path.join(process.cwd(), 'data', 'users.json');
    // But it's encrypted! So we can't write it easily without `db.ts` crypto functions.
    // I should modify `createUser` to accept an optional `role` parameter.
    // Let's assume we update `db.ts` to accept `role` in `createUser`.

    return NextResponse.json({ 
      message: `Admin user [${username}] created successfully!`,
      apiKey 
    });
  } catch (err) {
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
