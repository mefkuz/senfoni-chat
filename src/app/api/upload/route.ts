/**
 * POST /api/upload
 * Receives E2EE encrypted file data and stores it server-side.
 * The file content is already encrypted client-side with the room key.
 * Server adds AEAD envelope encryption on top.
 */
import { NextResponse } from 'next/server';
import { getUserByApiKey, saveFile, saveMessage, isMuted, isKicked } from '@/lib/db';
import { MAX_FILE_SIZE_BYTES } from '@/lib/constants';

export async function POST(request: Request) {
  const callerKey = request.headers.get('X-Caller-Key');
  if (!callerKey) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
  const user = getUserByApiKey(callerKey);
  if (!user) return NextResponse.json({ error: 'INVALID_API_KEY' }, { status: 401 });

  try {
    const body = await request.json();
    const { room, encryptedData, encryptedIv, textCiphertext, textIv, fileName, fileType, fileSize, sender } = body;

    if (!room || !encryptedData || !encryptedIv || !fileName || !fileType || !sender) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }

    if (sender !== user.username) {
      return NextResponse.json({ error: 'SENDER_MISMATCH' }, { status: 403 });
    }

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

    // Validate file size (encrypted data is base64 so ~1.37x original)
    const estimatedOriginalSize = Math.ceil(encryptedData.length * 0.75);
    if (estimatedOriginalSize > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ error: `FILE_TOO_LARGE: Max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` }, { status: 413 });
    }

    // Save the encrypted file blob
    const fileRecord = saveFile({
      room,
      sender,
      fileName,
      fileType,
      fileSize: fileSize || estimatedOriginalSize,
      encryptedData,
      encryptedIv,
      timestamp: Date.now(),
    });

    // Save a message record referencing the file so it shows in chat history
    const msg = saveMessage({
      room,
      ciphertext: textCiphertext || encryptedData, // Fallback for old clients
      iv: textIv || encryptedIv,
      sender,
      timestamp: Date.now(),
      fileId: fileRecord.id,
      fileName,
      fileType,
      fileSize: fileSize || estimatedOriginalSize,
    });

    return NextResponse.json({
      success: true,
      fileId: fileRecord.id,
      messageId: msg.id,
    });
  } catch {
    return NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 });
  }
}
