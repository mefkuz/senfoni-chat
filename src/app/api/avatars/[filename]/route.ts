import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(req: Request, { params }: { params: Promise<{ filename: string }> }) {
  try {
    const filename = (await params).filename;
    const sanitizedFilename = path.basename(filename);
    const avatarsDir = path.join(process.cwd(), 'data', 'avatars');
    const filePath = path.join(avatarsDir, sanitizedFilename);

    if (!fs.existsSync(filePath)) {
      return new NextResponse(null, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    
    let contentType = 'image/png';
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (filename.endsWith('.gif')) contentType = 'image/gif';
    else if (filename.endsWith('.webp')) contentType = 'image/webp';

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (error) {
    return new NextResponse(null, { status: 500 });
  }
}
