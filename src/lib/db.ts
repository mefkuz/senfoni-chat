/**
 * Senfoni Chat — File-Based Persistence Layer (db.ts)
 * =====================================================
 * data/users.json, data/rooms.json, data/messages/*.json,
 * data/kicks.json, data/mutes.json, data/voice/*.json,
 * data/files/*.enc (encrypted file blobs)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ADMIN_USERNAME, MAX_MESSAGES_PER_ROOM, MAX_FILES_PER_ROOM } from './constants';

const DATA_DIR     = path.join(process.cwd(), 'data');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const ROOMS_FILE   = path.join(DATA_DIR, 'rooms.json');
const KICKS_FILE   = path.join(DATA_DIR, 'kicks.json');
const MUTES_FILE   = path.join(DATA_DIR, 'mutes.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const VOICE_DIR    = path.join(DATA_DIR, 'voice');
const FILES_DIR    = path.join(DATA_DIR, 'files');
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');

const SERVER_KEY_FILE = path.join(DATA_DIR, 'server.key');

// ─── Cryptography (Server-Side Encryption) ────────────────────────────────────

function getServerKey(): Buffer {
  if (fs.existsSync(SERVER_KEY_FILE)) {
    return fs.readFileSync(SERVER_KEY_FILE);
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SERVER_KEY_FILE, key);
  return key;
}

const ENC_KEY = getServerKey();

function encryptData(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted, tag: authTag });
}

function decryptData(encStr: string): string {
  try {
    const parsed = JSON.parse(encStr);
    if (!parsed.iv || !parsed.data || !parsed.tag) return encStr; // legacy plaintext
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(parsed.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
    let decrypted = decipher.update(parsed.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return encStr; // legacy plaintext
  }
}

function validateHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid room hash');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserRecord {
  username: string; apiKey: string; role: 'admin' | 'user';
  createdAt: number; createdBy: string;
}
export interface RoomRecord {
  name: string; roomHash: string; createdAt: number; createdBy: string; type?: 'text' | 'voice';
}
export interface MessageRecord {
  id: string; room: string; ciphertext: string; iv: string;
  sender: string; timestamp: number;
  // File attachment metadata (client-encrypted payload is in ciphertext/iv)
  fileId?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
}
export interface MuteRecord {
  username: string; until: number; by: string; reason: string;
}
export interface VoiceSignal {
  id: string; room: string; sender: string; type: 'offer' | 'answer' | 'candidate' | 'leave' | 'heartbeat';
  target?: string; data: string; timestamp: number;
}
export interface VoicePresence {
  [roomHash: string]: { [username: string]: number };
}

export interface FileRecord {
  id: string;
  room: string;
  sender: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  encryptedData: string;  // Client-side E2EE encrypted base64 data
  encryptedIv: string;    // Client-side E2EE IV
  timestamp: number;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function ensureDataDir(): void {
  [DATA_DIR, MESSAGES_DIR, VOICE_DIR, FILES_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, encryptData('{}'), 'utf-8');
  }
  if (!fs.existsSync(ROOMS_FILE))  fs.writeFileSync(ROOMS_FILE,  encryptData('{}'), 'utf-8');
  if (!fs.existsSync(KICKS_FILE)) fs.writeFileSync(KICKS_FILE, encryptData('{}'), 'utf-8');
  if (!fs.existsSync(MUTES_FILE)) fs.writeFileSync(MUTES_FILE, encryptData('{}'), 'utf-8');
  if (!fs.existsSync(PRESENCE_FILE)) fs.writeFileSync(PRESENCE_FILE, encryptData('{}'), 'utf-8');
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  ensureDataDir();
  try { 
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(decryptData(raw)); 
  } catch { return fallback; }
}
function writeJson(file: string, data: unknown): void {
  ensureDataDir();
  fs.writeFileSync(file, encryptData(JSON.stringify(data, null, 2)), 'utf-8');
}

// ─── Users ────────────────────────────────────────────────────────────────────

function readUsers() { return readJson<Record<string, UserRecord>>(USERS_FILE, {}); }

export function getUserByApiKey(apiKey: string): UserRecord | null {
  return Object.values(readUsers()).find(u => u.apiKey === apiKey) ?? null;
}
export function getUserByName(username: string): UserRecord | null {
  return readUsers()[username] ?? null;
}
export function getAllUsers(): UserRecord[] { return Object.values(readUsers()); }

export function createUser(username: string, createdBy: string, role: 'admin' | 'user' = 'user'): { apiKey: string } | { error: string } {
  const users = readUsers();
  if (users[username]) return { error: `User [${username}] already exists.` };
  const apiKey = `sfn-${crypto.randomBytes(20).toString('hex').replace(/(.{8})/g, '$1-').slice(0, -1)}`;
  users[username] = { username, apiKey, role, createdAt: Date.now(), createdBy };
  writeJson(USERS_FILE, users);
  return { apiKey };
}

export function deleteUser(username: string): boolean {
  const users = readUsers();
  if (!users[username] || users[username].role === 'admin') return false;
  delete users[username];
  writeJson(USERS_FILE, users);
  return true;
}

export function regenerateApiKey(username: string): { apiKey: string } | { error: string } {
  const users = readUsers();
  if (!users[username]) return { error: `User [${username}] not found.` };
  if (users[username].role === 'admin') return { error: 'Cannot regenerate admin API key.' };
  const apiKey = `sfn-${crypto.randomBytes(20).toString('hex').replace(/(.{8})/g, '$1-').slice(0, -1)}`;
  users[username].apiKey = apiKey;
  writeJson(USERS_FILE, users);
  return { apiKey };
}

// ─── Rooms ────────────────────────────────────────────────────────────────────

function readRooms() { return readJson<Record<string, RoomRecord>>(ROOMS_FILE, {}); }

export function getAllRooms(): RoomRecord[] { return Object.values(readRooms()); }
export function roomExists(roomHash: string): boolean { return !!readRooms()[roomHash]; }

export function createRoom(name: string, roomHash: string, createdBy: string, type: 'text'|'voice' = 'text'): { error?: string } {
  validateHash(roomHash);
  const rooms = readRooms();
  if (rooms[roomHash]) return { error: `Room [${name}] already exists.` };
  rooms[roomHash] = { name, roomHash, createdAt: Date.now(), createdBy, type };
  writeJson(ROOMS_FILE, rooms);
  const msgFile = path.join(MESSAGES_DIR, `${roomHash}.json`);
  if (!fs.existsSync(msgFile)) fs.writeFileSync(msgFile, encryptData('[]'), 'utf-8');
  return {};
}

export function deleteRoom(roomHash: string): boolean {
  validateHash(roomHash);
  const rooms = readRooms();
  if (!rooms[roomHash]) return false;
  delete rooms[roomHash];
  writeJson(ROOMS_FILE, rooms);
  const f = path.join(MESSAGES_DIR, `${roomHash}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const vf = path.join(VOICE_DIR, `${roomHash}.json`);
  if (fs.existsSync(vf)) fs.unlinkSync(vf);
  // Clean up room files index
  const ff = path.join(FILES_DIR, `${roomHash}.json`);
  if (fs.existsSync(ff)) fs.unlinkSync(ff);
  return true;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function getMessages(roomHash: string): MessageRecord[] {
  validateHash(roomHash);
  const f = path.join(MESSAGES_DIR, `${roomHash}.json`);
  return readJson<MessageRecord[]>(f, []);
}

export function saveMessage(msg: Omit<MessageRecord, 'id'>): MessageRecord {
  validateHash(msg.room);
  ensureDataDir();
  const f = path.join(MESSAGES_DIR, `${msg.room}.json`);
  const msgs = fs.existsSync(f) ? readJson<MessageRecord[]>(f, []) : [];
  const newMsg: MessageRecord = { id: crypto.randomUUID(), ...msg };
  msgs.push(newMsg);
  const trimmed = msgs.length > MAX_MESSAGES_PER_ROOM ? msgs.slice(-MAX_MESSAGES_PER_ROOM) : msgs;
  writeJson(f, trimmed);
  return newMsg;
}

// ─── File Storage (E2EE encrypted blobs) ──────────────────────────────────────

/**
 * Save an E2EE encrypted file blob.
 * The file data is already encrypted client-side, we store it server-side
 * with additional AEAD envelope encryption.
 */
