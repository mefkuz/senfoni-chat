'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

// TURN server configuration via environment variables
const TURN_HOST = process.env.NEXT_PUBLIC_TURN_HOST || 'localhost';
const TURN_SECRET = process.env.NEXT_PUBLIC_TURN_SECRET || 'changeme';

// Generate time-limited TURN credentials (RFC 5766 HMAC-SHA1)
function getTurnCredentials() {
  const ttl = 86400; // 24h
  const unixTime = Math.floor(Date.now() / 1000) + ttl;
  const username = `${unixTime}:senfoni`;
  // Browser can't run crypto in this context, use static for now
  // In production: generate server-side via /api/turn-creds
  return { username, credential: TURN_SECRET };
}

const { username: TURN_USER, credential: TURN_CRED } = getTurnCredentials();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: `stun:${TURN_HOST}:3478` },
  {
    urls: [
      `turn:${TURN_HOST}:3478?transport=udp`,
      `turn:${TURN_HOST}:3478?transport=tcp`,
      `turns:${TURN_HOST}:5349`,
    ],
    username: TURN_USER,
    credential: TURN_CRED,
  },
];
const SIGNAL_POLL_MS = 1000;

interface VoiceState {
  isActive: boolean;
  isMuted: boolean;
  peers: string[];
  error: string | null;
  remoteStreams: { peerId: string; stream: MediaStream }[];
  isScreenSharing: boolean;
}

