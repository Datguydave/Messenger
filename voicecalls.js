// voicecalls.js — group voice & video for server voice channels
//
// SIGNALLING — simple per-pair paths, no Firebase queries needed:
//
//   voiceChannels/<sid>/<cid>/participants/<uid>  → { username, avatar, joinedAt }
//
//   voiceSignals/<sid>/<cid>/<myUid>/offer/<theirUid>     → SDP string
//   voiceSignals/<sid>/<cid>/<myUid>/answer/<theirUid>    → SDP string
//   voiceSignals/<sid>/<cid>/<myUid>/ice/<theirUid>/<push> → ICE JSON
//
// Person joining later (B) reads existing participants, sends an offer to each.
// Existing participant (A) watches voiceSignals/<sid>/<cid>/<B>/offer/<A>,
// responds with answer at voiceSignals/<sid>/<cid>/<B>/answer/<A> (wait — 
// answer goes at A's own path so B reads it).
//
// Simpler rule: 
//   CALLER  writes offer  at:  signals/<sid>/<cid>/<CALLER>/offers/<CALLEE>
//   CALLEE  reads it, writes answer at: signals/<sid>/<cid>/<CALLEE>/answers/<CALLER>
//   ICE:    each side writes their candidates at: signals/<sid>/<cid>/<SELF>/ice/<OTHER>/<push>
//   Other side reads: signals/<sid>/<cid>/<OTHER>/ice/<SELF>

const VOICE_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "turn:openrelay.metered.ca:80",   username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

// ── Module state ──────────────────────────────────────────────────────
let vc = {
  sid: null, cid: null,
  type: "voice",
  localStream: null,
  peers: {},        // theirUid → RTCPeerConnection
  iceBuf: {},       // theirUid → RTCIceCandidate[] (buffered before remoteDesc set)
  audioEls: {},     // theirUid → <audio>
  dbRefs: [],       // Firebase refs to detach on leave
  myRef: null,
  participantsRef: null,
  muted: false, camOff: false, deafened: false,
  speaking: new Set(),
  analysers: {}, audioCtx: null,
};

function sigBase() { return "voiceSignals/" + vc.sid + "/" + vc.cid; }

function isUidSpeaking(uid) { return vc.speaking.has(uid); }