export function saveFile(file: Omit<FileRecord, 'id'>): FileRecord {
  validateHash(file.room);
  ensureDataDir();
  
  const id = crypto.randomUUID();
  const record: FileRecord = { id, ...file };
  
  // Store file index per room
  const indexFile = path.join(FILES_DIR, `${file.room}.json`);
  const records = fs.existsSync(indexFile) ? readJson<FileRecord[]>(indexFile, []) : [];
  records.push(record);
  
  // Trim old files if over limit
  const trimmed = records.length > MAX_FILES_PER_ROOM ? records.slice(-MAX_FILES_PER_ROOM) : records;
  writeJson(indexFile, trimmed);
  
  return record;
}

/**
 * Get a file record by ID from a room.
 */
export function getFile(roomHash: string, fileId: string): FileRecord | null {
  validateHash(roomHash);
  const indexFile = path.join(FILES_DIR, `${roomHash}.json`);
  const records = readJson<FileRecord[]>(indexFile, []);
  return records.find(r => r.id === fileId) ?? null;
}

/**
 * List all file records for a room.
 */
export function getRoomFiles(roomHash: string): FileRecord[] {
  validateHash(roomHash);
  const indexFile = path.join(FILES_DIR, `${roomHash}.json`);
  return readJson<FileRecord[]>(indexFile, []);
}

