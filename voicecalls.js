// voicecalls.js — group voice & video for server channels
//
// SIGNALLING STRUCTURE (flat — avoids child_added nesting bugs):
//
//   voiceChannels/<sid>/<cid>/participants/<uid>  → profile snapshot
//   voiceSignals/<sid>/<cid>/<callerUid>_<calleeUid>/offer      → SDP
//   voiceSignals/<sid>/<cid>/<callerUid>_<calleeUid>/answer     → SDP
//   voiceSignals/<sid>/<cid>/<callerUid>_<calleeUid>/candidates/<push> → ICE
//
// The pairKey is always sorted(uid1,uid2).join("_") so both sides
// agree on which path to read/write without coordinating.

const VOICE_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

// ── Module state ──────────────────────────────────────────────────────
let vc = {
  sid: null, cid: null,
  type: "voice",              // "voice" | "video"
  localStream: null,
  peers: {},                  // uid → { pc, iceBuf[] }
  audioEls: {},               // uid → <audio>
  participantsRef: null,
  myRef: null,
  signalRefs: {},             // pairKey → db ref
  muted: false,
  camOff: false,
  deafened: false,
  speaking: new Set(),
  analysers: {},
  audioCtx: null,
};

function pairKey(a, b) { return a < b ? a + "_" + b : b + "_" + a; }

function isUidSpeaking(uid) { return vc.speaking.has(uid); }

// ══════════════════════════════════════════════════════════════
//  JOIN
// ══════════════════════════════════════════════════════════════
async function joinVoiceChannel(sid, cid, channel) {
  if (vc.sid === sid && vc.cid === cid) { showVoiceBar(); return; }
  if (vc.sid) await leaveVoiceChannel(false);

  const wantsVideo = await askJoinType();
  if (wantsVideo === null) return;

  vc.sid  = sid;
  vc.cid  = cid;
  vc.type = wantsVideo ? "video" : "voice";

  const myUid = AppState.currentUser.uid;

  try {
    vc.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: wantsVideo ? { width: 640, height: 360, frameRate: 24 } : false,
    });
  } catch (e) {
    showToast("Could not access mic" + (wantsVideo ? "/camera" : "") + ". Check browser permissions.", "error");
    vc.sid = null; vc.cid = null;
    return;
  }

  startSpeakingDetection(myUid, vc.localStream);

  // Write presence
  vc.participantsRef = db.ref("voiceChannels/" + sid + "/" + cid + "/participants");
  vc.myRef = vc.participantsRef.child(myUid);
  const mySnapshot = {
    username: AppState.userProfile.username,
    avatar:   AppState.userProfile.avatar || "",
    type:     vc.type,
    joinedAt: Date.now(),
  };
  await vc.myRef.set(mySnapshot);
  vc.myRef.onDisconnect().remove();

  buildVoiceBar();
  renderSelfTile();

  // Watch participants
  vc.participantsRef.on("child_added", snap => {
    const uid = snap.key;
    if (uid === myUid) return;
    initPeer(uid, snap.val(), true); // true = I initiate
  });
  vc.participantsRef.on("child_changed", snap => {
    // Update tile label/video if they switch type mid-call
  });
  vc.participantsRef.on("child_removed", snap => {
    teardownPeer(snap.key);
  });

  // Listen for ALL signal messages addressed to me
  const mySignalInbox = db.ref("voiceSignals/" + sid + "/" + cid).orderByChild("to").equalTo(myUid);
  vc.signalRefs["__inbox__"] = mySignalInbox;
  mySignalInbox.on("child_added", async snap => {
    const sig = snap.val();
    if (!sig || sig.to !== myUid) return;
    const fromUid = sig.from;
    const key     = pairKey(myUid, fromUid);

    if (sig.type === "offer") {
      // Make sure we have a peer for this person
      if (!vc.peers[fromUid]) {
        const theirSnap = await vc.participantsRef.child(fromUid).get();
        const theirData = theirSnap.val() || { username: "User", avatar: "" };
        initPeer(fromUid, theirData, false);
      }
      const peer = vc.peers[fromUid];
      if (!peer) return;
      try {
        if (peer.pc.signalingState !== "stable") return;
        await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sig.sdp }));
        // Flush buffered ICE
        for (const c of peer.iceBuf) {
          try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
        }
        peer.iceBuf = [];
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await pushSignal(sid, cid, myUid, fromUid, "answer", answer.sdp);
      } catch(e) { console.warn("offer handling error:", e); }

    } else if (sig.type === "answer") {
      const peer = vc.peers[fromUid];
      if (!peer) return;
      try {
        if (peer.pc.signalingState !== "have-local-offer") return;
        await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sig.sdp }));
        for (const c of peer.iceBuf) {
          try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
        }
        peer.iceBuf = [];
      } catch(e) { console.warn("answer handling error:", e); }

    } else if (sig.type === "ice") {
      const peer = vc.peers[fromUid];
      if (!peer) return;
      const candidate = sig.candidate;
      if (peer.pc.remoteDescription) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
      } else {
        peer.iceBuf.push(candidate);
      }
    }
  });

  showToast("Joined #" + channel.name, "success");
}