// ══════════════════════════════════════════════════════════════
//  JOIN
// ══════════════════════════════════════════════════════════════
async function joinVoiceChannel(sid, cid, channel) {
  if (vc.sid === sid && vc.cid === cid) { showVoiceBar(); return; }
  if (vc.sid) await leaveVoiceChannel(false);

  const wantsVideo = await askJoinType();
  if (wantsVideo === null) return;

  vc.sid = sid; vc.cid = cid;
  vc.type = wantsVideo ? "video" : "voice";
  const myUid = AppState.currentUser.uid;

  // Get mic/camera
  try {
    vc.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: wantsVideo ? { width: 640, height: 360, frameRate: 24 } : false,
    });
  } catch (e) {
    showToast("Mic/camera permission denied. Allow access in your browser and try again.", "error");
    vc.sid = null; vc.cid = null;
    return;
  }

  startSpeakingDetection(myUid, vc.localStream, true);

  // Write presence
  vc.participantsRef = db.ref("voiceChannels/" + sid + "/" + cid + "/participants");
  vc.myRef = vc.participantsRef.child(myUid);
  await vc.myRef.set({
    username: AppState.userProfile.username,
    avatar:   AppState.userProfile.avatar || "",
    joinedAt: Date.now(),
  });
  vc.myRef.onDisconnect().remove();

  // Build UI
  buildVoiceBar(channel.name);
  addTile(myUid, AppState.userProfile, vc.localStream, true);

  // ── Step 1: send offers to everyone ALREADY in the channel ──
  const existingSnap = await vc.participantsRef.get();
  if (existingSnap.exists()) {
    const promises = [];
    existingSnap.forEach(child => {
      if (child.key !== myUid) {
        promises.push(startPeerAsCaller(child.key, child.val()));
      }
    });
    await Promise.all(promises);
  }

  // ── Step 2: watch for NEW people joining after me ──
  const partRef = vc.participantsRef;
  const partHandler = partRef.on("child_added", snap => {
    if (snap.key === myUid) return;
    // If we already have a peer for them (from step 1), skip
    if (vc.peers[snap.key]) return;
    // New joiner — they will send us an offer; we just add a tile placeholder
    addTile(snap.key, snap.val(), null, false);
  });
  partRef.on("child_removed", snap => { teardownPeer(snap.key); });
  vc.dbRefs.push(() => { partRef.off("child_added", partHandler); partRef.off("child_removed"); });

  // ── Step 3: listen for incoming offers addressed to ME ──
  // Other people who joined BEFORE me will have sent offers at:
  // voiceSignals/<sid>/<cid>/<THEIR_UID>/offers/<MY_UID>
  // We watch ALL participants' offer slots for our uid
  // Simplest: watch voiceSignals/<sid>/<cid> and filter
  const offerPath = sigBase() + "/offers/" + myUid;
  const offerRef = db.ref(offerPath);
  offerRef.on("child_added", async snap => {
    const callerUid = snap.key;
    const offerSdp  = snap.val();
    if (!offerSdp || vc.peers[callerUid]) return;

    console.log("[VC] Received offer from", callerUid);

    const theirSnap = await vc.participantsRef.child(callerUid).get();
    const theirData = theirSnap.val() || { username: "User", avatar: "" };

    const pc = createPC(callerUid, theirData);

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });

      // Flush buffered ICE
      for (const c of (vc.iceBuf[callerUid] || [])) {
        try { await pc.addIceCandidate(c); } catch(e) {}
      }
      vc.iceBuf[callerUid] = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Write answer where caller can read it:
      // voiceSignals/<sid>/<cid>/answers/<callerUid>/<myUid>
      await db.ref(sigBase() + "/answers/" + callerUid + "/" + myUid).set(answer.sdp);
      console.log("[VC] Sent answer to", callerUid);
    } catch(e) { console.error("[VC] Error handling offer:", e); }
  });
  vc.dbRefs.push(() => offerRef.off("child_added"));

  // ── Step 4: listen for incoming ICE from anyone ──
  // They write at: voiceSignals/<sid>/<cid>/ice/<THEIR_UID>/<MY_UID>/<push>
  // We watch: voiceSignals/<sid>/<cid>/ice → each child is a sender UID
  const iceRef = db.ref(sigBase() + "/ice");
  iceRef.on("child_added", senderSnap => {
    const senderUid   = senderSnap.key;
    const myIcePath   = senderSnap.ref.child(myUid);
    myIcePath.on("child_added", async iceSnap => {
      const candidate = iceSnap.val();
      console.log("[VC] ICE from", senderUid);
      const pc = vc.peers[senderUid];
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
      } else {
        if (!vc.iceBuf[senderUid]) vc.iceBuf[senderUid] = [];
        vc.iceBuf[senderUid].push(new RTCIceCandidate(candidate));
      }
    });
    vc.dbRefs.push(() => myIcePath.off("child_added"));
  });
  vc.dbRefs.push(() => iceRef.off("child_added"));

  showToast("Joined #" + channel.name, "success");
}

// ══════════════════════════════════════════════════════════════
//  Start as CALLER — send offer, wait for answer
// ══════════════════════════════════════════════════════════════
async function startPeerAsCaller(theirUid, theirData) {
  console.log("[VC] Calling", theirUid);
  const pc = createPC(theirUid, theirData);
  addTile(theirUid, theirData, null, false);

  const myUid = AppState.currentUser.uid;

  // Write offer at: voiceSignals/<sid>/<cid>/offers/<THEIR_UID>/<MY_UID>
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await db.ref(sigBase() + "/offers/" + theirUid + "/" + myUid).set(offer.sdp);
  console.log("[VC] Sent offer to", theirUid);

  // Watch for their answer at: voiceSignals/<sid>/<cid>/answers/<MY_UID>/<THEIR_UID>
  const answerRef = db.ref(sigBase() + "/answers/" + myUid + "/" + theirUid);
  answerRef.on("value", async snap => {
    if (!snap.exists()) return;
    if (pc.signalingState !== "have-local-offer") return;
    console.log("[VC] Got answer from", theirUid);
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: snap.val() });
      // Flush buffered ICE
      for (const c of (vc.iceBuf[theirUid] || [])) {
        try { await pc.addIceCandidate(c); } catch(e) {}
      }
      vc.iceBuf[theirUid] = [];
    } catch(e) { console.error("[VC] Error setting answer:", e); }
  });
  vc.dbRefs.push(() => answerRef.off("value"));
}