// ─── Kicks ────────────────────────────────────────────────────────────────────

function readKicks() { return readJson<Record<string, string[]>>(KICKS_FILE, {}); }

export function kickUser(roomHash: string, username: string): void {
  validateHash(roomHash);
  const kicks = readKicks();
  if (!kicks[roomHash]) kicks[roomHash] = [];
  if (!kicks[roomHash].includes(username)) kicks[roomHash].push(username);
  writeJson(KICKS_FILE, kicks);
}

export function isKicked(roomHash: string, username: string): boolean {
  validateHash(roomHash);
  return (readKicks()[roomHash] || []).includes(username);
}

export function unkickUser(roomHash: string, username: string): void {
  validateHash(roomHash);
  const kicks = readKicks();
  if (kicks[roomHash]) {
    kicks[roomHash] = kicks[roomHash].filter(u => u !== username);
    writeJson(KICKS_FILE, kicks);
  }
}

// ─── Mutes ────────────────────────────────────────────────────────────────────

function readMutes() { return readJson<Record<string, MuteRecord>>(MUTES_FILE, {}); }

export function muteUser(username: string, durationMin: number, by: string, reason: string): void {
  const mutes = readMutes();
  mutes[username] = { username, until: Date.now() + durationMin * 60000, by, reason };
  writeJson(MUTES_FILE, mutes);
}

export function isMuted(username: string): MuteRecord | null {
  const m = readMutes()[username];
  if (!m) return null;
  if (Date.now() > m.until) {
    // Auto-unmute
    const mutes = readMutes();
    delete mutes[username];
    writeJson(MUTES_FILE, mutes);
    return null;
  }
  return m;
}

export function unmuteUser(username: string): boolean {
  const mutes = readMutes();
  if (!mutes[username]) return false;
  delete mutes[username];
  writeJson(MUTES_FILE, mutes);
  return true;
}

// ─── Voice Signaling ──────────────────────────────────────────────────────────

export function getVoiceSignals(roomHash: string, since: number): VoiceSignal[] {
  validateHash(roomHash);
  const f = path.join(VOICE_DIR, `${roomHash}.json`);
  const all = readJson<VoiceSignal[]>(f, []);
  return all.filter(s => s.timestamp > since);
}

export function saveVoiceSignal(signal: Omit<VoiceSignal, 'id'>): VoiceSignal {
  validateHash(signal.room);
  ensureDataDir();
  const f = path.join(VOICE_DIR, `${signal.room}.json`);
  const signals = fs.existsSync(f) ? readJson<VoiceSignal[]>(f, []) : [];
  const s: VoiceSignal = { id: crypto.randomUUID(), ...signal };
  signals.push(s);
  // Keep only last 200 signals per room
  const trimmed = signals.length > 200 ? signals.slice(-200) : signals;
  writeJson(f, trimmed);
  return s;
}

// ─── Voice Presence ───────────────────────────────────────────────────────────

function readPresence() { return readJson<VoicePresence>(PRESENCE_FILE, {}); }

export function updateVoicePresence(roomHash: string, username: string): void {
  validateHash(roomHash);
  const p = readPresence();
  if (!p[roomHash]) p[roomHash] = {};
  p[roomHash][username] = Date.now();
  writeJson(PRESENCE_FILE, p);
}

export function getVoicePresence(roomHash: string): string[] {
  try { validateHash(roomHash); } catch { return []; }
  const p = readPresence();
  const room = p[roomHash] || {};
  const active: string[] = [];
  const now = Date.now();
  for (const [user, ts] of Object.entries(room)) {
    if (now - ts < 6000) active.push(user); // 6 seconds threshold
  }
  return active;
}
