'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { encryptMessage, decryptMessage, deriveKey, encryptFile, decryptFile, b64Encode } from '@/lib/crypto';
import { POLLING_INTERVAL_MS, SESSION_TIMEOUT_MS, APP_VERSION, MAX_FILE_SIZE_BYTES } from '@/lib/constants';
import { useVoiceChat } from '@/hooks/useVoiceChat';

interface LogEntry { id: string; text: string; type: 'system'|'user'|'admin'|'error'|'msg'|'success'|'warn'; time: string; isOwn?: boolean; status?: 'sending'|'sent'; file?: { id: string, name: string, type: string, size: number, dataUrl?: string, loading?: boolean, error?: boolean }; }
interface RoomInfo { name: string; roomHash: string; type?: 'text'|'voice'; activeUsers?: string[]; messageCount?: number; }
interface ActiveRoom { name: string; hash: string; cryptoKey: CryptoKey; }

let _c = 0;
const uid = () => `l${++_c}`;
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function playNotificationSound(isMention: boolean = false) {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    if (isMention) {
      // Futuristic double-ping chime for mentions
      const playPing = (time: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.08, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.3);
      };
      const now = ctx.currentTime;
      playPing(now, 880);      // A5
      playPing(now + 0.08, 1320); // E6 double-chirp
    } else {
      // Gentle retro terminal click/ping for general messages
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, ctx.currentTime); // E5
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    }
  } catch {}
}

function requestNotificationPermission() {
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }
}

function triggerPushNotification(title: string, body: string) {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, {
        body,
        icon: '/favicon.ico',
      });
    } catch {}
  }
}

function renderTextWithMentions(text: string, currentUsername: string | null) {
  const parts = text.split(/(@\w+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      const isMe = currentUsername && part.substring(1).toLowerCase() === currentUsername.toLowerCase();
      return (
        <span key={i} className={`sfn-mention${isMe ? ' mention-me' : ''}`}>
          {part}
        </span>
      );
    }
    return part;
  });
}