// ══════════════════════════════════════════════════════════════
//  Create RTCPeerConnection and wire up events
// ══════════════════════════════════════════════════════════════
function createPC(theirUid, theirData) {
  const myUid = AppState.currentUser.uid;
  const pc    = new RTCPeerConnection(VOICE_ICE);
  vc.peers[theirUid] = pc;

  // Add local tracks
  vc.localStream.getTracks().forEach(t => pc.addTrack(t, vc.localStream));

  // Send ICE to Firebase
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    // Write at: voiceSignals/<sid>/<cid>/ice/<MY_UID>/<THEIR_UID>/<push>
    db.ref(sigBase() + "/ice/" + myUid + "/" + theirUid).push(e.candidate.toJSON())
      .catch(err => console.error("[VC] ICE push error:", err));
  };

  pc.onicegatheringstatechange = () => {
    console.log("[VC] ICE gathering state:", pc.iceGatheringState, "for", theirUid);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[VC] ICE connection state:", pc.iceConnectionState, "for", theirUid);
  };

  pc.onconnectionstatechange = () => {
    console.log("[VC] Connection state:", pc.connectionState, "for", theirUid);
    if (pc.connectionState === "connected") {
      showToast(theirData.username + " joined the call", "success");
    }
    if (pc.connectionState === "failed") {
      console.warn("[VC] Connection failed for", theirUid, "— trying ICE restart");
      pc.restartIce();
    }
  };

  // Receive remote tracks
  pc.ontrack = e => {
    console.log("[VC] Got track from", theirUid, e.track.kind);
    if (!e.streams || !e.streams[0]) return;
    attachRemoteStream(theirUid, theirData, e.streams[0]);
  };

  return pc;
}

function teardownPeer(uid) {
  const pc = vc.peers[uid];
  if (pc) { pc.close(); delete vc.peers[uid]; }
  delete vc.iceBuf[uid];

  const el = vc.audioEls[uid];
  if (el) { el.srcObject = null; el.remove(); delete vc.audioEls[uid]; }

  delete vc.analysers[uid];
  vc.speaking.delete(uid);

  const tile = document.getElementById("vc-tile-" + uid);
  if (tile) tile.remove();
}

// ══════════════════════════════════════════════════════════════
//  Attach remote audio/video to the UI
// ══════════════════════════════════════════════════════════════
function attachRemoteStream(uid, theirData, stream) {
  console.log("[VC] Attaching remote stream for", uid, "tracks:", stream.getTracks().map(t => t.kind));

  // Audio element (always, even for video calls)
  let audio = vc.audioEls[uid];
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = "vc-audio-" + uid;
    audio.autoplay = true;
    audio.style.display = "none";
    document.body.appendChild(audio);
    vc.audioEls[uid] = audio;
  }
  audio.srcObject = stream;
  audio.muted = vc.deafened;

  // Try to play (needed in some browsers)
  audio.play().catch(e => console.warn("[VC] audio play error:", e));

  startSpeakingDetection(uid, stream, false);

  // Update tile with video if available
  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length > 0) {
    const tile = document.getElementById("vc-tile-" + uid);
    if (tile) {
      // Replace avatar with video element
      const existing = tile.querySelector(".vc-tile-av, video");
      const vid = document.createElement("video");
      vid.autoplay = true; vid.playsInline = true;
      vid.srcObject = stream;
      vid.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;";
      if (existing) existing.replaceWith(vid);
      else tile.insertBefore(vid, tile.firstChild);
    } else {
      addTile(uid, theirData, stream, false);
    }
  } else {
    // Voice only — update/add tile with avatar
    if (!document.getElementById("vc-tile-" + uid)) {
      addTile(uid, theirData, null, false);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  Speaking detection
// ══════════════════════════════════════════════════════════════
function startSpeakingDetection(uid, stream, isSelf) {
  try {
    if (!vc.audioCtx) vc.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vc.audioCtx.createMediaStreamSource(stream);
    const an  = vc.audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    vc.analysers[uid] = an;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!vc.analysers[uid]) return;
      an.getByteFrequencyData(buf);
      const avg = buf.slice(2, 20).reduce((a, b) => a + b, 0) / 18;
      const speaking = avg > 15;
      if (speaking) vc.speaking.add(uid); else vc.speaking.delete(uid);
      const tile = document.getElementById("vc-tile-" + uid);
      if (tile) tile.classList.toggle("speaking", speaking);
      requestAnimationFrame(tick);
    };
    tick();
  } catch(e) { console.warn("[VC] Speaking detection error:", e); }
}

