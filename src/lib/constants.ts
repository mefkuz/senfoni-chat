/**
 * Senfoni Chat — Shared Constants
 * ================================
 */

// Moderator username
export const ADMIN_USERNAME = 'melodi';

// Session timeout: 24 hours
export const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Client-side message polling interval
export const POLLING_INTERVAL_MS = 1500;

// Max messages stored per room (in file)
export const MAX_MESSAGES_PER_ROOM = 500;

// App version
export const APP_VERSION = '6.0.0';

// ─── File Upload Limits ───────────────────────────────────────────────────────
// Max file size: 25 MB
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

// Allowed MIME types for upload
export const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
  // GIFs
  'image/gif',
  // Documents
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  // Archives
  'application/zip',
  'application/x-tar',
  'application/gzip',
  // Code
  'application/json',
  'application/xml',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  // Video
  'video/mp4', 'video/webm', 'video/ogg',
  // Other
  'application/octet-stream',
];

// Max files stored per room
export const MAX_FILES_PER_ROOM = 200;
