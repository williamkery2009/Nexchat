import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ═══════════════════════════ CRYPTO ═══════════════════════════
const SALT = new TextEncoder().encode("securechat-e2e-salt-v1");
async function deriveKey(pw) {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), { name: "PBKDF2" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: SALT, iterations: 100000, hash: "SHA-256" }, raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptMsg(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  const b64 = a => btoa(String.fromCharCode(...new Uint8Array(a)));
  return { content: b64(buf), iv: b64(iv) };
}
async function decryptMsg(key, content, iv) {
  try {
    const fb = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fb(iv) }, key, fb(content)));
  } catch { return "🔒 [Encrypted]"; }
}

const EMOJIS = ["👍","❤️","😂","😮","😢","🔥"];
const C = {
  bg:"#080c14", surface:"#0d1422", s2:"#111827", s3:"#0f1930",
  border:"#1a2540", accent:"#00d4ff", green:"#25d366", purple:"#7c3aed",
  text:"#c8d8e8", muted:"#3a5070", danger:"#ff6b6b", warn:"#f59e0b",
  read:"#53bdeb"
};

// ═══════════════════════════ APP ═══════════════════════════
export default function App() {
  const [config, setConfig]         = useState(() => { try { return JSON.parse(localStorage.getItem("nextalk_cfg")); } catch { return null; } });
  const [sb, setSb]                 = useState(null);
  const [key, setKey]               = useState(null);
  const [user, setUser]             = useState(null);
  const [profile, setProfile]       = useState(null);
  const [screen, setScreen]         = useState("config");

  // Rooms & DMs
  const [rooms, setRooms]           = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [dmChannels, setDmChannels] = useState([]);
  const [activeDM, setActiveDM]     = useState(null);
  const [activeView, setActiveView] = useState("room"); // "room" | "dm" | "starred"

  // Messages & metadata
  const [messages, setMessages]       = useState([]);
  const [reactions, setReactions]     = useState({});
  const [readReceipts, setReadReceipts] = useState({});
  const [starredIds, setStarredIds]   = useState(new Set());
  const [pinnedMsg, setPinnedMsg]     = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [starredMsgs, setStarredMsgs] = useState([]);

  // UI state
  const [users, setUsers]             = useState([]);
  const [input, setInput]             = useState("");
  const [replyTo, setReplyTo]         = useState(null);
  const [forwardMsg, setForwardMsg]   = useState(null);
  const [emojiPicker, setEmojiPicker] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [uploading, setUploading]     = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showStarred, setShowStarred] = useState(false);

  // Auth & config forms
  const [authMode, setAuthMode]   = useState("login");
  const [authForm, setAuthForm]   = useState({ email:"", password:"", username:"" });
  const [cfgForm,  setCfgForm]    = useState({ url:"", key:"", roomPass:"" });
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");

  // Refs
  const msgEndRef     = useRef(null);
  const fileRef       = useRef(null);
  const audioRef      = useRef(null);
  const mediaRec      = useRef(null);
  const audioChunks   = useRef([]);
  const typingTimer   = useRef(null);

  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);

  // ── INIT SUPABASE + KEY ──
  useEffect(() => {
    if (!config) { setScreen("config"); return; }
    const client = createClient(config.url, config.key);
    setSb(client);
    deriveKey(config.roomPass).then(setKey);
    setScreen("auth");
  }, [config]);

  // ── AUTH ──
  useEffect(() => {
    if (!sb) return;
    sb.auth.getSession().then(({ data: { session } }) => { if (session?.user) { setUser(session.user); setScreen("chat"); } });
    const { data: { subscription } } = sb.auth.onAuthStateChange((_, s) => {
      if (s?.user) { setUser(s.user); setScreen("chat"); } else { setUser(null); setScreen("auth"); }
    });
    return () => subscription.unsubscribe();
  }, [sb]);

  // ── CHAT INIT ──
  useEffect(() => {
    if (!sb || !user || !key || screen !== "chat") return;

    // Push notifications permission
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();

    const markOnline = v => sb.from("profiles").update({ is_online: v, last_seen: new Date().toISOString() }).eq("id", user.id);

    const init = async () => {
      markOnline(true);
      const { data: prof } = await sb.from("profiles").select("*").eq("id", user.id).single();
      if (prof) setProfile(prof);
      const { data: rms } = await sb.from("rooms").select("*").order("created_at");
      if (rms?.length) { setRooms(rms); setActiveRoom(rms[0]); }
      const { data: us } = await sb.from("profiles").select("*");
      if (us) setUsers(us);
      // Load DM channels
      const { data: dms } = await sb.from("dm_channels").select("*, user1:profiles!dm_channels_user1_id_fkey(*), user2:profiles!dm_channels_user2_id_fkey(*)").or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`);
      if (dms) setDmChannels(dms);
      // Load starred
      const { data: st } = await sb.from("starred_messages").select("message_id").eq("user_id", user.id);
      if (st) setStarredIds(new Set(st.map(s => s.message_id)));
    };
    init();

    const roomCh = sb.channel("rooms_ch")
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"rooms" }, p => setRooms(prev => [...prev, p.new]))
      .subscribe();

    const userCh = sb.channel("users_ch")
      .on("postgres_changes", { event:"UPDATE", schema:"public", table:"profiles" }, p => {
        setUsers(prev => prev.map(u => u.id === p.new.id ? p.new : u));
        // Typing indicator
        if (p.new.id !== user.id) {
          const isTypingHere = p.new.typing_in === activeRoom?.id || p.new.typing_in === activeDM?.id;
          const elapsed = p.new.typing_updated_at ? (Date.now() - new Date(p.new.typing_updated_at).getTime()) : 9999;
          if (isTypingHere && elapsed < 4000) setTypingUsers(prev => [...new Set([...prev, p.new.username])]);
          else setTypingUsers(prev => prev.filter(u => u !== p.new.username));
        }
      })
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"profiles" }, p => setUsers(prev => [...prev.filter(u=>u.id!==p.new.id), p.new]))
      .subscribe();

    const rxCh = sb.channel("starred_ch")
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"starred_messages", filter:`user_id=eq.${user.id}` },
        p => setStarredIds(prev => new Set([...prev, p.new.message_id])))
      .on("postgres_changes", { event:"DELETE", schema:"public", table:"starred_messages" },
        p => setStarredIds(prev => { const n = new Set(prev); n.delete(p.old.message_id); return n; }))
      .subscribe();

    const dmCh = sb.channel("dm_ch")
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"dm_channels" }, async p => {
        const { data } = await sb.from("dm_channels").select("*, user1:profiles!dm_channels_user1_id_fkey(*), user2:profiles!dm_channels_user2_id_fkey(*)").eq("id", p.new.id).single();
        if (data) setDmChannels(prev => [...prev.filter(d=>d.id!==data.id), data]);
      })
      .subscribe();

    const hb = setInterval(() => markOnline(true), 25000);
    const onUnload = () => markOnline(false);
    window.addEventListener("beforeunload", onUnload);
    return () => { roomCh.unsubscribe(); userCh.unsubscribe(); rxCh.unsubscribe(); dmCh.unsubscribe(); clearInterval(hb); window.removeEventListener("beforeunload", onUnload); markOnline(false); };
  }, [sb, user, key, screen]);

  // ── LOAD ROOM / DM MESSAGES ──
  const loadMessages = useCallback(async (channelId, isDM = false) => {
    if (!sb || !key) return;
    setMessages([]); setReactions({}); setReadReceipts({}); setPinnedMsg(null); setTypingUsers([]);

    const query = isDM
      ? sb.from("messages").select("*").eq("dm_channel_id", channelId).order("created_at").limit(100)
      : sb.from("messages").select("*").eq("room_id", channelId).is("dm_channel_id", null).order("created_at").limit(100);

    const { data } = await query;
    if (!data) return;

    const dec = await Promise.all(data.map(async m => ({
      ...m,
      text: m.is_deleted_everyone ? null : await decryptMsg(key, m.content, m.iv),
      reply_text: m.reply_preview && !m.is_deleted_everyone ? await decryptMsg(key, m.reply_preview, m.reply_iv).catch(()=>"") : null
    })));
    setMessages(dec);

    // Find pinned
    const pinned = dec.filter(m => m.is_pinned && !m.is_deleted_everyone);
    if (pinned.length) setPinnedMsg(pinned[pinned.length - 1]);

    // Load reactions
    const msgIds = dec.map(m => m.id);
    if (msgIds.length) {
      const { data: rxData } = await sb.from("reactions").select("*").in("message_id", msgIds);
      if (rxData) {
        const map = {};
        rxData.forEach(r => { if (!map[r.message_id]) map[r.message_id] = {}; if (!map[r.message_id][r.emoji]) map[r.message_id][r.emoji] = []; map[r.message_id][r.emoji].push({ user_id: r.user_id, username: r.username }); });
        setReactions(map);
      }
      // Load read receipts
      const { data: rrData } = await sb.from("read_receipts").select("*").in("message_id", msgIds);
      if (rrData) {
        const rrMap = {};
        rrData.forEach(r => { if (!rrMap[r.message_id]) rrMap[r.message_id] = []; rrMap[r.message_id].push(r.user_id); });
        setReadReceipts(rrMap);
      }
      // Mark messages as read
      const unreadIds = dec.filter(m => m.sender_id !== user.id).map(m => m.id);
      if (unreadIds.length) {
        const inserts = unreadIds.map(id => ({ message_id: id, user_id: user.id }));
        await sb.from("read_receipts").upsert(inserts, { onConflict: "message_id,user_id" });
        setReadReceipts(prev => { const n = {...prev}; unreadIds.forEach(id => { if (!n[id]) n[id] = []; if (!n[id].includes(user.id)) n[id] = [...n[id], user.id]; }); return n; });
      }
    }
  }, [sb, key, user]);

  useEffect(() => { if (activeRoom && activeView === "room") loadMessages(activeRoom.id, false); }, [activeRoom, activeView]);
  useEffect(() => { if (activeDM && activeView === "dm") loadMessages(activeDM.id, true); }, [activeDM, activeView]);

  // Realtime subscriptions for active channel
  useEffect(() => {
    if (!sb || !key || !user) return;
    const channelId = activeView === "dm" ? activeDM?.id : activeRoom?.id;
    if (!channelId) return;
    const isDM = activeView === "dm";

    const msgCh = sb.channel(`msgs_${channelId}`)
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"messages", filter: isDM ? `dm_channel_id=eq.${channelId}` : `room_id=eq.${channelId}` },
        async p => {
          const m = p.new;
          if (m.dm_channel_id && !isDM) return;
          const text = await decryptMsg(key, m.content, m.iv);
          const reply_text = m.reply_preview ? await decryptMsg(key, m.reply_preview, m.reply_iv).catch(()=>"") : null;
          setMessages(prev => prev.find(x => x.id === m.id) ? prev : [...prev, { ...m, text, reply_text }]);
          // Mark as read if not own message
          if (m.sender_id !== user.id) {
            await sb.from("read_receipts").upsert({ message_id: m.id, user_id: user.id }, { onConflict: "message_id,user_id" });
            setReadReceipts(prev => { const n={...prev}; if(!n[m.id]) n[m.id]=[]; if(!n[m.id].includes(user.id)) n[m.id]=[...n[m.id],user.id]; return n; });
          }
          // Push notification if tab hidden
          if (m.sender_id !== user.id && document.hidden && Notification.permission === "granted") {
            new Notification(`💬 ${m.sender_name}`, { body: text.slice(0, 60), icon: "/favicon.ico" });
          }
        })
      .on("postgres_changes", { event:"UPDATE", schema:"public", table:"messages" },
        p => setMessages(prev => prev.map(m => m.id === p.new.id ? { ...m, is_pinned: p.new.is_pinned, is_deleted_everyone: p.new.is_deleted_everyone, pinned_at: p.new.pinned_at } : m)))
      .on("postgres_changes", { event:"DELETE", schema:"public", table:"messages" },
        p => setMessages(prev => prev.filter(m => m.id !== p.old.id)))
      .subscribe();

    const rrCh = sb.channel(`rr_${channelId}`)
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"read_receipts" },
        p => { const r = p.new; setReadReceipts(prev => { const n={...prev}; if(!n[r.message_id]) n[r.message_id]=[]; if(!n[r.message_id].includes(r.user_id)) n[r.message_id]=[...n[r.message_id],r.user_id]; return n; }); })
      .subscribe();

    const rxCh2 = sb.channel(`rx2_${channelId}`)
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"reactions" },
        p => { const r=p.new; setReactions(prev => { const n={...prev}; if(!n[r.message_id]) n[r.message_id]={}; if(!n[r.message_id][r.emoji]) n[r.message_id][r.emoji]=[]; if(!n[r.message_id][r.emoji].find(x=>x.user_id===r.user_id)) n[r.message_id][r.emoji]=[...n[r.message_id][r.emoji],{user_id:r.user_id,username:r.username}]; return n; }); })
      .on("postgres_changes", { event:"DELETE", schema:"public", table:"reactions" },
        p => { const r=p.old; setReactions(prev => { const n={...prev}; if(n[r.message_id]?.[r.emoji]) { n[r.message_id][r.emoji]=n[r.message_id][r.emoji].filter(x=>x.user_id!==r.user_id); if(!n[r.message_id][r.emoji].length) delete n[r.message_id][r.emoji]; } return n; }); })
      .subscribe();

    return () => { msgCh.unsubscribe(); rrCh.unsubscribe(); rxCh2.unsubscribe(); };
  }, [sb, key, user, activeRoom, activeDM, activeView]);

  // ── HANDLERS ──

  const handleAuth = async e => {
    e.preventDefault(); setLoading(true); setError("");
    if (authMode === "signup") {
      if (!authForm.username.trim()) { setError("Username required!"); setLoading(false); return; }
      const { data, error: err } = await sb.auth.signUp({ email: authForm.email, password: authForm.password });
      if (err) { setError(err.message); setLoading(false); return; }
      if (data.user) await sb.from("profiles").insert({ id: data.user.id, username: authForm.username.trim(), is_online: true });
    } else {
      const { error: err } = await sb.auth.signInWithPassword({ email: authForm.email, password: authForm.password });
      if (err) setError(err.message);
    }
    setLoading(false);
  };

  const logout = async () => {
    await sb.from("profiles").update({ is_online: false }).eq("id", user.id);
    await sb.auth.signOut();
    setMessages([]); setUsers([]); setProfile(null); setRooms([]); setActiveRoom(null); setDmChannels([]); setActiveDM(null);
  };

  const sendMessage = async (text = input, isDM = activeView === "dm") => {
    const txt = text.trim();
    if (!txt || !profile) return;
    if (text === input) setInput("");
    const { content, iv } = await encryptMsg(key, txt);
    const payload = {
      sender_id: user.id, sender_name: profile.username, content, iv, msg_type: "text",
      ...(isDM ? { dm_channel_id: activeDM.id } : { room_id: activeRoom.id }),
      ...(replyTo ? await (async () => { const { content: rc, iv: ri } = await encryptMsg(key, replyTo.text.slice(0,80)); return { reply_to_id: replyTo.id, reply_sender: replyTo.sender_name, reply_preview: rc, reply_iv: ri }; })() : {})
    };
    if (replyTo) setReplyTo(null);
    await sb.from("messages").insert(payload);
    clearTyping();
  };

  const forwardMessage = async (destRoomId, destDmId) => {
    if (!forwardMsg || !profile) return;
    setForwardMsg(null);
    const { content, iv } = await encryptMsg(key, forwardMsg.text);
    await sb.from("messages").insert({
      sender_id: user.id, sender_name: profile.username, content, iv, msg_type: "text",
      forwarded: true, forwarded_from_name: forwardMsg.sender_name,
      ...(destDmId ? { dm_channel_id: destDmId } : { room_id: destRoomId })
    });
  };

  const deleteForEveryone = async id => {
    await sb.from("messages").update({ is_deleted_everyone: true }).eq("id", id);
    setMessages(prev => prev.map(m => m.id === id ? { ...m, is_deleted_everyone: true, text: null } : m));
  };

  const togglePin = async msg => {
    const newVal = !msg.is_pinned;
    await sb.from("messages").update({ is_pinned: newVal, pinned_at: newVal ? new Date().toISOString() : null }).eq("id", msg.id);
    setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_pinned: newVal } : m));
    if (newVal) setPinnedMsg({ ...msg, is_pinned: true });
    else if (pinnedMsg?.id === msg.id) {
      const remaining = messages.filter(m => m.is_pinned && m.id !== msg.id);
      setPinnedMsg(remaining.length ? remaining[remaining.length-1] : null);
    }
  };

  const toggleStar = async msgId => {
    if (starredIds.has(msgId)) {
      await sb.from("starred_messages").delete().eq("message_id", msgId).eq("user_id", user.id);
      setStarredIds(prev => { const n = new Set(prev); n.delete(msgId); return n; });
    } else {
      await sb.from("starred_messages").insert({ user_id: user.id, message_id: msgId });
      setStarredIds(prev => new Set([...prev, msgId]));
    }
  };

  const loadStarred = async () => {
    setShowStarred(true);
    const { data } = await sb.from("starred_messages").select("message_id, messages(*)").eq("user_id", user.id);
    if (data) {
      const dec = await Promise.all(data.filter(s=>s.messages).map(async s => ({ ...s.messages, text: await decryptMsg(key, s.messages.content, s.messages.iv) })));
      setStarredMsgs(dec);
    }
  };

  const toggleReaction = async (msgId, emoji) => {
    setEmojiPicker(null);
    const has = reactions[msgId]?.[emoji]?.find(r => r.user_id === user.id);
    if (has) await sb.from("reactions").delete().eq("message_id", msgId).eq("user_id", user.id).eq("emoji", emoji);
    else await sb.from("reactions").insert({ message_id: msgId, user_id: user.id, username: profile.username, emoji });
  };

  const uploadFile = async (file, bucket, msgType) => {
    if (!file || !profile) return;
    setUploading(true);
    const ext = file.name?.split(".").pop() || "bin";
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { error: upErr } = await sb.storage.from(bucket).upload(path, file, { contentType: file.type });
    if (upErr) { setUploading(false); alert("Upload failed: " + upErr.message); return; }
    const { data: { publicUrl } } = sb.storage.from(bucket).getPublicUrl(path);
    const { content, iv } = await encryptMsg(key, publicUrl);
    const isDM = activeView === "dm";
    await sb.from("messages").insert({ sender_id: user.id, sender_name: profile.username, content, iv, msg_type: msgType, ...(isDM ? { dm_channel_id: activeDM.id } : { room_id: activeRoom.id }) });
    setUploading(false);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      audioChunks.current = [];
      rec.ondataavailable = e => audioChunks.current.push(e.data);
      rec.onstop = async () => {
        const blob = new Blob(audioChunks.current, { type: "audio/webm" });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: "audio/webm" });
        stream.getTracks().forEach(t => t.stop());
        await uploadFile(file, "chat-audio", "audio");
      };
      rec.start();
      mediaRec.current = rec;
      setIsRecording(true);
    } catch { alert("Microphone access denied!"); }
  };

  const stopRecording = () => { mediaRec.current?.stop(); setIsRecording(false); };

  const handleTyping = () => {
    if (!activeRoom && !activeDM) return;
    const channelId = activeView === "dm" ? activeDM?.id : activeRoom?.id;
    sb.from("profiles").update({ typing_in: channelId, typing_updated_at: new Date().toISOString() }).eq("id", user.id);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(clearTyping, 3000);
  };

  const clearTyping = () => {
    sb?.from("profiles").update({ typing_in: null }).eq("id", user.id);
    if (typingTimer.current) clearTimeout(typingTimer.current);
  };

  const createRoom = async () => {
    const name = newRoomName.trim().toLowerCase().replace(/\s+/g,"-");
    if (!name || !profile) return;
    const { data } = await sb.from("rooms").insert({ name, created_by: user.id }).select().single();
    if (data) { setActiveRoom(data); setActiveView("room"); setNewRoomName(""); setShowNewRoom(false); }
  };

  const openDM = async targetUser => {
    if (targetUser.id === user.id) return;
    // Check if DM channel already exists
    const existing = dmChannels.find(d => (d.user1_id === user.id && d.user2_id === targetUser.id) || (d.user1_id === targetUser.id && d.user2_id === user.id));
    if (existing) { setActiveDM({ ...existing, otherUser: targetUser }); setActiveView("dm"); return; }
    const { data } = await sb.from("dm_channels").insert({ user1_id: user.id, user2_id: targetUser.id }).select().single();
    if (data) {
      const dm = { ...data, otherUser: targetUser };
      setDmChannels(prev => [...prev, dm]);
      setActiveDM(dm);
      setActiveView("dm");
    }
  };

  const getOtherUser = dm => {
    const otherId = dm.user1_id === user?.id ? dm.user2_id : dm.user1_id;
    return users.find(u => u.id === otherId);
  };

  // ── READ RECEIPT DISPLAY ──
  const getTickStatus = msg => {
    if (msg.sender_id !== user.id) return null;
    const rr = readReceipts[msg.id] || [];
    const roomMembers = activeView === "dm" ? 1 : (users.length - 1);
    if (rr.length === 0) return "sent";
    if (rr.length >= roomMembers) return "read";
    return "delivered";
  };

  const TickIcon = ({ status }) => {
    if (!status) return null;
    const color = status === "read" ? C.read : C.muted;
    return (
      <span style={{ fontSize: 12, color, marginLeft: 4 }}>
        {status === "sent" ? "✓" : "✓✓"}
      </span>
    );
  };

  // ── STYLES ──
  const iStyle = { background: C.bg, border:`1px solid ${C.border}`, borderRadius:10, color:C.text, fontFamily:"'Space Grotesk',sans-serif", fontSize:13, outline:"none", padding:"11px 14px", transition:"border-color 0.2s", width:"100%" };
  const GS = () => (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}
      ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1a2540;border-radius:4px}
      input:focus{border-color:#00d4ff55!important}
      .msg:hover .mact{opacity:1!important}.mact{opacity:0;transition:opacity .15s}
      .hov:hover{background:#111827!important}
      .hov2:hover{background:#0f1930!important}
    `}</style>
  );

  // ══════════════ CONFIG SCREEN ══════════════
  if (screen === "config") return (
    <div style={{ minHeight:"100vh", background:C.bg, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", padding:20 }}>
      <GS/>
      <div style={{ width:"100%", maxWidth:420, background:C.surface, borderRadius:20, border:`1px solid ${C.border}`, padding:36 }}>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontSize:48, marginBottom:10 }}>🔐</div>
          <h1 style={{ fontSize:22, fontWeight:700, color:C.text }}>NexChat</h1>
          <div style={{ fontSize:10, color:C.accent, marginTop:4, letterSpacing:1.5 }}>WHATSAPP-GRADE · E2E ENCRYPTED</div>
        </div>
        {error && <div style={{ background:"#ff4d4d18", border:"1px solid #ff4d4d44", borderRadius:10, padding:"10px 14px", color:C.danger, fontSize:13, marginBottom:16 }}>⚠️ {error}</div>}
        <form onSubmit={e=>{ e.preventDefault(); if(!cfgForm.url||!cfgForm.key||!cfgForm.roomPass){setError("All fields required!");return;} const cfg={url:cfgForm.url.trim(),key:cfgForm.key.trim(),roomPass:cfgForm.roomPass}; localStorage.setItem("nextalk_cfg",JSON.stringify(cfg)); setConfig(cfg); setError(""); }} style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {[["Supabase URL","url","text","https://xxxx.supabase.co"],["Anon Key","key","text","eyJhbGci..."],["Room Password 🔑","roomPass","password","Shared encryption secret"]].map(([l,f,t,p])=>(
            <div key={f}><div style={{ fontSize:10, color:C.muted, marginBottom:6, letterSpacing:1.5, textTransform:"uppercase" }}>{l}</div><input type={t} placeholder={p} value={cfgForm[f]} onChange={e=>setCfgForm(p=>({...p,[f]:e.target.value}))} style={iStyle}/></div>
          ))}
          <button type="submit" style={{ padding:13, borderRadius:12, border:"none", background:C.accent, color:C.bg, fontSize:14, fontWeight:700, cursor:"pointer", marginTop:4 }}>Connect →</button>
        </form>
      </div>
    </div>
  );

  // ══════════════ AUTH SCREEN ══════════════
  if (screen === "auth") return (
    <div style={{ minHeight:"100vh", background:C.bg, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Space Grotesk',sans-serif", padding:20 }}>
      <GS/>
      <div style={{ width:"100%", maxWidth:380, background:C.surface, borderRadius:20, border:`1px solid ${C.border}`, padding:36 }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:40, marginBottom:8 }}>💬</div>
          <h1 style={{ fontSize:20, fontWeight:700, color:C.text }}>NexChat</h1>
          <div style={{ fontSize:10, color:C.accent, letterSpacing:2 }}>END-TO-END ENCRYPTED</div>
        </div>
        <div style={{ display:"flex", gap:6, marginBottom:20, background:C.bg, borderRadius:10, padding:4 }}>
          {["login","signup"].map(m=>(<button key={m} onClick={()=>{setAuthMode(m);setError("");}} style={{ flex:1, padding:9, borderRadius:8, border:"none", cursor:"pointer", fontFamily:"'Space Grotesk',sans-serif", fontWeight:600, fontSize:13, background:authMode===m?C.surface:"transparent", color:authMode===m?C.text:C.muted }}>{m==="login"?"Login":"Sign Up"}</button>))}
        </div>
        {error && <div style={{ background:"#ff4d4d18", border:"1px solid #ff4d4d44", borderRadius:10, padding:"10px 14px", color:C.danger, fontSize:13, marginBottom:14 }}>⚠️ {error}</div>}
        <form onSubmit={handleAuth} style={{ display:"flex", flexDirection:"column", gap:11 }}>
          {authMode==="signup" && <input placeholder="Username" value={authForm.username} onChange={e=>setAuthForm(p=>({...p,username:e.target.value}))} style={iStyle}/>}
          <input type="email" placeholder="Email" value={authForm.email} onChange={e=>setAuthForm(p=>({...p,email:e.target.value}))} style={iStyle}/>
          <input type="password" placeholder="Password" value={authForm.password} onChange={e=>setAuthForm(p=>({...p,password:e.target.value}))} style={iStyle}/>
          <button type="submit" disabled={loading} style={{ padding:13, borderRadius:12, border:"none", background:C.accent, color:C.bg, fontSize:14, fontWeight:700, cursor:"pointer", marginTop:4, opacity:loading?0.6:1 }}>{loading?"...":authMode==="login"?"Login →":"Create Account →"}</button>
        </form>
        <button onClick={()=>{localStorage.removeItem("nextalk_cfg");setConfig(null);}} style={{ width:"100%", marginTop:12, padding:9, borderRadius:10, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Change Config</button>
      </div>
    </div>
  );

  // ══════════════ CHAT SCREEN ══════════════
  const onlineUsers  = users.filter(u => u.is_online);
  const offlineUsers = users.filter(u => !u.is_online);
  const channelName  = activeView === "dm" ? (activeDM ? getOtherUser(activeDM)?.username || "DM" : "DM") : `#${activeRoom?.name || "..."}`;

  return (
    <div style={{ display:"flex", height:"100vh", background:C.bg, fontFamily:"'Space Grotesk',sans-serif", overflow:"hidden", color:C.text, position:"relative" }} onClick={()=>setEmojiPicker(null)}>
      <GS/>

      {/* ══ FORWARD MODAL ══ */}
      {forwardMsg && (
        <div style={{ position:"fixed", inset:0, background:"#000a", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={()=>setForwardMsg(null)}>
          <div style={{ background:C.surface, borderRadius:20, border:`1px solid ${C.border}`, padding:28, width:320, maxHeight:"70vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>😄 Forward Message</div>
            <div style={{ fontSize:11, color:C.muted, marginBottom:16 }}>"{forwardMsg.text?.slice(0,50)}..."</div>
            <div style={{ fontSize:10, color:C.muted, marginBottom:8, letterSpacing:2, textTransform:"uppercase" }}>Rooms</div>
            {rooms.map(r=>(
              <div key={r.id} className="hov" onClick={()=>forwardMessage(r.id,null)} style={{ padding:"10px 12px", borderRadius:10, cursor:"pointer", marginBottom:4, fontSize:13 }}>
                # {r.name}
              </div>
            ))}
            <div style={{ fontSize:10, color:C.muted, margin:"12px 0 8px", letterSpacing:2, textTransform:"uppercase" }}>Direct Messages</div>
            {dmChannels.map(d=>{const ou=getOtherUser(d); return ou?(
              <div key={d.id} className="hov" onClick={()=>forwardMessage(null,d.id)} style={{ padding:"10px 12px", borderRadius:10, cursor:"pointer", marginBottom:4, fontSize:13, display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ width:24, height:24, borderRadius:"50%", background:`${C.accent}18`, display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:C.accent }}>{ou.username?.[0]?.toUpperCase()}</span>
                {ou.username}
              </div>
            ):null;})}
          </div>
        </div>
      )}

      {/* ══ STARRED PANEL ══ */}
      {showStarred && (
        <div style={{ position:"fixed", inset:0, background:"#000a", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={()=>setShowStarred(false)}>
          <div style={{ background:C.surface, borderRadius:20, border:`1px solid ${C.border}`, padding:28, width:380, maxHeight:"70vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>⭐ Starred Messages</div>
            {starredMsgs.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No starred messages yet.</div>}
            {starredMsgs.map(m=>(
              <div key={m.id} style={{ padding:"10px 12px", borderRadius:10, background:C.s2, border:`1px solid ${C.border}`, marginBottom:8 }}>
                <div style={{ fontSize:11, color:C.accent, fontWeight:600, marginBottom:4 }}>{m.sender_name}</div>
                <div style={{ fontSize:13, color:C.text }}>{m.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ SIDEBAR ══ */}
      {sidebarOpen && (
        <div style={{ width:230, background:C.surface, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", flexShrink:0 }}>
          <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${C.border}` }}>
            <div style={{ fontSize:15, fontWeight:700 }}>⚡ NexChat</div>
            <div style={{ fontSize:9, color:C.accent, letterSpacing:1.5, marginTop:3 }}>⚡ NexChat · E2E Encrypted</div>
          </div>

          <div style={{ flex:1, overflowY:"auto" }}>
            {/* Rooms */}
            <div style={{ padding:"10px 10px 0" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingLeft:4, marginBottom:6 }}>
                <span style={{ fontSize:9, color:C.muted, letterSpacing:2, textTransform:"uppercase" }}>Rooms</span>
                <button onClick={()=>setShowNewRoom(p=>!p)} style={{ background:"none", border:"none", color:C.accent, cursor:"pointer", fontSize:20, lineHeight:1 }}>+</button>
              </div>
              {showNewRoom && (
                <div style={{ marginBottom:8, display:"flex", gap:6 }}>
                  <input autoFocus placeholder="room-name" value={newRoomName} onChange={e=>setNewRoomName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")createRoom();if(e.key==="Escape")setShowNewRoom(false);}} style={{ ...iStyle, padding:"7px 10px", fontSize:11, flex:1 }}/>
                  <button onClick={createRoom} style={{ padding:"7px 10px", borderRadius:8, border:"none", background:C.accent, color:C.bg, fontSize:12, fontWeight:700, cursor:"pointer" }}>+</button>
                </div>
              )}
              {rooms.map(r=>(
                <div key={r.id} className="hov" onClick={()=>{setActiveRoom(r);setActiveView("room");}} style={{ padding:"7px 10px", borderRadius:8, marginBottom:2, cursor:"pointer", display:"flex", alignItems:"center", gap:8, background:activeView==="room"&&activeRoom?.id===r.id?`${C.accent}12`:"transparent", borderLeft:`2px solid ${activeView==="room"&&activeRoom?.id===r.id?C.accent:"transparent"}` }}>
                  <span style={{ fontSize:12, color:C.muted }}>#</span>
                  <span style={{ fontSize:12, color:activeView==="room"&&activeRoom?.id===r.id?C.text:C.muted }}>{r.name}</span>
                </div>
              ))}
            </div>

            {/* DMs */}
            <div style={{ padding:"10px 10px 0", borderTop:`1px solid ${C.border}`, marginTop:8 }}>
              <div style={{ fontSize:9, color:C.muted, letterSpacing:2, textTransform:"uppercase", paddingLeft:4, marginBottom:6 }}>Direct Messages</div>
              {dmChannels.map(d=>{ const ou=getOtherUser(d); return ou?(
                <div key={d.id} className="hov" onClick={()=>{setActiveDM({...d,otherUser:ou});setActiveView("dm");}} style={{ padding:"7px 10px", borderRadius:8, marginBottom:2, cursor:"pointer", display:"flex", alignItems:"center", gap:8, background:activeView==="dm"&&activeDM?.id===d.id?`${C.green}10`:"transparent", borderLeft:`2px solid ${activeView==="dm"&&activeDM?.id===d.id?C.green:"transparent"}` }}>
                  <div style={{ width:24, height:24, borderRadius:"50%", background:`${C.green}18`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, color:C.green, flexShrink:0, position:"relative" }}>
                    {ou.username?.[0]?.toUpperCase()}
                    {ou.is_online && <div style={{ position:"absolute", bottom:-1, right:-1, width:8, height:8, borderRadius:"50%", background:C.green, border:`1.5px solid ${C.surface}` }}/>}
                  </div>
                  <span style={{ fontSize:12, color:activeView==="dm"&&activeDM?.id===d.id?C.text:C.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ou.username}</span>
                </div>
              ):null;})}
            </div>

            {/* Users */}
            <div style={{ padding:"10px 10px 0", borderTop:`1px solid ${C.border}`, marginTop:8 }}>
              {onlineUsers.length > 0 && <>
                <div style={{ fontSize:9, color:C.muted, letterSpacing:2, textTransform:"uppercase", marginBottom:6, paddingLeft:4 }}>🟢 Online — {onlineUsers.length}</div>
                {onlineUsers.map(u=>(
                  <div key={u.id} className="hov2" onClick={()=>openDM(u)} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:8, marginBottom:2, cursor:u.id===user?.id?"default":"pointer", background:u.id===user?.id?`${C.accent}08`:"transparent" }}>
                    <div style={{ width:28, height:28, borderRadius:"50%", background:`${C.accent}18`, border:`2px solid ${C.accent}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:C.accent, flexShrink:0 }}>{u.username?.[0]?.toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize:11, color:C.text, lineHeight:1.3 }}>{u.username}{u.id===user?.id?" (you)":""}</div>
                      {u.id!==user?.id && <div style={{ fontSize:9, color:C.muted }}>click to DM</div>}
                    </div>
                  </div>
                ))}
              </>}
              {offlineUsers.length > 0 && <>
                <div style={{ fontSize:9, color:C.muted, letterSpacing:2, textTransform:"uppercase", margin:"10px 0 6px", paddingLeft:4 }}>⚫ Offline</div>
                {offlineUsers.map(u=>(
                  <div key={u.id} className="hov2" onClick={()=>openDM(u)} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", opacity:0.45, borderRadius:8, cursor:"pointer" }}>
                    <div style={{ width:28, height:28, borderRadius:"50%", background:"#1a2540", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:C.muted, flexShrink:0 }}>{u.username?.[0]?.toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize:11, color:C.muted }}>{u.username}</div>
                      <div style={{ fontSize:9, color:C.muted }}>last seen {u.last_seen ? new Date(u.last_seen).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : "N/A"}</div>
                    </div>
                  </div>
                ))}
              </>}
            </div>
          </div>

          {/* Starred + logout */}
          <div style={{ padding:"10px", borderTop:`1px solid ${C.border}` }}>
            <button onClick={loadStarred} style={{ width:"100%", padding:"8px", borderRadius:9, border:`1px solid ${C.border}`, background:"transparent", color:C.warn, fontSize:11, cursor:"pointer", fontFamily:"inherit", marginBottom:6 }}>⭐ Starred Messages ({starredIds.size})</button>
            <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>Signed in as <strong style={{ color:C.text }}>{profile?.username}</strong></div>
            <button onClick={logout} style={{ width:"100%", padding:8, borderRadius:9, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>Sign Out</button>
          </div>
        </div>
      )}

      {/* ══ MAIN CHAT ══ */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {/* Topbar */}
        <div style={{ padding:"12px 18px", borderBottom:`1px solid ${C.border}`, background:C.surface, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
          <button onClick={()=>setSidebarOpen(p=>!p)} style={{ background:C.s2, border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:C.muted, fontSize:14 }}>{sidebarOpen?"◀":"▶"}</button>
          <div>
            <div style={{ fontSize:14, fontWeight:700 }}>{activeView==="dm"?"🔒 ":""}{channelName}</div>
            <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>
              {activeView==="dm" ? (activeDM && getOtherUser(activeDM)?.is_online ? "🟢 Online" : `last seen ${getOtherUser(activeDM)?.last_seen ? new Date(getOtherUser(activeDM)?.last_seen).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : "N/A"}`) : `${onlineUsers.length} online · AES-256-GCM`}
            </div>
          </div>
          <div style={{ flex:1 }}/>
          {pinnedMsg && (
            <div style={{ padding:"5px 12px", borderRadius:10, background:`${C.warn}0a`, border:`1px solid ${C.warn}33`, fontSize:11, color:C.warn, maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", cursor:"pointer" }} onClick={()=>msgEndRef.current?.scrollIntoView()}>
              📌 {pinnedMsg.text?.slice(0,30)}...
            </div>
          )}
          <div style={{ padding:"5px 12px", borderRadius:20, background:`${C.accent}0a`, border:`1px solid ${C.accent}22`, fontSize:10, color:C.accent, fontWeight:600 }}>🔒 E2E</div>
        </div>

        {/* Typing indicator */}
        {typingUsers.length > 0 && (
          <div style={{ padding:"4px 20px", background:C.s3, fontSize:11, color:C.muted, display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ display:"flex", gap:3 }}>{[0,1,2].map(i=><span key={i} style={{ width:4, height:4, borderRadius:"50%", background:C.accent, animation:"pulse 1.2s infinite", animationDelay:`${i*0.2}s`, display:"inline-block" }}/>)}</span>
            <span>{typingUsers.join(", ")} {typingUsers.length>1?"are":"is"} typing...</span>
            <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}`}</style>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex:1, overflowY:"auto", padding:"16px 20px" }} onClick={()=>setEmojiPicker(null)}>
          {messages.length===0 && (
            <div style={{ textAlign:"center", marginTop:60, color:C.muted }}>
              <div style={{ fontSize:44, marginBottom:10 }}>{activeView==="dm"?"🔒":"🔐"}</div>
              <div style={{ fontSize:14, fontWeight:600, color:C.text, marginBottom:6 }}>{channelName}</div>
              <div style={{ fontSize:12 }}>{activeView==="dm"?"E2E encrypted DM — just the two of you!":"First message send cheyyandi — encrypted! ✨"}</div>
            </div>
          )}

          {messages.map(msg=>{
            const isOwn = msg.sender_id === user?.id;
            const rxs   = reactions[msg.id] || {};
            const tick  = getTickStatus(msg);
            const isStarred = starredIds.has(msg.id);
            if (msg.is_deleted_everyone) return (
              <div key={msg.id} style={{ display:"flex", justifyContent:isOwn?"flex-end":"flex-start", marginBottom:12 }}>
                <div style={{ padding:"8px 14px", borderRadius:12, background:C.surface, border:`1px solid ${C.border}`, fontSize:12, color:C.muted, fontStyle:"italic" }}>🚫 This message was deleted</div>
              </div>
            );
            return (
              <div key={msg.id} className="msg" style={{ display:"flex", flexDirection:"column", alignItems:isOwn?"flex-end":"flex-start", marginBottom:14, position:"relative" }}>
                {!isOwn && activeView!=="dm" && <div style={{ fontSize:10, color:C.muted, marginBottom:4, paddingLeft:4, fontWeight:600 }}>{msg.sender_name}</div>}
                {msg.forwarded && <div style={{ fontSize:10, color:C.muted, marginBottom:3, paddingLeft:4, paddingRight:4, fontStyle:"italic" }}>↗ Forwarded from {msg.forwarded_from_name}</div>}

                <div style={{ display:"flex", alignItems:"flex-end", gap:6, flexDirection:isOwn?"row-reverse":"row" }}>
                  <div style={{ maxWidth:"65%" }}>
                    {msg.reply_text && (
                      <div style={{ padding:"5px 10px", borderRadius:"8px 8px 0 0", borderLeft:`3px solid ${C.accent}`, background:`${C.accent}0a`, fontSize:11, color:C.muted, marginBottom:1 }}>
                        <span style={{ color:C.accent, fontWeight:600 }}>↩ {msg.reply_sender}: </span>{msg.reply_text.slice(0,50)}{msg.reply_text.length>50?"...":""}
                      </div>
                    )}
                    <div style={{ padding:"9px 13px", borderRadius:isOwn?"16px 16px 4px 16px":"4px 16px 16px 16px", background:isOwn?`${C.accent}18`:C.surface, border:`1px solid ${isOwn?C.accent+"44":C.border}`, fontSize:13.5, lineHeight:1.6, wordBreak:"break-word" }}>
                      {msg.msg_type==="image" ? <img src={msg.text} alt="img" style={{ maxWidth:"100%", borderRadius:8, display:"block" }} onError={e=>e.target.style.display="none"}/> :
                       msg.msg_type==="audio" ? <audio controls src={msg.text} style={{ maxWidth:220, height:36 }}/> :
                       msg.text}
                    </div>
                    {/* Tick + time */}
                    <div style={{ display:"flex", alignItems:"center", justifyContent:isOwn?"flex-end":"flex-start", gap:4, marginTop:3 }}>
                      {isStarred && <span style={{ fontSize:10, color:C.warn }}>⭐</span>}
                      <span style={{ fontSize:10, color:C.muted }}>{new Date(msg.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
                      {isOwn && <TickIcon status={tick}/>}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mact" style={{ display:"flex", flexDirection:"column", gap:3 }}>
                    <button onClick={e=>{e.stopPropagation();setEmojiPicker(emojiPicker===msg.id?null:msg.id);}} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12 }}>😊</button>
                    <button onClick={()=>setReplyTo(msg)} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12, color:C.muted }}>↩</button>
                    <button onClick={()=>setForwardMsg(msg)} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12, color:C.muted }}>↗</button>
                    <button onClick={()=>toggleStar(msg.id)} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12, color:isStarred?C.warn:C.muted }}>⭐</button>
                    <button onClick={()=>togglePin(msg)} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12, color:msg.is_pinned?C.warn:C.muted }}>📌</button>
                    {isOwn && <button onClick={()=>deleteForEveryone(msg.id)} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"3px 6px", cursor:"pointer", fontSize:12, color:C.danger }}>🗑</button>}
                  </div>
                </div>

                {/* Emoji picker */}
                {emojiPicker===msg.id && (
                  <div onClick={e=>e.stopPropagation()} style={{ position:"absolute", [isOwn?"right":"left"]:0, top:"100%", marginTop:4, background:C.s2, border:`1px solid ${C.border}`, borderRadius:12, padding:"8px 10px", display:"flex", gap:6, zIndex:100, boxShadow:"0 4px 20px #000b" }}>
                    {EMOJIS.map(e=>(
                      <button key={e} onClick={()=>toggleReaction(msg.id,e)} style={{ background:rxs[e]?.find(r=>r.user_id===user?.id)?`${C.accent}20`:"transparent", border:`1px solid ${rxs[e]?.find(r=>r.user_id===user?.id)?C.accent:"transparent"}`, borderRadius:8, padding:"4px 7px", cursor:"pointer", fontSize:17 }}>{e}</button>
                    ))}
                  </div>
                )}

                {/* Reactions display */}
                {Object.entries(rxs).filter(([,a])=>a.length>0).length>0 && (
                  <div style={{ display:"flex", gap:4, marginTop:4, flexWrap:"wrap", justifyContent:isOwn?"flex-end":"flex-start" }}>
                    {Object.entries(rxs).filter(([,a])=>a.length>0).map(([emoji,arr])=>(
                      <button key={emoji} onClick={()=>toggleReaction(msg.id,emoji)} style={{ display:"flex", alignItems:"center", gap:3, padding:"2px 8px", borderRadius:20, border:`1px solid ${arr.find(r=>r.user_id===user?.id)?C.accent:C.border}`, background:arr.find(r=>r.user_id===user?.id)?`${C.accent}12`:C.surface, cursor:"pointer", fontSize:12 }}>
                        <span>{emoji}</span><span style={{ fontSize:11, color:C.muted }}>{arr.length}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={msgEndRef}/>
        </div>

        {/* Reply bar */}
        {replyTo && (
          <div style={{ padding:"7px 20px", borderTop:`1px solid ${C.border}`, background:C.surface, display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ flex:1, padding:"5px 12px", borderLeft:`3px solid ${C.accent}`, background:`${C.accent}08`, borderRadius:6 }}>
              <span style={{ fontSize:11, color:C.accent, fontWeight:600 }}>↩ {replyTo.sender_name}: </span>
              <span style={{ fontSize:11, color:C.muted }}>{replyTo.text?.slice(0,60)}</span>
            </div>
            <button onClick={()=>setReplyTo(null)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:18 }}>✕</button>
          </div>
        )}

        {/* Input bar */}
        <div style={{ padding:"12px 20px", borderTop:`1px solid ${C.border}`, background:C.surface, flexShrink:0 }}>
          <div style={{ display:"flex", gap:7, alignItems:"center" }}>
            <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={e=>{if(e.target.files[0])uploadFile(e.target.files[0],"chat-images","image");e.target.value="";}}/>
            <button onClick={()=>fileRef.current?.click()} disabled={uploading} style={{ padding:"9px 11px", borderRadius:10, border:`1px solid ${C.border}`, background:C.s2, cursor:"pointer", fontSize:16, flexShrink:0, color:uploading?C.muted:C.text }}>
              {uploading?"⏳":"📎"}
            </button>
            <button onMouseDown={startRecording} onMouseUp={stopRecording} onTouchStart={startRecording} onTouchEnd={stopRecording}
              style={{ padding:"9px 11px", borderRadius:10, border:`1px solid ${isRecording?C.danger:C.border}`, background:isRecording?`${C.danger}18`:C.s2, cursor:"pointer", fontSize:16, flexShrink:0, color:isRecording?C.danger:C.text, transition:"all 0.2s" }}>
              🎤
            </button>
            <input value={input} onChange={e=>{setInput(e.target.value);handleTyping();}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey)sendMessage();}} placeholder={isRecording?"🔴 Recording... release to send":activeView==="dm"?`Message ${channelName}...`:`Message ${channelName} 🔐`} disabled={isRecording} style={{ ...iStyle, flex:1 }}/>
            <button onClick={()=>sendMessage()} disabled={!input.trim()} style={{ padding:"10px 18px", borderRadius:10, border:"none", background:C.accent, color:C.bg, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", flexShrink:0, opacity:!input.trim()?0.4:1 }}>→</button>
          </div>
          <div style={{ marginTop:6, fontSize:10, color:"#1e2d44", textAlign:"center" }}>
            Hold 🎤 to record voice · hover message for actions · ✓✓ blue = read
          </div>
        </div>
      </div>
    </div>
  );
}
