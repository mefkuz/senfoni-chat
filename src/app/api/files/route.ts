/**
 * GET /api/files?room=hash&id=fileId
 * Returns the E2EE encrypted file data for client-side decryption.
 */
import { NextResponse } from 'next/server';
import { getUserByApiKey, getFile } from '@/lib/db';

export async function GET(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const user = getUserByApiKey(callerKey);
  if (!user) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const room = searchParams.get('room');
  const fileId = searchParams.get('id');

  if (!room || !fileId) {
    return NextResponse.json({ error: 'MISSING_PARAMS: room and id required' }, { status: 400 });
  }

  try {
    const file = getFile(room, fileId);
    if (!file) {
      return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 });
    }

    return NextResponse.json({
      id: file.id,
      fileName: file.fileName,
      fileType: file.fileType,
      fileSize: file.fileSize,
      encryptedData: file.encryptedData,
      encryptedIv: file.encryptedIv,
      sender: file.sender,
      timestamp: file.timestamp,
    });
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
}