/** Write a flat signal message to Firebase */
async function pushSignal(sid, cid, fromUid, toUid, type, sdp, candidate) {
  const msg = { from: fromUid, to: toUid, type, t: Date.now() };
  if (sdp)       msg.sdp       = sdp;
  if (candidate) msg.candidate = candidate;
  await db.ref("voiceSignals/" + sid + "/" + cid).push(msg);
}

// ══════════════════════════════════════════════════════════════
//  Peer setup
// ══════════════════════════════════════════════════════════════
function initPeer(uid, theirData, iAmInitiator) {
  if (vc.peers[uid]) return;
  const myUid = AppState.currentUser.uid;

  const pc = new RTCPeerConnection(VOICE_ICE);
  vc.peers[uid] = { pc, iceBuf: [], theirData };

  // Add all local tracks
  vc.localStream.getTracks().forEach(t => pc.addTrack(t, vc.localStream));

  // ICE → push to Firebase
  pc.onicecandidate = e => {
    if (!e.candidate || !vc.sid) return;
    pushSignal(vc.sid, vc.cid, myUid, uid, "ice", null, e.candidate.toJSON());
  };

  // Remote track → attach audio/video
  pc.ontrack = e => {
    if (e.streams && e.streams[0]) {
      attachRemoteStream(uid, theirData, e.streams[0]);
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed","disconnected"].includes(pc.connectionState)) {
      console.warn("Peer", uid, "connection:", pc.connectionState);
    }
    if (pc.connectionState === "failed") teardownPeer(uid);
  };

  // Only the lexicographically-smaller UID sends the offer (avoids glare)
  if (iAmInitiator && myUid < uid) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await pushSignal(vc.sid, vc.cid, myUid, uid, "offer", offer.sdp);
      } catch(e) { console.warn("offer create error:", e); }
    })();
  }
}

function teardownPeer(uid) {
  const peer = vc.peers[uid];
  if (peer) { peer.pc.close(); delete vc.peers[uid]; }

  const audioEl = vc.audioEls[uid];
  if (audioEl) { audioEl.srcObject = null; audioEl.remove(); delete vc.audioEls[uid]; }

  removeTile(uid);
  vc.speaking.delete(uid);
  delete vc.analysers[uid];
}

// ══════════════════════════════════════════════════════════════
//  Attach remote audio/video
// ══════════════════════════════════════════════════════════════
function attachRemoteStream(uid, theirData, stream) {
  // Always pipe audio through a hidden <audio> element
  let el = vc.audioEls[uid];
  if (!el) {
    el = document.createElement("audio");
    el.id = "vc-audio-" + uid;
    el.autoplay = true;
    el.style.display = "none";
    document.body.appendChild(el);
    vc.audioEls[uid] = el;
  }
  el.srcObject = stream;
  el.muted = vc.deafened;

  startSpeakingDetection(uid, stream);
  updateTile(uid, theirData, stream);
}