// ══════════════════════════════════════════════════════════════
//  LEAVE
// ══════════════════════════════════════════════════════════════
async function leaveVoiceChannel(toast = true) {
  if (!vc.sid) return;
  const sid = vc.sid, cid = vc.cid, myUid = AppState.currentUser && AppState.currentUser.uid;

  // Detach all DB listeners
  vc.dbRefs.forEach(fn => { try { fn(); } catch(e) {} });
  vc.dbRefs = [];

  // Remove presence
  if (vc.myRef) { vc.myRef.onDisconnect().cancel(); await vc.myRef.remove().catch(() => {}); }

  // Clean up our signals from Firebase
  if (sid && cid && myUid) {
    const base = "voiceSignals/" + sid + "/" + cid;
    db.ref(base + "/offers/" + myUid).remove().catch(() => {});
    db.ref(base + "/answers/" + myUid).remove().catch(() => {});
    db.ref(base + "/ice/" + myUid).remove().catch(() => {});
  }

  // Tear down all peers
  Object.keys(vc.peers).forEach(uid => teardownPeer(uid));
  vc.peers = {};
  vc.iceBuf = {};

  // Stop local media
  if (vc.localStream) { vc.localStream.getTracks().forEach(t => t.stop()); vc.localStream = null; }
  if (vc.audioCtx) { vc.audioCtx.close().catch(() => {}); vc.audioCtx = null; }
  vc.analysers = {};
  vc.speaking.clear();

  destroyVoiceBar();
  vc.sid = null; vc.cid = null;
  vc.muted = false; vc.camOff = false; vc.deafened = false;

  if (toast) showToast("Left voice channel.");
}

// ══════════════════════════════════════════════════════════════
//  VOICE BAR UI — Discord-style, top of chat area
// ══════════════════════════════════════════════════════════════
function buildVoiceBar(channelName) {
  destroyVoiceBar();
  const bar = document.createElement("div");
  bar.id = "vc-bar";
  bar.className = "vc-bar";
  bar.innerHTML =
    "<div class='vc-bar-left'>" +
      "<span class='vc-bar-icon'>🔊</span>" +
      "<span class='vc-bar-status'>Voice Connected</span>" +
      "<span class='vc-bar-channel'>" + escapeHtml(channelName || "") + "</span>" +
    "</div>" +
    "<div class='vc-tiles' id='vc-tiles'></div>" +
    "<div class='vc-bar-controls'>" +
      "<button class='vc-ctrl' id='vc-mute' title='Mute'>" +
        "<svg viewBox='0 0 24 24' fill='currentColor'><path d='M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z'/></svg>" +
      "</button>" +
      "<button class='vc-ctrl' id='vc-deafen' title='Deafen'>" +
        "<svg viewBox='0 0 24 24' fill='currentColor'><path d='M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z'/></svg>" +
      "</button>" +
      "<button class='vc-ctrl' id='vc-cam' title='Camera' " + (vc.type === "video" ? "" : "style='display:none'") + ">" +
        "<svg viewBox='0 0 24 24' fill='currentColor'><path d='M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z'/></svg>" +
      "</button>" +
      "<button class='vc-ctrl vc-ctrl-leave' id='vc-leave' title='Leave'>" +
        "<svg viewBox='0 0 24 24' fill='currentColor'><path d='M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z'/></svg>" +
      "</button>" +
    "</div>";

  const chatMain = document.getElementById("chat-main");
  chatMain.insertBefore(bar, chatMain.firstChild);

  document.getElementById("vc-mute").addEventListener("click", vcToggleMute);
  document.getElementById("vc-deafen").addEventListener("click", vcToggleDeafen);
  document.getElementById("vc-cam").addEventListener("click", vcToggleCam);
  document.getElementById("vc-leave").addEventListener("click", () => leaveVoiceChannel(true));
}

function destroyVoiceBar() {
  const b = document.getElementById("vc-bar");
  if (b) b.remove();
}

