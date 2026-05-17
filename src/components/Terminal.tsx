'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { encryptMessage, decryptMessage, deriveKey, encryptFile, decryptFile, b64Encode } from '@/lib/crypto';
import { POLLING_INTERVAL_MS, SESSION_TIMEOUT_MS, APP_VERSION, MAX_FILE_SIZE_BYTES } from '@/lib/constants';
import { useVoiceChat } from '@/hooks/useVoiceChat';

interface LogEntry { id: string; text: string; type: 'system'|'user'|'admin'|'error'|'msg'|'success'|'warn'; time: string; isOwn?: boolean; status?: 'sending'|'sent'; file?: { id: string, name: string, type: string, size: number, dataUrl?: string, loading?: boolean, error?: boolean }; }
interface RoomInfo { name: string; roomHash: string; type?: 'text'|'voice'; activeUsers?: string[]; }
interface ActiveRoom { name: string; hash: string; cryptoKey: CryptoKey; }

let _c = 0;
const uid = () => `l${++_c}`;
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function Terminal() {
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    { id: uid(), text: '╔══════════════════════════════════════════╗', type: 'system', time: '' },
    { id: uid(), text: '║     SENFONI CHAT  ·  Secure Protocol      ║', type: 'system', time: '' },
    { id: uid(), text: `║     Version ${APP_VERSION}  ·  E2EE Enabled        ║`, type: 'system', time: '' },
    { id: uid(), text: '╚══════════════════════════════════════════╝', type: 'system', time: '' },
    { id: uid(), text: 'System: PROTECTED. Unauthorized access prohibited.', type: 'system', time: ts() },
    { id: uid(), text: 'Type /help for available commands.', type: 'system', time: ts() },
  ]);

  const [input, setInput]           = useState('');
  const [username, setUsername]     = useState<string|null>(null);
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

  // Load theme
  useEffect(() => {
    const t = localStorage.getItem('sfn_theme') || 'default';
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
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

  const add = useCallback((text: string, type: LogEntry['type'] = 'system') => {
    setLogs(p => [...p, { id: uid(), text, type, time: ts() }]);
  }, []);

  const { voiceState, joinVoice, leaveVoice, toggleMute } = useVoiceChat(
    username, apiKey, add as any
  );

  const hasCheckedSetup = useRef(false);

  // Setup Check
  useEffect(() => {
    if (hasCheckedSetup.current) return;
    hasCheckedSetup.current = true;

    fetch('/api/setup').then(r => r.json()).then(d => {
      if (d.uninitialized) {
        add('System uninitialized. No admin found.', 'error');
        add('Type /setup [username] to claim the server.', 'warn');
      }
    }).catch(() => {});
  }, [add]);

  // Auto-scroll (only if near bottom)
  useEffect(() => { 
    if (!outputRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    if (scrollHeight - scrollTop - clientHeight < 150) {
      outputRef.current.scrollTo({ top: scrollHeight, behavior: 'smooth' }); 
    }
  }, [logs]);

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
        const r = await fetch(`/api/messages?room=${activeRoom.hash}&since=${lastPoll}`);
        const msgs: any[] = await r.json();
        if (!Array.isArray(msgs) || !msgs.length) return;
        const entries: LogEntry[] = [];
        let maxTs = lastPoll;
        for (const m of msgs) {
          if (seenIds.has(m.id)) continue;
          seenIds.add(m.id);
          try {
            const plain = await decryptMessage(m.ciphertext, m.iv, activeRoom.cryptoKey);
            const entry: LogEntry = { id: uid(), text: `${m.sender}: ${plain}`, type: 'msg', time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' }), isOwn: m.sender === username, status: 'sent' };
            if (m.fileId) {
              entry.file = { id: m.fileId, name: m.fileName, type: m.fileType, size: m.fileSize };
              entry.text = `${m.sender}: [Sent File]`;
            }
            entries.push(entry);
            if (m.timestamp > maxTs) maxTs = m.timestamp;
          } catch {}
        }
        if (entries.length) { setLogs(p => [...p, ...entries]); setLastPoll(maxTs); }
      } catch {}
    };
    const t = setInterval(poll, POLLING_INTERVAL_MS);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom, apiKey, lastPoll]);

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
      if (d.id) seenIds.add(d.id);
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
        if (d.messageId) seenIds.add(d.messageId);
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
    if (!raw.startsWith('/')) {
      if (activeRoom && apiKey && username) await sendMsg(raw);
      else add('ERR: Join a room first. /join [room] [key]', 'error');
      return;
    }
    add(`$ ${raw}`, 'user');
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
          if (d.role === 'admin') {
            add(`ACCESS GRANTED — [${d.username}] MODERATOR`, 'admin');
            // Admin auto-joins: load all rooms into sidebar immediately
            const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': args[0] } });
            const rd = await rr.json();
            if (rd.rooms) setRooms(rd.rooms);
          } else {
            add(`ACCESS GRANTED — [${d.username}] USER`, 'success');
          }
          add(`Session expires in 24h. /help for commands.`);
        } catch { add('ERR: Connection failed.', 'error'); }
        break;

      case '/join':
        if (!username) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /join [room] [key]', 'error'); break; }
        add(`Connecting to [#${args[0]}]...`);
        try {
          const salt = new TextEncoder().encode('senfoni-salt-' + args[0]);
          const cKey = await deriveKey(args[1], salt);
          const rHash = await hashStr('senfoni-room-' + args[0]);
          setActiveRoom({ name: args[0], hash: rHash, cryptoKey: cKey });
          setLastPoll(0); setSeenIds(new Set());
          
          // Save key for auto-join next time
          if (!args[0].startsWith('notes-')) {
            const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
            saved[args[0]] = args[1];
            sessionStorage.setItem('sfn_keys', JSON.stringify(saved));
          }

          add(`E2EE LINK — [#${args[0]}] active.`, 'success');
          // Load history
          const hr = await fetch(`/api/messages?room=${rHash}`);
          const hist: any[] = await hr.json();
          if (Array.isArray(hist) && hist.length) {
            const entries: LogEntry[] = [];
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
            add(`── ${entries.length} message(s) loaded ──`);
            setLogs(p => [...p, ...entries]);
          }
        } catch { add('ERR: Failed to join.', 'error'); }
        break;

      case '/leave':
        if (!activeRoom) { add('Not in a text room.', 'error'); break; }
        add(`Left [#${activeRoom.name}].`);
        setActiveRoom(null); setLastPoll(0); setSeenIds(new Set());
        break;

      case '/join-voice':
        if (!username) { add('ERR: LOGIN_REQUIRED', 'error'); break; }
        if (args.length < 2) { add('USAGE: /join-voice [room] [key]', 'error'); break; }
        add(`Connecting to [🔊${args[0]}]...`);
        try {
          const rHash = await hashStr('senfoni-room-' + args[0]);
          setActiveVoiceRoom({ name: args[0], hash: rHash });
          
          const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
          saved[args[0]] = args[1];
          sessionStorage.setItem('sfn_keys', JSON.stringify(saved));
          
          joinVoice(rHash);
        } catch { add('ERR: Failed to join voice.', 'error'); }
        break;

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
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'create-room', name:args[0] }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        
        const genKey = Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6);
        add(`Room Key: ${genKey}  (Share this with users so they can join!)`, 'success');
        
        const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
        saved[args[0]] = genKey;
        sessionStorage.setItem('sfn_keys', JSON.stringify(saved));

        // Refresh sidebar
        const rr = await fetch('/api/rooms', { headers: { 'X-Caller-Key': apiKey! } });
        const rd = await rr.json();
        if (rd.rooms) setRooms(rd.rooms);
        break;
      }
      case '/create-voice-room': {
        if (role !== 'admin') { add('UNAUTHORIZED', 'error'); break; }
        if (!args[0]) { add('USAGE: /create-voice-room [name]', 'error'); break; }
        const r = await fetch('/api/admin', { method:'POST', headers:{'Content-Type':'application/json','X-Senfoni-Key':apiKey!}, body: JSON.stringify({ action:'create-room', name:args[0], type:'voice' }) });
        const d = await r.json();
        if (d.error) { add(`ERR: ${d.error}`, 'error'); break; }
        add(d.message, 'admin');
        
        const genKey = Math.random().toString(36).slice(-6) + Math.random().toString(36).slice(-6);
        add(`Voice Room Key: ${genKey}  (Share this with users so they can join!)`, 'success');
        
        const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
        saved[args[0]] = genKey;
        sessionStorage.setItem('sfn_keys', JSON.stringify(saved));

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

  return (
    <div className="sfn-container" onClick={() => inputRef.current?.focus()}>
      <div className="scanline" aria-hidden="true" />

      {username && (
        <aside className="sfn-sidebar">
          <div className="sb-identity">
            <div className="sb-label">IDENTITY</div>
            <div className="sb-user">
              {role === 'admin' && <span className="badge-mod">MOD</span>}
              <span>{username}</span>
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-label">CHANNELS</div>
            {rooms.filter(r => r.type !== 'voice').length === 0
              ? <div className="sb-empty">no text channels</div>
              : rooms.filter(r => r.type !== 'voice').map(r => (
                <div key={r.roomHash} className={`sb-room${activeRoom?.name === r.name ? ' active' : ''}`}
                  onClick={e => { 
                    e.stopPropagation(); 
                    const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
                    const key = saved[r.name] || (role === 'admin' ? `admin-secret-${r.name}` : null);
                    if (key) {
                      exec('/join', [r.name, key]);
                    } else {
                      setInput(`/join ${r.name} `); 
                      inputRef.current?.focus(); 
                    }
                  }}>
                  <span className="sb-hash">#</span>
                  <span className="sb-rname">{r.name}</span>
                  {activeRoom?.name === r.name && <span className="sb-dot" />}
                </div>
              ))
            }
          </div>

          <div className="sb-section">
            <div className="sb-label">VOICE CHANNELS</div>
            {rooms.filter(r => r.type === 'voice').length === 0
              ? <div className="sb-empty">no voice channels</div>
              : rooms.filter(r => r.type === 'voice').map(r => (
                <div key={r.roomHash}>
                  <div className={`sb-room${activeVoiceRoom?.name === r.name ? ' active' : ''}`}
                    onClick={e => { 
                      e.stopPropagation(); 
                      if (activeVoiceRoom?.name === r.name) {
                        exec('/leave-voice', []);
                      } else {
                        const saved = JSON.parse(sessionStorage.getItem('sfn_keys') || '{}');
                        const key = saved[r.name] || (role === 'admin' ? `admin-secret-${r.name}` : null);
                        if (key) {
                          exec('/join-voice', [r.name, key]);
                        } else {
                          setInput(`/join-voice ${r.name} `); 
                          inputRef.current?.focus(); 
                        }
                      }
                    }}>
                    <span className="sb-hash">🔊</span>
                    <span className="sb-rname">{r.name}</span>
                    {activeVoiceRoom?.name === r.name && <span className="sb-dot" />}
                  </div>
                  {(r.activeUsers || []).map(u => (
                    <div key={u} className="sb-voice-user">
                      <span className="sb-voice-avatar">🎙️</span>
                      {u}
                    </div>
                  ))}
                </div>
              ))
            }
          </div>

          <div className="sb-section">
            <div className="sb-label">PRIVATE</div>
            <div className={`sb-room${activeRoom?.name === `notes-${username}` ? ' active' : ''}`}
                 onClick={e => { e.stopPropagation(); exec('/join', [`notes-${username}`, apiKey!]); }}>
              <span className="sb-hash">🔒</span>
              <span className="sb-rname">Personal Notes</span>
              {activeRoom?.name === `notes-${username}` && <span className="sb-dot" />}
            </div>
          </div>

          {voiceState.isActive && (
            <div className="sb-voice">
              <div className="sb-label">VOICE</div>
              <div className="sb-voice-status">
                <span className="voice-indicator" />
                {voiceState.isMuted ? 'MUTED' : 'LIVE'}
              </div>
              {voiceState.peers.length > 0 && (
                <div className="sb-voice-peers">{voiceState.peers.length} peer(s)</div>
              )}
            </div>
          )}

          <div className="sb-footer">
            <div className="sb-label">SESSION</div>
            <div className="sb-timer">{expiry}</div>
            <div className="sb-enc">AES-GCM-256 · E2EE</div>
          </div>
        </aside>
      )}

      <div className="sfn-main">
        <header className="sfn-header">
          <div className="hdr-brand">SENFONI <span className="hdr-thin">CHAT</span></div>
          <div className="hdr-right">
            {activeRoom && <span className="hdr-room"><span className="hdr-dot" />#{activeRoom.name}</span>}
            {voiceState.isActive && <span className="hdr-voice">{voiceState.isMuted ? '🔇' : '🎙'}</span>}
            {busy && <span className="hdr-busy">working...</span>}
            <span className="hdr-ver">v{APP_VERSION}</span>
          </div>
        </header>

        <main className="sfn-output" ref={outputRef}>
          {logs.map(log => (
            <div key={log.id} className={`ll ${log.type}`}>
              {log.time && <span className="ll-time">{log.time}</span>}
              {log.type === 'admin'   && <span className="ll-badge admin">[melodi]</span>}
              {log.type === 'error'   && <span className="ll-badge error">[fail]</span>}
              {log.type === 'success' && <span className="ll-badge ok">[ok]</span>}
              {log.type === 'warn'    && <span className="ll-badge warn">[warn]</span>}
              <span className="ll-text">
                {log.text}
                {log.file && (
                  <div className="sfn-file-preview">
                    {log.file.type.startsWith('image/') && log.file.dataUrl ? (
                      <img src={log.file.dataUrl} alt={log.file.name} className="sfn-img" />
                    ) : (
                      <button className="sfn-file-btn" onClick={() => handleFileAction(log.id, log.file!)} disabled={log.file.loading || log.file.error}>
                        {log.file.loading ? '⏳ Decrypting...' : log.file.error ? '❌ Decrypt Failed' : log.file.dataUrl ? '💾 Download Again' : `📄 ${log.file.name} (${Math.round(log.file.size/1024)}KB)`}
                      </button>
                    )}
                  </div>
                )}
                {log.isOwn && log.status === 'sending' && <span className="ll-tick sending"> 🕒</span>}
                {log.isOwn && log.status === 'sent' && <span className="ll-tick sent"> ✓✓</span>}
              </span>
            </div>
          ))}
          <div className="ll system"><span className="blink">█</span></div>
        </main>

        <footer className="sfn-footer">
          <form onSubmit={handleSubmit} className="sfn-form">
            <span className="sfn-prompt">{username||'guest'}:{activeRoom?`#${activeRoom.name}`:'~'}$</span>
            <input ref={inputRef} type="text" className="sfn-input" value={input}
              onChange={e => { setInput(e.target.value); setHistoryIdx(-1); }} 
              onKeyDown={e => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (historyIdx < history.length - 1) {
                    const nextIdx = historyIdx + 1;
                    setHistoryIdx(nextIdx);
                    setInput(history[nextIdx]);
                  }
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (historyIdx > 0) {
                    const nextIdx = historyIdx - 1;
                    setHistoryIdx(nextIdx);
                    setInput(history[nextIdx]);
                  } else if (historyIdx === 0) {
                    setHistoryIdx(-1);
                    setInput('');
                  }
                }
              }}
              autoFocus spellCheck={false}
              autoComplete="off" autoCapitalize="off" placeholder={busy?'processing...':''} disabled={busy} />
            {username && (
              <button 
                type="button" 
                className="sfn-upload-btn" 
                onClick={() => {
                  if (!activeRoom) { add('ERR: Join a room first.', 'error'); return; }
                  fileInputRef.current?.click();
                }}
                disabled={busy}
                title="Upload file or image"
              >
                📎
              </button>
            )}
          </form>
          <div className="sfn-bar">
            <span>END-TO-END ENCRYPTED</span><span>·</span><span>SENFONI SECURE PROTOCOL</span>
          </div>
        </footer>
        <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{display: 'none'}} />
      </div>
    </div>
  );
}