export default function Terminal() {
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    { id: uid(), text: 'Senfoni Chat · E2EE Secure Messaging', type: 'system', time: ts() },
  ]);
  const [loginKey, setLoginKey] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [setupName, setSetupName] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);

  const [input, setInput]           = useState('');
  const [username, setUsername]     = useState<string|null>(null);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [apiKey, setApiKey]         = useState<string|null>(null);
  const [role, setRole]             = useState<'admin'|'user'|null>(null);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom|null>(null);
  const [activeVoiceRoom, setActiveVoiceRoom] = useState<{name: string, hash: string}|null>(null);
  const [rooms, setRooms]           = useState<RoomInfo[]>([]);
  const [loginTime, setLoginTime]   = useState<number|null>(null);
  const [lastPoll, setLastPoll]     = useState(0);
  const [seenIds, setSeenIds]       = useState(new Set<string>());
  const [busy, setBusy]             = useState(false);
  const [expiry, setExpiry]         = useState('--:--');
  const [history, setHistory]       = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [theme, setTheme]           = useState<string>('default');
  const [isSecure, setIsSecure]     = useState(true);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const lastTypingSentRef             = useRef<number>(0);
  const [dmUsers, setDmUsers] = useState<string[]>([]);
  const [dmInput, setDmInput] = useState('');
  const [lastSeenCounts, setLastSeenCounts] = useState<Record<string, number>>(() => {
    try {
      if (typeof window !== 'undefined') {
        return JSON.parse(localStorage.getItem('sfn_last_seen_counts') || '{}');
      }
    } catch {}
    return {};
  });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const handleInputChange = (val: string) => {
    setInput(val);
    setHistoryIdx(-1);

    if (!activeRoom || !username || !apiKey) return;

    const now = Date.now();
    const isEmpty = val.trim().length === 0;

    // Send typing heartbeat
    if (isEmpty || now - lastTypingSentRef.current > 2000) {
      lastTypingSentRef.current = now;
      fetch('/api/messages/typing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Caller-Key': apiKey
        },
        body: JSON.stringify({
          room: activeRoom.hash,
          username,
          isTyping: !isEmpty
        })
      }).catch(() => {});
    }
  };

  // Load theme & check secure context
  useEffect(() => {
    const t = localStorage.getItem('sfn_theme') || 'default';
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);

    // Request notification permission
    requestNotificationPermission();

    // E2EE requires secure context (HTTPS or localhost)
    if (typeof window !== 'undefined') {
      const secure = !!(window.isSecureContext && window.crypto && window.crypto.subtle);
      setIsSecure(secure);
      if (!secure && !warnedRef.current) {
        warnedRef.current = true;
        add('⚠️ Güvenli olmayan bağlantı tespit edildi. E2EE için HTTPS gereklidir.', 'warn');
      }
    }
  }, []);

  // Load command history
  useEffect(() => {
    try {
      const h = JSON.parse(sessionStorage.getItem('sfn_history') || '[]');
      if (Array.isArray(h)) setHistory(h);
    } catch {}
  }, []);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const lastPollRef = useRef(0);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const warnedRef = useRef(false);

  useEffect(() => {
    lastPollRef.current = lastPoll;
  }, [lastPoll]);

  useEffect(() => {
    seenIdsRef.current = seenIds;
  }, [seenIds]);

  const add = useCallback((text: string, type: LogEntry['type'] = 'system') => {
    setLogs(p => [...p, { id: uid(), text, type, time: ts() }]);
  }, []);

  const { voiceState, joinVoice, leaveVoice, toggleMute, shareScreen } = useVoiceChat(
    username, apiKey, add as any
  );

  const hasCheckedSetup = useRef(false);

  // Setup Check
  useEffect(() => {
    if (hasCheckedSetup.current) return;
    hasCheckedSetup.current = true;

    fetch('/api/setup').then(r => r.json()).then(d => {
      if (d.uninitialized) {
        setNeedsSetup(true);
      }
    }).catch(() => {});
  }, [add]);

  // Auto-scroll
  useEffect(() => { 
    if (!outputRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    // Always scroll to bottom if we just loaded a bunch of logs initially, 
    // or if we are near the bottom.
    // A simple heuristic: if it's the first time logs populate for this room, scroll down.
    if (scrollHeight - scrollTop - clientHeight < 150 || !outputRef.current.dataset.scrolledForRoom) {
      outputRef.current.scrollTo({ top: scrollHeight, behavior: 'smooth' });
      if (logs.length > 0) outputRef.current.dataset.scrolledForRoom = activeRoom?.hash || 'none';
    }
  }, [logs, activeRoom]);

  // Force instant scroll to bottom when switching rooms
  useEffect(() => {
    if (!activeRoom || !outputRef.current) return;
    delete outputRef.current.dataset.scrolledForRoom;
    const scrollInstant = () => {
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    };
    
    scrollInstant();
    const t1 = setTimeout(scrollInstant, 50);
    const t2 = setTimeout(scrollInstant, 150);
    
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [activeRoom]);

  // Session timer
  useEffect(() => {
    if (!loginTime) { setExpiry('--:--'); return; }
    const tick = () => {
      const rem = (loginTime + SESSION_TIMEOUT_MS) - Date.now();
      if (rem <= 0) { doQuit('Session expired.'); return; }
      setExpiry(`${String(Math.floor(rem/3600000)).padStart(2,'0')}h ${String(Math.floor((rem%3600000)/60000)).padStart(2,'0')}m`);
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginTime]);

  // Fetch rooms for sidebar
  useEffect(() => {
    if (!apiKey) { setRooms([]); return; }
    const f = async () => {
      try {
        const r = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey } });
        const d = await r.json();
        if (d.rooms) setRooms(d.rooms);
      } catch {}
    };
    f();
    const t = setInterval(f, 8000);
    return () => clearInterval(t);
  }, [apiKey]);

  // Message polling — only adds NEW messages not already seen
  useEffect(() => {
    if (!activeRoom || !apiKey) return;
    const poll = async () => {
      try {
        const currentLastPoll = lastPollRef.current;
        const r = await fetch(`/api/messages?room=${activeRoom.hash}&since=${currentLastPoll}&_t=${Date.now()}`);
        
        // Parse active typing users list from response custom header
        const typingHeader = r.headers.get('X-Typing-Users');
        if (typingHeader !== null) {
          const list = typingHeader ? typingHeader.split(',').filter(Boolean) : [];
          setTypingUsers(list);
        }

        const msgs: any[] = await r.json();
        if (!Array.isArray(msgs) || !msgs.length) return;
        const entries: LogEntry[] = [];
        let maxTs = currentLastPoll;
        let hasIncoming = false;
        let hasMention = false;
        for (const m of msgs) {
          if (seenIdsRef.current.has(m.id)) continue;
          seenIdsRef.current.add(m.id);
          try {
            const plain = await decryptMessage(m.ciphertext, m.iv, activeRoom.cryptoKey);
            const entry: LogEntry = { id: uid(), text: `${m.sender}: ${plain}`, type: 'msg', time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' }), isOwn: m.sender === username, status: 'sent' };
            if (m.fileId) {
              entry.file = { id: m.fileId, name: m.fileName, type: m.fileType, size: m.fileSize };
              entry.text = `${m.sender}: [Sent File]`;
            }
            entries.push(entry);
            if (m.timestamp > maxTs) maxTs = m.timestamp;

            if (m.sender !== username) {
              hasIncoming = true;
              const isMen = username && plain.toLowerCase().includes(`@${username.toLowerCase()}`);
              if (isMen) hasMention = true;

              // Display push notification if tab is in the background
              if (document.hidden) {
                if (isMen) {
                  triggerPushNotification(`[!] MENTION in #${activeRoom.name}`, `@${username} was tagged by ${m.sender}: "${plain}"`);
                } else {
                  triggerPushNotification(`New message in #${activeRoom.name}`, `${m.sender}: ${plain}`);
                }
              }
            }
          } catch {}
        }
        if (entries.length) {
          setLogs(p => [...p, ...entries]);
          setLastPoll(maxTs);
          setSeenIds(new Set(seenIdsRef.current));
          if (hasIncoming) {
            playNotificationSound(hasMention);
          }
        }
      } catch {}
    };
    const t = setInterval(poll, POLLING_INTERVAL_MS);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom, apiKey, username]);

  function doQuit(reason = 'Session terminated.') {
    leaveVoice();
    setUsername(null); setApiKey(null); setRole(null);
    setActiveRoom(null); setActiveVoiceRoom(null); setRooms([]); setLoginTime(null);
    setLastPoll(0); setSeenIds(new Set());
    add(`SYSTEM: ${reason}`);
  }

  async function hashStr(s: string) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function sendMsg(text: string) {
    if (!activeRoom || !apiKey || !username) { add('ERR: Join a room first.', 'error'); return; }
    const msgId = uid();
    setLogs(p => [...p, { id: msgId, text: `${username}: ${text}`, type: 'msg', time: ts(), isOwn: true, status: 'sending' }]);
    try {
      const enc = await encryptMessage(text, activeRoom.cryptoKey);
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Key': apiKey },
        body: JSON.stringify({ room: activeRoom.hash, ciphertext: enc.ciphertext, iv: enc.iv, sender: username }),
      });
      const d = await res.json();
      if (d.error) {
        setLogs(p => p.map(l => l.id === msgId ? { ...l, status: undefined, type: 'error', text: `ERR: ${d.error}` } : l));
        return;
      }
      // Immediately mark as seen to avoid duplicate on next poll
      if (d.id) {
        seenIdsRef.current.add(d.id);
        setSeenIds(new Set(seenIdsRef.current));
      }
      if (d.timestamp) {
        lastPollRef.current = d.timestamp;
        setLastPoll(d.timestamp);
      }
      setLogs(p => p.map(l => l.id === msgId ? { ...l, status: 'sent' } : l));
    } catch {
      setLogs(p => p.map(l => l.id === msgId ? { ...l, status: undefined, type: 'error', text: 'ERR: SEND_FAILED' } : l));
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // Reset input
    
    if (!activeRoom || !apiKey || !username) { add('ERR: Join a room first.', 'error'); return; }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      add(`ERR: File too large (Max ${Math.round(MAX_FILE_SIZE_BYTES/1024/1024)}MB)`, 'error');
      return;
    }

    const msgId = uid();
    setLogs(p => [...p, { id: msgId, text: `${username}: Uploading ${file.name}...`, type: 'msg', time: ts(), isOwn: true, status: 'sending' }]);
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const enc = await encryptFile(buffer, activeRoom.cryptoKey);
      
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Key': apiKey },
        body: JSON.stringify({
          room: activeRoom.hash,
          sender: username,
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          fileSize: file.size,
          encryptedData: enc.ciphertext,
          encryptedIv: enc.iv
        }),
      });
      const d = await res.json();
      if (d.error) {
        setLogs(p => p.map(l => l.id === msgId ? { ...l, status: undefined, type: 'error', text: `ERR: ${d.error}` } : l));
      } else {
        if (d.messageId) {
          seenIdsRef.current.add(d.messageId);
          setSeenIds(new Set(seenIdsRef.current));
        }
        if (d.timestamp) {
          lastPollRef.current = d.timestamp;
          setLastPoll(d.timestamp);
        }
        setLogs(p => p.map(l => l.id === msgId ? { 
          ...l, 
          status: 'sent', 
          text: `${username}: [Sent File]`,
          file: { id: d.fileId, name: file.name, type: file.type || 'application/octet-stream', size: file.size }
        } : l));
      }
    } catch (err) {
      setLogs(p => p.map(l => l.id === msgId ? { ...l, status: undefined, type: 'error', text: 'ERR: UPLOAD_FAILED' } : l));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const handleFileAction = async (msgId: string, fileInfo: NonNullable<LogEntry['file']>) => {
    if (!activeRoom || !apiKey) return;
    
    setLogs(p => p.map(l => l.id === msgId ? { ...l, file: { ...l.file!, loading: true } } : l));
    
    try {
      const res = await fetch(`/api/files?room=${activeRoom.hash}&id=${fileInfo.id}`, {
        headers: { 'X-Caller-Key': apiKey }
      });
      const d = await res.json();
      
      if (d.error || !d.encryptedData) throw new Error(d.error || 'Failed to fetch file');
      
      const decryptedBuffer = await decryptFile(d.encryptedData, d.encryptedIv, activeRoom.cryptoKey);
      const blob = new Blob([decryptedBuffer], { type: d.fileType || 'application/octet-stream' });
      const dataUrl = URL.createObjectURL(blob);
      
      setLogs(p => p.map(l => l.id === msgId ? { ...l, file: { ...l.file!, loading: false, dataUrl } } : l));
      
      // If it's not an image, trigger download automatically
      if (!d.fileType?.startsWith('image/')) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = d.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      setLogs(p => p.map(l => l.id === msgId ? { ...l, file: { ...l.file!, loading: false, error: true } } : l));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw || busy) return;

    // Save to history
    const newHistory = [raw, ...history.filter(h => h !== raw)].slice(0, 50);
    setHistory(newHistory);
    sessionStorage.setItem('sfn_history', JSON.stringify(newHistory));
    setHistoryIdx(-1);

    setInput('');
    if (activeRoom && username && apiKey) {
      fetch('/api/messages/typing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Caller-Key': apiKey
        },
        body: JSON.stringify({
          room: activeRoom.hash,
          username,
          isTyping: false
        })
      }).catch(() => {});
    }
    if (!raw.startsWith('/')) {
      if (activeRoom && apiKey && username) await sendMsg(raw);
      else add('ERR: Join a room first. /join [room] [key]', 'error');
      return;
    }
    add(raw, 'user');
    const parts = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));
    setBusy(true);
    try { await exec(cmd, args); } finally { setBusy(false); }
  };

  const exec = async (cmd: string, args: string[]) => {
    switch (cmd) {
      case '/setup': {
        if (!args[0]) { add('USAGE: /setup [username]', 'error'); break; }
        const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: args[0] }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        add(`Your API Key: ${d.apiKey}`, 'success');
        add('SAVE THIS KEY! It will never be shown again.', 'warn');
        break;
      }

      case '/help':
        add('━━━ SENFONI CHAT — COMMANDS ━━━');
        add('/login [api-key]         Authenticate');
        add('/join [room] [key]       Enter encrypted room');
        add('/leave                   Leave current room');
        add('/rooms                   List rooms');
        add('/whoami                  Show identity');
        add('/voice                   Toggle voice chat');
        add('/voice-mute              Toggle mic mute');
        add('/upload                  Send an encrypted file/image');
        add('/theme [name]            Change theme (default, matrix, ocean, hacker-pink, red-alert, solarized, synthwave, ghost)');
        add('/clear                   Clear buffer');
        add('/quit                    Terminate session');
        if (role === 'admin') {
          add('━━━ MODERATOR ━━━', 'admin');
          add('  /create-user [name]');
          add('  /delete-user [name]');
          add('  /gen-api [name]');
          add('  /list-users');
          add('  /create-room [name]');
          add('  /create-voice-room [name]');
          add('  /delete-room [name]');
          add('  /list-rooms');
          add('  /kick [user] [room]   Ban user from room');
          add('  /unkick [user] [room] Unban user');
          add('  /mute [user] [min]    Mute user globally');
          add('  /unmute [user]        Unmute user');
        }
        break;

      case '/login':
        if (username) { add(`Already logged in as [${username}]. /quit first.`, 'error'); break; }
        if (!args[0]) { add('USAGE: /login [api-key]', 'error'); break; }
        add('Authenticating...');
        try {
          const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ apiKey: args[0] }) });
          const d = await r.json();
          if (!d.valid) { add('ERR: INVALID_API_KEY', 'error'); break; }
          setUsername(d.username); setApiKey(args[0]); setRole(d.role); setLoginTime(Date.now());
          localStorage.setItem('sfn_api_key', args[0]);

          // Restore server-saved room keys and last room
          if (d.roomKeys) {
            const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}');
            const merged = { ...saved, ...d.roomKeys };
            localStorage.setItem('sfn_keys', JSON.stringify(merged));
          }
          if (d.lastRoom && d.lastRoomKey) {
            localStorage.setItem('sfn_last_room', d.lastRoom);
            localStorage.setItem('sfn_last_room_key', d.lastRoomKey);
          }

          if (d.role === 'admin') {
            add(`ACCESS GRANTED — [${d.username}] MODERATOR`, 'admin');
            // Admin auto-joins: load all rooms into sidebar immediately
            const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': args[0] } });
            const rd = await rr.json();
            if (rd.rooms) setRooms(rd.rooms);
          } else {
            add(`ACCESS GRANTED — [${d.username}] USER`, 'success');
          }
          fetchAvatars(args[0]);
        } catch { add('ERR: Connection failed.', 'error'); }
        break;

      case '/join':
        if (!username) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /join [room] [key]', 'error'); break; }
        try {
          const salt = new TextEncoder().encode('senfoni-salt-' + args[0]);
          const cKey = await deriveKey(args[1], salt);
          const rHash = await hashStr('senfoni-room-' + args[0]);
          setActiveRoom({ name: args[0], hash: rHash, cryptoKey: cKey });
          setLastPoll(0); setSeenIds(new Set()); setLogs([]);
          
          // Save key for auto-join next time
          if (!args[0].startsWith('notes-')) {
            const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}');
            saved[args[0]] = args[1];
            localStorage.setItem('sfn_keys', JSON.stringify(saved));
            
            // Save last room info
            localStorage.setItem('sfn_last_room', args[0]);
            localStorage.setItem('sfn_last_room_key', args[1]);
          } else {
            // Personal notes room
            localStorage.setItem('sfn_last_room', args[0]);
            localStorage.setItem('sfn_last_room_key', args[1]);
          }

          // Persist join status on the server
          fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Caller-Key': apiKey || localStorage.getItem('sfn_api_key') || '' },
            body: JSON.stringify({ action: 'join', roomName: args[0], roomKey: args[1] })
          }).catch(() => {});

          // Load history
          const hr = await fetch(`/api/messages?room=${rHash}&_t=${Date.now()}`);

          // Parse active typing users list from response custom header
          const typingHeader = hr.headers.get('X-Typing-Users');
          if (typingHeader !== null) {
            const list = typingHeader ? typingHeader.split(',').filter(Boolean) : [];
            setTypingUsers(list);
          }

          const hist: any[] = await hr.json();
          const entries: LogEntry[] = [];
          if (Array.isArray(hist) && hist.length) {
            const ids = new Set<string>();
            let maxTs = 0;
            for (const m of hist) {
              try {
                const plain = await decryptMessage(m.ciphertext, m.iv, cKey);
                const entry: LogEntry = { id: uid(), text: `${m.sender}: ${plain}`, type: 'msg', time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' }), isOwn: m.sender === username, status: 'sent' };
                if (m.fileId) {
                  entry.file = { id: m.fileId, name: m.fileName, type: m.fileType, size: m.fileSize };
                  entry.text = `${m.sender}: [Sent File]`;
                }
                entries.push(entry);
                ids.add(m.id);
                if (m.timestamp > maxTs) maxTs = m.timestamp;
              } catch {}
            }
            setSeenIds(ids); setLastPoll(maxTs);
            setLogs(entries);
          }
          setLastSeenCounts(prev => ({
            ...prev,
            [rHash]: entries.length
          }));
        } catch { add('ERR: Failed to join.', 'error'); }
        break;

      case '/leave':
        if (!activeRoom) { add('Not in a text room.', 'error'); break; }
        add(`Left [#${activeRoom.name}].`);
        setActiveRoom(null); setLastPoll(0); setSeenIds(new Set());
        localStorage.removeItem('sfn_last_room');
        localStorage.removeItem('sfn_last_room_key');

        // Persist leave status on the server
        fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Caller-Key': apiKey || localStorage.getItem('sfn_api_key') || '' },
          body: JSON.stringify({ action: 'leave' })
        }).catch(() => {});
        break;

      case '/join-voice':
        if (!username) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /join-voice [room] [key]', 'error'); break; }
        try {
          const rHash = await hashStr('senfoni-room-' + args[0]);
          setActiveVoiceRoom({ name: args[0], hash: rHash });
          
          const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}');
          saved[args[0]] = args[1];
          localStorage.setItem('sfn_keys', JSON.stringify(saved));
          
          joinVoice(rHash);
        } catch { add('ERR: Failed to join voice.', 'error'); }
        break;

      case '/dm': {
        if (!username) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (!args[0]) { add('USAGE: /dm [kullanıcı-adı]', 'error'); break; }
        const dmTarget = args[0].trim();
        if (dmTarget === username) { add('Kendinize DM atamazsınız.', 'error'); break; }
        // DM oda adı: alfabetik sıraya göre birleştir (deterministik)
        const dmPair = [username, dmTarget].sort().join('-');
        const dmRoom = `dm-${dmPair}`;
        // Oda anahtarı olarak kullanıcının API key'ini kullan (her iki taraf da biliyor)
        setDmUsers(prev => prev.includes(dmTarget) ? prev : [...prev, dmTarget]);
        exec('/join', [dmRoom, apiKey!]);
        break;
      }
      case '/leave-voice':
        if (!activeVoiceRoom) { add('Not in a voice room.', 'error'); break; }
        leaveVoice();
        setActiveVoiceRoom(null);
        break;

      case '/whoami':
        if (!username) { add('Not authenticated.', 'error'); break; }
        add(`Identity: ${username}  ·  Role: ${role?.toUpperCase()}  ·  Text: ${activeRoom ? '#'+activeRoom.name : 'none'}  ·  Voice: ${activeVoiceRoom ? '🔊'+activeVoiceRoom.name : 'none'}`);
        if (voiceState.isActive) add(`Voice: ACTIVE  ·  Mic: ${voiceState.isMuted ? 'MUTED' : 'LIVE'}  ·  Peers: ${voiceState.peers.length}`);
        break;

      case '/rooms':
        if (!apiKey) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (!rooms.length) { add('No rooms. Ask melodi to create one.'); break; }
        add(`Rooms (${rooms.length}):`);
        rooms.forEach(r => add(`  · #${r.name}`));
        break;

      case '/voice':
        add('Use /join-voice [room] [key] or click Voice Channels.', 'system');
        break;

      case '/voice-mute':
        if (!voiceState.isActive) { add('ERR: Voice not active.', 'error'); break; }
        toggleMute();
        break;
        
      case '/upload':
        if (!activeRoom || !apiKey || !username) { add('ERR: Join a room first.', 'error'); break; }
        fileInputRef.current?.click();
        break;

      case '/clear': setLogs([]); break;
      case '/quit': doQuit(); break;

      case '/theme': {
        const available = ['default', 'matrix', 'ocean', 'hacker-pink', 'red-alert', 'solarized', 'synthwave', 'ghost'];
        if (!args[0]) {
          add('Available themes: ' + available.join(', '));
          break;
        }
        const t = args[0].toLowerCase();
        if (available.includes(t)) {
          setTheme(t);
          localStorage.setItem('sfn_theme', t);
          document.documentElement.setAttribute('data-theme', t);
          add(`Theme changed to [${t}]`, 'success');
        } else {
          add(`ERR: Theme [${t}] not found.`, 'error');
        }
        break;
      }

      // ── Moderator ──────────────────────────────────────────────────────────
      case '/create-user': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /create-user [name]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'create-user', name:args[0] }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        add(`API KEY → ${d.apiKey}`, 'admin');
        add('Share securely. Shown only once.', 'warn');
        break;
      }
      case '/delete-user': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /delete-user [name]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'delete-user', name:args[0] }) });
        const d = await r.json();
        d.error ? add(`ERR: ${d.error}`, 'error') : add(d.message, 'admin');
        break;
      }
      case '/gen-api': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /gen-api [name]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'gen-api', name:args[0] }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin'); add(`NEW KEY → ${d.apiKey}`, 'admin'); add('Previous key invalidated.', 'warn');
        break;
      }
      case '/list-users': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'list-users' }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(`Users (${d.users.length}):`, 'admin');
        d.users.forEach((u: any) => add(`  · ${u.username.padEnd(16)} [${u.role.toUpperCase()}]  by: ${u.createdBy}`, 'admin'));
        break;
      }
      case '/create-room': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /create-room [name]', 'error'); break; }
        const genKey = Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6);
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'create-room', name:args[0], roomKey: genKey }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        
        add(`Room Key: ${genKey}  (Share this with users so they can join!)`, 'success');
        
        const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}');
        saved[args[0]] = genKey;
        localStorage.setItem('sfn_keys', JSON.stringify(saved));

        // Refresh sidebar
        const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey! } });
        const rd = await rr.json();
        if (rd.rooms) setRooms(rd.rooms);
        break;
      }
      case '/create-voice-room': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /create-voice-room [name]', 'error'); break; }
        const genKey = Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6);
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'create-room', name:args[0], type:'voice', roomKey: genKey }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        
        add(`Voice Room Key: ${genKey}  (Share this with users so they can join!)`, 'success');
        
        const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}');
        saved[args[0]] = genKey;
        localStorage.setItem('sfn_keys', JSON.stringify(saved));

        // Refresh sidebar
        const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey! } });
        const rd = await rr.json();
        if (rd.rooms) setRooms(rd.rooms);
        break;
      }
      case '/delete-room': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /delete-room [name]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'delete-room', name:args[0] }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        if (activeRoom?.name === args[0]) { setActiveRoom(null); setLastPoll(0); setSeenIds(new Set()); }
        const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey! } });
        const rd = await rr.json();
        if (rd.rooms) setRooms(rd.rooms);
        break;
      }
      case '/list-rooms': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        const r = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey! } });
        const d = await r.json();
        if (!d.rooms) { add('ERR: Fetch failed.', 'error'); break; }
        add(`Rooms (${d.rooms.length}):`, 'admin');
        d.rooms.forEach((r: any) => add(`  · #${r.name}  hash: ${r.roomHash.slice(0,12)}...`, 'admin'));
        break;
      }
      case '/kick': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /kick [user] [room]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'kick', username:args[0], room:args[1] }) });
        const d = await r.json();
        d.error ? add(`ERR: ${d.error}`, 'error') : add(d.message, 'admin');
        break;
      }
      case '/unkick': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /unkick [user] [room]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'unkick', username:args[0], room:args[1] }) });
        const d = await r.json();
        d.error ? add(`ERR: ${d.error}`, 'error') : add(d.message, 'admin');
        break;
      }
      case '/mute': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /mute [user] [minutes?]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'mute', username:args[0], duration:args[1]||'10', reason:args.slice(2).join(' ')||'Moderator action' }) });
        const d = await r.json();
        d.error ? add(`ERR: ${d.error}`, 'error') : add(d.message, 'admin');
        break;
      }
      case '/unmute': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /unmute [user]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'unmute', username:args[0] }) });
        const d = await r.json();
        d.error ? add(`ERR: ${d.error}`, 'error') : add(d.message, 'admin');
        break;
      }

      default:
        add(`Unknown command [${cmd}]. /help`, 'error');
    }
  };

  // Keep active room unread count cleared
  useEffect(() => {
    if (activeRoom && rooms.length) {
      const currentRoom = rooms.find(r => r.roomHash === activeRoom.hash);
      if (currentRoom && currentRoom.messageCount !== undefined) {
        if (lastSeenCounts[activeRoom.hash] !== currentRoom.messageCount) {
          setLastSeenCounts(prev => ({
            ...prev,
            [activeRoom.hash]: currentRoom.messageCount || 0
          }));
        }
      }
    }
  }, [activeRoom, rooms, lastSeenCounts]);

  // Save lastSeenCounts to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sfn_last_seen_counts', JSON.stringify(lastSeenCounts));
    }
  }, [lastSeenCounts]);

  // Auto-login on load
  useEffect(() => {
    let savedApiKey = localStorage.getItem('sfn_api_key');
    
    // Check URL parameters for auto-login
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlKey = params.get('key');
      if (urlKey) {
        savedApiKey = urlKey;
        localStorage.setItem('sfn_api_key', urlKey);
        // Clear the URL parameter so it doesn't stay in the address bar
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }

    if (savedApiKey && !username) {
        exec('/login', [savedApiKey]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-join last active room after login is established
  useEffect(() => {
    if (username && apiKey) {
      const lastRoom = localStorage.getItem('sfn_last_room');
      const lastRoomKey = localStorage.getItem('sfn_last_room_key');
      if (lastRoom && lastRoomKey && !activeRoom) {
          exec('/join', [lastRoom, lastRoomKey]);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, apiKey]);


  const parseMsgSender = (text: string) => {
    const idx = text.indexOf(': ');
    if (idx === -1) return { sender: '', content: text };
    return { sender: text.substring(0, idx), content: text.substring(idx + 2) };
  };
  
  const fetchAvatars = async (key: string) => {
    try {
      const res = await fetch('/api/avatar', { headers: { 'X-Caller-Key': key } });
      const data = await res.json();
      if (data.avatars) setAvatars(data.avatars);
    } catch {}
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginKey.trim()) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ apiKey: loginKey.trim() }) });
      const d = await r.json();
      if (!d.valid) { setLoginError('Geçersiz API anahtarı.'); setLoginBusy(false); return; }
      setUsername(d.username); setApiKey(loginKey.trim()); setRole(d.role); setLoginTime(Date.now());
      localStorage.setItem('sfn_api_key', loginKey.trim());
      if (d.roomKeys) { const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}'); localStorage.setItem('sfn_keys', JSON.stringify({ ...saved, ...d.roomKeys })); }
      if (d.lastRoom && d.lastRoomKey) { localStorage.setItem('sfn_last_room', d.lastRoom); localStorage.setItem('sfn_last_room_key', d.lastRoomKey); }
      add(`Hoş geldin, ${d.username}!`, d.role === 'admin' ? 'admin' : 'success');
      if (d.role === 'admin') { const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': loginKey.trim() } }); const rd = await rr.json(); if (rd.rooms) setRooms(rd.rooms); }
      fetchAvatars(loginKey.trim());
    } catch { setLoginError('Bağlantı hatası.'); }
    setLoginBusy(false);
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupName.trim()) return;
    setLoginBusy(true);
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: setupName.trim() }) });
    const d = await r.json();
    if (d.error) { setLoginError(d.error); } else { setLoginError(''); setNeedsSetup(false); add(d.message, 'admin'); add(`API Key: ${d.apiKey}`, 'success'); add('Bu anahtarı kaydedin! Bir daha gösterilmeyecek.', 'warn'); }
    setLoginBusy(false);
  };

  // Login Screen
  if (!username) {
    return (
      <div className="sfn-login">
        <div className="sfn-login-card">
          <div className="sfn-login-badge">🔒 AES-GCM-256 · Uçtan Uca Şifreli</div>
          <h1><span>Senfoni</span> Chat</h1>
          <p>Güvenli iletişim platformuna giriş yapın.</p>
          {needsSetup ? (
            <form onSubmit={handleSetupSubmit}>
              <input type="text" placeholder="Admin kullanıcı adı" value={setupName} onChange={e => setSetupName(e.target.value)} disabled={loginBusy} autoFocus />
              <button type="submit" disabled={loginBusy}>{loginBusy ? 'Kuruluyor...' : 'Sunucuyu Kur'}</button>
            </form>
          ) : (
            <form onSubmit={handleLoginSubmit}>
              <input type="password" placeholder="API Anahtarınız" value={loginKey} onChange={e => setLoginKey(e.target.value)} disabled={loginBusy} autoFocus />
              <button type="submit" disabled={loginBusy}>{loginBusy ? 'Doğrulanıyor...' : 'Giriş Yap'}</button>
            </form>
          )}
          {loginError && <div className="sfn-login-error">{loginError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="sfn-container">
      {isMobileMenuOpen && <div className="sfn-mobile-overlay" onClick={() => setIsMobileMenuOpen(false)} />}
      <aside className={`sfn-sidebar ${isMobileMenuOpen ? 'open' : ''}`}>
        <div className="sb-identity">
          <div className="sb-label">HESAP</div>
          <div className="sb-user">
            <div className="sb-avatar" onClick={() => { 
              if (avatars[username]) {
                const remove = window.confirm('Profil fotoğrafını kaldırmak ve varsayılana dönmek istiyor musun?');
                if (remove) {
                  setBusy(true);
                  fetch('/api/avatar', { method: 'DELETE', headers: { 'X-Caller-Key': apiKey! } })
                    .then(res => res.json())
                    .then(data => { if (data.success) { fetchAvatars(apiKey!); add('Varsayılan profile dönüldü.', 'success'); } })
                    .finally(() => setBusy(false));
                  return;
                }
              }
              const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.onchange = async (e: any) => { const file = e.target.files[0]; if (!file) return; const formData = new FormData(); formData.append('file', file); setBusy(true); try { const res = await fetch('/api/avatar', { method: 'POST', headers: { 'X-Caller-Key': apiKey! }, body: formData }); const data = await res.json(); if (data.success) { fetchAvatars(apiKey!); add('Profil fotoğrafı güncellendi!', 'success'); } else { add('Hata: ' + data.error, 'error'); } } catch (err) { add('Fotoğraf yüklenemedi.', 'error'); } setBusy(false); }; input.click(); 
            }} style={{ cursor: 'pointer', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Profil Fotoğrafını Değiştir">
              {avatars[username] ? <img src={avatars[username]} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Avatar" /> : username[0].toUpperCase()}
            </div>
            <div>
              <div style={{display:'flex',alignItems:'center',gap:6}}>{username} {role === 'admin' && <span className="badge-mod">MOD</span>}</div>
              <div style={{fontSize:'0.65rem',color:'var(--text3)',marginTop:2}}>{role === 'admin' ? 'Moderatör' : 'Üye'}</div>
            </div>
          </div>
        </div>

        <div className="sb-section">
          <div className="sb-label">KANALLAR</div>
          {rooms.filter(r => r.type !== 'voice').length === 0
            ? <div className="sb-empty">Henüz kanal yok</div>
            : rooms.filter(r => r.type !== 'voice').map(r => {
              const unread = (activeRoom && activeRoom.hash === r.roomHash) ? 0 : Math.max(0, (r.messageCount || 0) - (lastSeenCounts[r.roomHash] || 0));
              return (
                <div key={r.roomHash} className={`sb-room${activeRoom?.name === r.name ? ' active' : ''}${unread > 0 ? ' unread' : ''}`}
                  onClick={e => { e.stopPropagation(); setIsMobileMenuOpen(false); const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}'); const key = saved[r.name]; if (key) { exec('/join', [r.name, key]); } else { setInput(`/join ${r.name} `); inputRef.current?.focus(); } }}>
                  <span className="sb-hash">#</span><span className="sb-rname">{r.name}</span>
                  {unread > 0 && <span className="sb-unread-badge">{unread}</span>}
                  {activeRoom?.name === r.name && <span className="sb-dot" />}
                </div>
              );
            })
          }

          <div className="sb-label" style={{marginTop:16}}>SESLİ KANALLAR</div>
          {rooms.filter(r => r.type === 'voice').length === 0
            ? <div className="sb-empty">Henüz sesli kanal yok</div>
            : rooms.filter(r => r.type === 'voice').map(r => (
              <div key={r.roomHash}>
                <div className={`sb-room${activeVoiceRoom?.name === r.name ? ' active' : ''}`}
                  onClick={e => { e.stopPropagation(); setIsMobileMenuOpen(false); if (activeVoiceRoom?.name === r.name) { exec('/leave-voice', []); } else { const saved = JSON.parse(localStorage.getItem('sfn_keys') || '{}'); const key = saved[r.name]; if (key) { exec('/join-voice', [r.name, key]); } else { setInput(`/join-voice ${r.name} `); inputRef.current?.focus(); } } }}>
                  <span className="sb-hash">🔊</span><span className="sb-rname">{r.name}</span>
                  {activeVoiceRoom?.name === r.name && <span className="sb-dot" />}
                </div>
                {(r.activeUsers || []).map(u => (<div key={u} className="sb-voice-user"><span className="sb-voice-avatar">🎙️</span>{u}</div>))}
              </div>
            ))
          }

          <div className="sb-label" style={{marginTop:16}}>ÖZEL</div>
          <div className={`sb-room${activeRoom?.name === `notes-${username}` ? ' active' : ''}`}
            onClick={e => { e.stopPropagation(); setIsMobileMenuOpen(false); exec('/join', [`notes-${username}`, apiKey!]); }}>
            <span className="sb-hash">🔒</span><span className="sb-rname">Kişisel Notlar</span>
            {activeRoom?.name === `notes-${username}` && <span className="sb-dot" />}
          </div>
          <div className="sb-label" style={{marginTop:16}}>MESAJLAR</div>
          {dmUsers.map(dmUser => {
            const dmRoom = `dm-${[username, dmUser].sort().join('-')}`;
            return (
              <div key={dmUser} className={`sb-room${activeRoom?.name === dmRoom ? ' active' : ''}`}
                onClick={e => { e.stopPropagation(); setIsMobileMenuOpen(false); exec('/dm', [dmUser]); }}>
                <span className="sb-hash">💬</span><span className="sb-rname">{dmUser}</span>
                {activeRoom?.name === dmRoom && <span className="sb-dot" />}
              </div>
            );
          })}
          <div className="sb-dm-input-wrap">
            <input
              className="sb-dm-input"
              placeholder="Kullanıcı adı..."
              value={dmInput}
              onChange={e => setDmInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && dmInput.trim()) { exec('/dm', [dmInput.trim()]); setDmInput(''); setIsMobileMenuOpen(false); } }}
            />
          </div>
        </div>

        {voiceState.isActive && (
          <div className="sb-voice">
            <div className="sb-label">SESLİ BAĞLANTI</div>
            <div className="sb-voice-status"><span className="voice-indicator" />{voiceState.isMuted ? 'SESSİZ' : 'CANLI'}</div>
            {voiceState.peers.length > 0 && <div className="sb-voice-peers">{voiceState.peers.length} bağlı</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={() => toggleMute()} style={{ flex: 1, padding: '4px', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', cursor: 'pointer' }}>
                {voiceState.isMuted ? 'Mikrofonu Aç' : 'Sustur'}
              </button>
              <button onClick={() => shareScreen && shareScreen()} style={{ flex: 1, padding: '4px', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '4px', cursor: 'pointer' }}>
                Ekran Paylaş
              </button>
            </div>
            {voiceState.remoteStreams && voiceState.remoteStreams.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <div className="sb-label" style={{ marginBottom: '4px' }}>YAYINLAR</div>
                {voiceState.remoteStreams.map(rs => (
                  <video 
                    key={rs.peerId} 
                    autoPlay 
                    playsInline 
                    ref={v => { if (v && v.srcObject !== rs.stream) v.srcObject = rs.stream; }} 
                    style={{ width: '100%', borderRadius: '4px', background: '#000', marginBottom: '8px' }}
                    title={rs.peerId}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="sb-footer">
          <div className="sb-label">OTURUM</div>
          <div className="sb-timer">{expiry}</div>
          <div className="sb-enc">🔒 AES-GCM-256 · E2EE</div>
        </div>
      </aside>

      <div className="sfn-main">
        <header className="sfn-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="sfn-mobile-toggle" onClick={() => setIsMobileMenuOpen(prev => !prev)}>
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
            </button>
            <div className="hdr-brand"><span>Senfoni</span> <span className="hdr-thin">Chat</span></div>
          </div>
          <div className="hdr-right">
            {activeRoom && <span className="hdr-room"><span className="hdr-dot" /> {activeRoom.name.startsWith('dm-') ? '💬 ' + activeRoom.name.replace('dm-', '').replace(`-${username}`, '').replace(`${username}-`, '') : '#' + activeRoom.name}</span>}
            {voiceState.isActive && <span className="hdr-voice">{voiceState.isMuted ? '🔇' : '🎙'}</span>}
            {busy && <span className="hdr-busy">işleniyor...</span>}
            <span className="hdr-ver">v{APP_VERSION}</span>
          </div>
        </header>

        <main className="sfn-output" ref={outputRef}>
          {logs.map(log => {
            const isMentioned = username && log.text.toLowerCase().includes(`@${username.toLowerCase()}`);
            const isMsg = log.type === 'msg';
            const isOwn = log.isOwn;
            const { sender, content } = isMsg ? parseMsgSender(log.text) : { sender: '', content: log.text };

            if (isMsg) {
              return (
                <div key={log.id} className={`ll msg${isOwn ? ' own-msg' : ''}${isMentioned ? ' mention-pulse' : ''}`}>
                  {!isOwn && <div className="msg-sender">{sender}</div>}
                  <span className="ll-text">
                    {renderTextWithMentions(content, username)}
                    {log.file && (
                      <div className="sfn-file-preview">
                        {log.file.type.startsWith('image/') && log.file.dataUrl
                          ? <img src={log.file.dataUrl} alt={log.file.name} className="sfn-img" />
                          : <button className="sfn-file-btn" onClick={() => handleFileAction(log.id, log.file!)} disabled={log.file.loading || log.file.error}>
                              {log.file.loading ? '⏳ Çözümleniyor...' : log.file.error ? '❌ Başarısız' : log.file.dataUrl ? '💾 Tekrar İndir' : `📄 ${log.file.name} (${Math.round(log.file.size/1024)}KB)`}
                            </button>
                        }
                      </div>
                    )}
                  </span>
                  <div className="msg-meta">
                    <span>{log.time}</span>
                    {isOwn && log.status === 'sending' && <span className="ll-tick sending">🕒</span>}
                    {isOwn && log.status === 'sent' && <span className="ll-tick sent">✓✓</span>}
                  </div>
                </div>
              );
            }

            return (
              <div key={log.id} className={`ll ${log.type}${isMentioned ? ' mention-pulse' : ''}`}>
                {log.time && <span className="ll-time">{log.time}</span>}
                {log.type === 'admin' && <span className="ll-badge admin">[mod]</span>}
                {log.type === 'error' && <span className="ll-badge error">[!]</span>}
                {log.type === 'success' && <span className="ll-badge ok">[✓]</span>}
                {log.type === 'warn' && <span className="ll-badge warn">[!]</span>}
                <span className="ll-text">{renderTextWithMentions(log.text, username)}</span>
              </div>
            );
          })}
          <div ref={undefined} />
        </main>

        {typingUsers.filter(u => u !== username).length > 0 && (
          <div className="sfn-typing-indicator">
            <span className="sfn-typing-text">
              {(() => { const others = typingUsers.filter(u => u !== username); if (others.length === 1) return others[0]; if (others.length === 2) return `${others[0]} ve ${others[1]}`; return 'Birkaç kişi'; })()}
            </span>
            <span className="sfn-typing-suffix">{typingUsers.filter(u => u !== username).length > 2 ? ' yazıyorlar' : ' yazıyor'}</span>
            <div className="sfn-typing-dots"><span className="sfn-typing-dot" /><span className="sfn-typing-dot" /><span className="sfn-typing-dot" /></div>
          </div>
        )}

        <footer className="sfn-footer">
          <form onSubmit={handleSubmit} className="sfn-form">
            {username && (
              <button type="button" className="sfn-upload-btn" onClick={() => { if (!activeRoom) { add('Önce bir kanala katılın.', 'error'); return; } fileInputRef.current?.click(); }} disabled={busy} title="Dosya gönder">📎</button>
            )}
            <input ref={inputRef} type="text" className="sfn-input" value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') { e.preventDefault(); if (historyIdx < history.length - 1) { const n = historyIdx + 1; setHistoryIdx(n); setInput(history[n]); } }
                else if (e.key === 'ArrowDown') { e.preventDefault(); if (historyIdx > 0) { const n = historyIdx - 1; setHistoryIdx(n); setInput(history[n]); } else if (historyIdx === 0) { setHistoryIdx(-1); setInput(''); } }
              }}
              autoFocus spellCheck={false} autoComplete="off" autoCapitalize="off"
              placeholder={busy ? 'İşleniyor...' : activeRoom ? (activeRoom.name.startsWith('dm-') ? `${activeRoom.name.replace('dm-', '').replace(`-${username}`, '').replace(`${username}-`, '')} ile mesajlaş...` : `#${activeRoom.name} kanalına mesaj yaz...`) : 'DM için sidebar\'dan kişi seç...'} disabled={busy} />
            <button type="submit" className="sfn-send-btn" disabled={busy || !input.trim()}>
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </form>
          <div className="sfn-bar"><span>🔒 UÇTAN UCA ŞİFRELİ</span><span>·</span><span>SENFONI SECURE PROTOCOL</span></div>
        </footer>
        <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{display: 'none'}} />
      </div>
    </div>
  );
}