function showVoiceBar() {
  const b = document.getElementById("vc-bar");
  if (b) b.style.display = "";
}

// ── Tiles ──────────────────────────────────────────────────────
function addTile(uid, profileData, stream, isSelf) {
  const grid = document.getElementById("vc-tiles");
  if (!grid || document.getElementById("vc-tile-" + uid)) return;

  const tile = document.createElement("div");
  tile.className = "vc-tile";
  tile.id = "vc-tile-" + uid;

  const hasVideo = stream && stream.getVideoTracks().length > 0;
  if (hasVideo) {
    const vid = document.createElement("video");
    vid.autoplay = true; vid.playsInline = true;
    if (isSelf) vid.muted = true;
    vid.srcObject = stream;
    vid.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;";
    tile.appendChild(vid);
  } else {
    const av = document.createElement("div");
    av.className = "vc-tile-av";
    renderAvatar(av, profileData);
    tile.appendChild(av);
  }

  const lbl = document.createElement("div");
  lbl.className = "vc-tile-label";
  lbl.textContent = (profileData.username || "User") + (isSelf ? " (you)" : "");
  tile.appendChild(lbl);

  const micIcon = document.createElement("div");
  micIcon.className = "vc-tile-mic";
  micIcon.id = "vc-mic-" + uid;
  micIcon.innerHTML = "🔇";
  micIcon.style.display = "none";
  tile.appendChild(micIcon);

  grid.appendChild(tile);
}

// ── Controls ──────────────────────────────────────────────────
function vcToggleMute() {
  if (!vc.localStream) return;
  vc.muted = !vc.muted;
  vc.localStream.getAudioTracks().forEach(t => { t.enabled = !vc.muted; });
  const btn = document.getElementById("vc-mute");
  if (btn) { btn.classList.toggle("active", vc.muted); btn.title = vc.muted ? "Unmute" : "Mute"; }
  const mic = document.getElementById("vc-mic-" + (AppState.currentUser && AppState.currentUser.uid));
  if (mic) mic.style.display = vc.muted ? "" : "none";
}

function vcToggleDeafen() {
  vc.deafened = !vc.deafened;
  Object.values(vc.audioEls).forEach(el => { el.muted = vc.deafened; });
  const btn = document.getElementById("vc-deafen");
  if (btn) btn.classList.toggle("active", vc.deafened);
  if (vc.deafened && !vc.muted) vcToggleMute();
}

function vcToggleCam() {
  if (!vc.localStream) return;
  vc.camOff = !vc.camOff;
  vc.localStream.getVideoTracks().forEach(t => { t.enabled = !vc.camOff; });
  const btn = document.getElementById("vc-cam");
  if (btn) btn.classList.toggle("active", vc.camOff);
}

// ── Ask join type ────────────────────────────────────────────
function askJoinType() {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML =
      "<div class='modal modal-sm' style='text-align:center'>" +
      "<h3 style='margin-bottom:6px'>Join Voice Channel</h3>" +
      "<p style='color:var(--text-muted);font-size:13px;margin-bottom:18px'>How do you want to join?</p>" +
      "<div style='display:flex;flex-direction:column;gap:10px'>" +
      "<button class='btn-primary full-width' id='jv-voice'>🎙️  Voice Only</button>" +
      "<button class='btn-secondary full-width' id='jv-video'>📹  Voice + Video</button>" +
      "<button class='btn-secondary full-width' id='jv-cancel' style='opacity:.6'>Cancel</button>" +
      "</div></div>";
    document.body.appendChild(ov);
    ov.querySelector("#jv-voice").onclick  = () => { ov.remove(); resolve(false); };
    ov.querySelector("#jv-video").onclick  = () => { ov.remove(); resolve(true);  };
    ov.querySelector("#jv-cancel").onclick = () => { ov.remove(); resolve(null);  };
  });
}

// ── Cleanup on page unload ───────────────────────────────────
window.addEventListener("beforeunload", () => {
  if (vc.myRef) vc.myRef.remove();
  if (vc.sid && vc.cid && AppState.currentUser) {
    const base = "voiceSignals/" + vc.sid + "/" + vc.cid;
    const uid = AppState.currentUser.uid;
    db.ref(base + "/offers/" + uid).remove();
    db.ref(base + "/answers/" + uid).remove();
    db.ref(base + "/ice/" + uid).remove();
  }
});