// ══════════════════════════════════════════════════════════════
//  Speaking detection
// ══════════════════════════════════════════════════════════════
function startSpeakingDetection(uid, stream) {
  try {
    if (!vc.audioCtx) vc.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vc.audioCtx.createMediaStreamSource(stream);
    const an  = vc.audioCtx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    vc.analysers[uid] = an;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!vc.analysers[uid]) return;
      an.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      const isSpeaking = avg > 10;
      if (isSpeaking) vc.speaking.add(uid); else vc.speaking.delete(uid);
      const tile = document.getElementById("vc-tile-" + uid);
      if (tile) tile.classList.toggle("speaking", isSpeaking);
      requestAnimationFrame(tick);
    };
    tick();
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
//  LEAVE
// ══════════════════════════════════════════════════════════════
async function leaveVoiceChannel(toast = true) {
  if (!vc.sid) return;

  if (vc.myRef) {
    vc.myRef.onDisconnect().cancel();
    await vc.myRef.remove().catch(() => {});
  }
  if (vc.participantsRef) vc.participantsRef.off();

  // Clean up signal inbox listener
  if (vc.signalRefs["__inbox__"]) vc.signalRefs["__inbox__"].off();
  // Delete old signals addressed to me so they don't fire on rejoin
  if (vc.sid && vc.cid && AppState.currentUser) {
    db.ref("voiceSignals/" + vc.sid + "/" + vc.cid)
      .orderByChild("to").equalTo(AppState.currentUser.uid)
      .get().then(snap => {
        if (snap.exists()) snap.forEach(c => c.ref.remove());
      }).catch(() => {});
  }

  Object.keys(vc.peers).forEach(uid => teardownPeer(uid));
  vc.peers = {};
  vc.signalRefs = {};

  if (vc.localStream) {
    vc.localStream.getTracks().forEach(t => t.stop());
    vc.localStream = null;
  }
  if (vc.audioCtx) { vc.audioCtx.close().catch(() => {}); vc.audioCtx = null; }
  vc.analysers = {};
  vc.speaking.clear();

  destroyVoiceBar();

  vc.sid = null; vc.cid = null;
  vc.muted = false; vc.camOff = false; vc.deafened = false;

  if (toast) showToast("Left voice channel.");
}

// ══════════════════════════════════════════════════════════════
//  DISCORD-STYLE TOP BAR UI
//  Sits fixed at the very top of the chat area, above the header.
//  Contains: channel name, participant tiles, controls (mute/cam/deafen/leave)
// ══════════════════════════════════════════════════════════════
function buildVoiceBar() {
  destroyVoiceBar();

  const bar = document.createElement("div");
  bar.id = "vc-bar";
  bar.className = "vc-bar";
  bar.innerHTML = `
    <div class="vc-bar-left">
      <span class="vc-bar-icon">🔊</span>
      <span class="vc-bar-status">Voice Connected</span>
      <span class="vc-bar-channel" id="vc-bar-channel">${escapeHtml(AppState.activeServer ? AppState.activeServer.data.name : "")} / ${vc.cid}</span>
    </div>
    <div class="vc-tiles" id="vc-tiles"></div>
    <div class="vc-bar-controls">
      <button class="vc-ctrl" id="vc-mute"   title="Mute"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></button>
      <button class="vc-ctrl" id="vc-deafen" title="Deafen"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z"/></svg></button>
      <button class="vc-ctrl" id="vc-cam"    title="Camera" style="${vc.type === "video" ? "" : "display:none"}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg></button>
      <button class="vc-ctrl vc-ctrl-leave" id="vc-leave" title="Leave Channel"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z"/></svg></button>
    </div>
  `;

  // Insert at top of chat-main, before all children
  const chatMain = document.getElementById("chat-main");
  chatMain.insertBefore(bar, chatMain.firstChild);

  document.getElementById("vc-mute").addEventListener("click", vcToggleMute);
  document.getElementById("vc-deafen").addEventListener("click", vcToggleDeafen);
  document.getElementById("vc-cam").addEventListener("click", vcToggleCam);
  document.getElementById("vc-leave").addEventListener("click", () => leaveVoiceChannel(true));

  // Update channel name when server or channel is known
  updateVoiceBarChannel();
}