export function useVoiceChat(
  username: string | null,
  apiKey: string | null,
  addLog: (text: string, type?: string) => void,
) {
  const [state, setState] = useState<VoiceState>({ isActive: false, isMuted: false, peers: [], error: null, remoteStreams: [], isScreenSharing: false });
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sinceRef = useRef<number>(0);
  const activeRef = useRef(false);
  const activeRoomHashRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    activeRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    pcsRef.current.forEach(pc => pc.close());
    pcsRef.current.clear();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setState({ isActive: false, isMuted: false, peers: [], error: null, remoteStreams: [], isScreenSharing: false });
    activeRoomHashRef.current = null;
  }, []);

  useEffect(() => { return cleanup; }, [cleanup]);

  const sendSignal = useCallback(async (type: string, data: string, target?: string) => {
    const rHash = activeRoomHashRef.current;
    if (!rHash || !apiKey) return;
    try {
      await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Key': apiKey },
        body: JSON.stringify({ room: rHash, type, target, data }),
      });
    } catch {}
  }, [apiKey]);

  const createPeerConnection = useCallback((peerId: string) => {
    if (pcsRef.current.has(peerId)) return pcsRef.current.get(peerId)!;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcsRef.current.set(peerId, pc);

    // Add local audio tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current!));
    }

    // Handle remote tracks (audio + video)
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      setState(s => {
        // Remove existing stream for this peer if any
        const filtered = s.remoteStreams.filter(rs => rs.peerId !== peerId);
        return { ...s, remoteStreams: [...filtered, { peerId, stream }] };
      });
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal('candidate', JSON.stringify(e.candidate), peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setState(s => ({ ...s, peers: [...new Set([...s.peers, peerId])] }));
      }
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        pcsRef.current.delete(peerId);
        setState(s => ({ ...s, peers: s.peers.filter(p => p !== peerId) }));
      }
    };

    return pc;
  }, [sendSignal]);

  const handleSignal = useCallback(async (signal: any) => {
    if (signal.sender === username) return;

    if (signal.type === 'announce') {
      const pc = createPeerConnection(signal.sender);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal('offer', JSON.stringify(offer), signal.sender);
    }

    if (signal.type === 'offer' && signal.target === username) {
      const pc = createPeerConnection(signal.sender);
      await pc.setRemoteDescription(JSON.parse(signal.data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal('answer', JSON.stringify(answer), signal.sender);
    }

    if (signal.type === 'answer' && signal.target === username) {
      const pc = pcsRef.current.get(signal.sender);
      if (pc) await pc.setRemoteDescription(JSON.parse(signal.data));
    }

    if (signal.type === 'candidate' && signal.target === username) {
      const pc = pcsRef.current.get(signal.sender);
      if (pc) {
        try { await pc.addIceCandidate(JSON.parse(signal.data)); } catch {}
      }
    }

    if (signal.type === 'leave') {
      const pc = pcsRef.current.get(signal.sender);
      if (pc) { pc.close(); pcsRef.current.delete(signal.sender); }
      setState(s => ({ ...s, peers: s.peers.filter(p => p !== signal.sender) }));
    }
  }, [username, createPeerConnection, sendSignal]);

  const joinVoice = useCallback(async (rHash: string) => {
    if (!rHash || !username || !apiKey) { addLog('ERR: Must specify voice room.', 'error'); return; }

    try {
      activeRoomHashRef.current = rHash;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      activeRef.current = true;
      sinceRef.current = Date.now();

      setState({ isActive: true, isMuted: false, peers: [], error: null, remoteStreams: [], isScreenSharing: false });
      addLog('VOICE: Microphone active. Connecting...', 'success');

      // Start polling for signaling messages
      const poll = async () => {
        if (!activeRef.current) return;
        try {
          const res = await fetch(`/api/voice?room=${rHash}&since=${sinceRef.current}&user=${username}`, {
            headers: { 'X-Caller-Key': apiKey }
          });
          const signals: any[] = await res.json();
          if (Array.isArray(signals)) {
            for (const s of signals) {
              if (s.sender !== username) {
                await handleSignal(s);
                if (s.timestamp > sinceRef.current) sinceRef.current = s.timestamp;
              }
            }
          }
        } catch {}
      };

      pollRef.current = setInterval(poll, SIGNAL_POLL_MS);
      poll();

      // Announce presence by sending an announce broadcast
      sendSignal('announce', '{}');

    } catch (err: any) {
      const msg = err?.message?.includes('Permission') ? 'Microphone permission denied.' : 'Failed to access microphone.';
      addLog(`ERR: ${msg}`, 'error');
      setState(s => ({ ...s, error: msg }));
    }
  }, [username, apiKey, addLog, sendSignal, handleSignal]);

  const leaveVoice = useCallback(() => {
    if (activeRef.current && activeRoomHashRef.current) {
      sendSignal('leave', JSON.stringify({ username }));
    }
    cleanup();
    activeRoomHashRef.current = null;
    addLog('VOICE: Disconnected.', 'system');
  }, [username, sendSignal, cleanup, addLog]);

  const toggleMute = useCallback(() => {
    if (streamRef.current) {
      const enabled = !state.isMuted;
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = !enabled; });
      setState(s => ({ ...s, isMuted: enabled }));
      addLog(enabled ? 'VOICE: Muted.' : 'VOICE: Unmuted.', 'system');
    }
  }, [state.isMuted, addLog]);

  
  const shareScreen = useCallback(async () => {
    if (!activeRef.current || state.isScreenSharing) return;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      
      setState(s => ({ ...s, isScreenSharing: true }));

      screenTrack.onended = () => {
        // Stop sharing
        pcsRef.current.forEach(pc => {
          const senders = pc.getSenders();
          const sender = senders.find(s => s.track?.kind === 'video');
          if (sender) pc.removeTrack(sender);
        });
        setState(s => ({ ...s, isScreenSharing: false }));
      };

      pcsRef.current.forEach(pc => {
        pc.addTrack(screenTrack, streamRef.current!);
      });
      // We also need to renegotiate, but since simple P2P, we might need to send a new offer.
      // To keep it simple, we just send an 'announce' to trigger renegotiation.
      sendSignal('announce', '{}');
    } catch (err) {
      addLog('Ekran paylasimi iptal edildi veya hata olustu.', 'error');
    }
  }, [sendSignal, addLog]);

  return { voiceState: state, joinVoice, leaveVoice, toggleMute, shareScreen };
}