function updateVoiceBarChannel() {
  const el = document.getElementById("vc-bar-channel");
  if (!el || !vc.sid || !vc.cid) return;
  db.ref("channels/" + vc.sid + "/" + vc.cid + "/name").get().then(snap => {
    if (snap.exists() && el) el.textContent = snap.val();
  }).catch(() => {});
}

function showVoiceBar() {
  const bar = document.getElementById("vc-bar");
  if (bar) bar.style.display = "";
}

function destroyVoiceBar() {
  const bar = document.getElementById("vc-bar");
  if (bar) bar.remove();
}

// ── Tiles inside the bar ──────────────────────────────────────────────
function renderSelfTile() {
  const myUid = AppState.currentUser.uid;
  addTile(myUid, AppState.userProfile, vc.localStream, true);
}

function addTile(uid, profileData, stream, isSelf) {
  const grid = document.getElementById("vc-tiles");
  if (!grid || document.getElementById("vc-tile-" + uid)) return;

  const tile = document.createElement("div");
  tile.className = "vc-tile";
  tile.id = "vc-tile-" + uid;

  if (vc.type === "video" && stream && stream.getVideoTracks().length > 0) {
    const vid = document.createElement("video");
    vid.autoplay = true; vid.playsInline = true;
    if (isSelf) vid.muted = true;
    vid.srcObject = stream;
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

  const micOff = document.createElement("div");
  micOff.className = "vc-tile-mic";
  micOff.id = "vc-mic-" + uid;
  micOff.innerHTML = "🔇";
  micOff.style.display = "none";
  tile.appendChild(micOff);

  grid.appendChild(tile);
}

function updateTile(uid, profileData, stream) {
  // If tile exists but was avatar-only, upgrade to video
  const existing = document.getElementById("vc-tile-" + uid);
  if (existing) {
    const hasVideo = stream && stream.getVideoTracks().length > 0;
    const existingVideo = existing.querySelector("video");
    if (hasVideo && !existingVideo) {
      const av = existing.querySelector(".vc-tile-av");
      if (av) {
        const vid = document.createElement("video");
        vid.autoplay = true; vid.playsInline = true;
        vid.srcObject = stream;
        av.replaceWith(vid);
      }
    } else if (existingVideo && !hasVideo) {
      // Switch back to avatar
      const vid = existingVideo;
      const av = document.createElement("div");
      av.className = "vc-tile-av";
      renderAvatar(av, profileData);
      vid.replaceWith(av);
    } else if (existingVideo && hasVideo) {
      existingVideo.srcObject = stream;
    }
  } else {
    addTile(uid, profileData, stream, false);
  }
}

function removeTile(uid) {
  const tile = document.getElementById("vc-tile-" + uid);
  if (tile) tile.remove();
}

// ── Controls ──────────────────────────────────────────────────────────
function vcToggleMute() {
  if (!vc.localStream) return;
  vc.muted = !vc.muted;
  vc.localStream.getAudioTracks().forEach(t => { t.enabled = !vc.muted; });
  const btn = document.getElementById("vc-mute");
  if (btn) btn.classList.toggle("active", vc.muted);
  btn.title = vc.muted ? "Unmute" : "Mute";

  const micEl = document.getElementById("vc-mic-" + AppState.currentUser.uid);
  if (micEl) micEl.style.display = vc.muted ? "" : "none";
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

// ══════════════════════════════════════════════════════════════
//  Ask voice vs video
// ══════════════════════════════════════════════════════════════
function askJoinType() {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML =
      "<div class='modal modal-sm' style='text-align:center'>" +
      "<h3 style='margin-bottom:6px'>Join Voice Channel</h3>" +
      "<p style='color:var(--text-muted);font-size:13px;margin-bottom:18px'>Choose how you want to join</p>" +
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

// ══════════════════════════════════════════════════════════════
//  Page unload cleanup
// ══════════════════════════════════════════════════════════════
window.addEventListener("beforeunload", () => {
  if (vc.myRef) vc.myRef.remove();
});
