// voicecalls.js — group voice & video calls in server channels
//
// MESH ARCHITECTURE: every participant opens a direct WebRTC
// connection to every other participant (good for small groups,
// ~2-8 people; for larger groups you'd want an SFU media server).
//
// Signalling lives at:
//   voiceChannels/<sid>/<cid>/participants/<uid>        → { username, joinedAt }
//   voiceSignals/<sid>/<cid>/<uid>/<fromUid>/offer       → SDP offer
//   voiceSignals/<sid>/<cid>/<uid>/<fromUid>/answer      → SDP answer
//   voiceSignals/<sid>/<cid>/<uid>/<fromUid>/candidates/ → ICE candidates

const VOICE_ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

// ── Module state ──────────────────────────────────────────────────────
let _voiceSid          = null;
let _voiceCid          = null;
let _voiceType         = "voice";   // "voice" | "video"
let _voiceLocalStream  = null;
let _voicePeers        = {};        // uid → RTCPeerConnection
let _voiceAudioEls     = {};        // uid → <audio> or <video> element
let _voiceParticipantsRef = null;
let _voiceMyParticipantRef = null;
let _voiceSignalRefs   = {};        // uid → ref being listened to (for cleanup)
let _voiceMuted        = false;
let _voiceCamOff       = false;
let _voiceDeafened     = false;
let _speakingUids      = new Set();
let _voiceAnalysers    = {};        // uid → AnalyserNode for speaking detection

function isUidSpeaking(uid) { return _speakingUids.has(uid); }

// ══════════════════════════════════════════════════════════════
//  JOIN a voice channel
// ══════════════════════════════════════════════════════════════
async function joinVoiceChannel(sid, cid, channel) {
  // Already in this exact channel — open the panel back up
  if (_voiceSid === sid && _voiceCid === cid) {
    showVoicePanel();
    return;
  }
  // Switching channels — leave old one first
  if (_voiceSid) await leaveVoiceChannel(false);

  // Ask: voice only, or with camera?
  const wantsVideo = await askJoinType();
  if (wantsVideo === null) return; // cancelled

  _voiceSid  = sid;
  _voiceCid  = cid;
  _voiceType = wantsVideo ? "video" : "voice";

  const myUid = AppState.currentUser.uid;

  try {
    _voiceLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantsVideo,
    });
  } catch (e) {
    showToast("Could not access microphone" + (wantsVideo ? "/camera" : "") + ".", "error");
    _voiceSid = null; _voiceCid = null;
    return;
  }

  setupLocalSpeakingDetection(myUid, _voiceLocalStream);

  // Announce presence
  _voiceParticipantsRef  = db.ref("voiceChannels/" + sid + "/" + cid + "/participants");
  _voiceMyParticipantRef = _voiceParticipantsRef.child(myUid);
  await _voiceMyParticipantRef.set({
    username:  AppState.userProfile.username,
    avatar:    AppState.userProfile.avatar || "",
    type:      _voiceType,
    joinedAt:  Date.now(),
  });
  _voiceMyParticipantRef.onDisconnect().remove();

  showVoicePanel();
  renderVoiceParticipantSelf();

  // Watch participant list — connect to anyone new, disconnect from anyone gone
  _voiceParticipantsRef.on("child_added", snap => {
    const uid = snap.key;
    if (uid === myUid) return;
    connectToPeer(sid, cid, uid, snap.val());
  });
  _voiceParticipantsRef.on("child_removed", snap => {
    const uid = snap.key;
    disconnectFromPeer(uid);
  });

  // Listen for incoming signals directed at me
  listenForSignals(sid, cid, myUid);

  showToast("Joined voice channel #" + channel.name, "success");
}

// ── Ask voice-only vs video, via a quick inline modal ──────────────────
function askJoinType() {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      "<div class='modal modal-sm' style='text-align:center'>" +
      "<h3 style='margin-bottom:18px'>Join Voice Channel</h3>" +
      "<div style='display:flex;flex-direction:column;gap:10px'>" +
      "<button class='btn-primary full-width' id='join-voice-only'>🎙️ Voice Only</button>" +
      "<button class='btn-secondary full-width' id='join-with-video'>📹 Voice + Video</button>" +
      "<button class='btn-secondary full-width' id='join-cancel' style='opacity:.7'>Cancel</button>" +
      "</div></div>";
    document.body.appendChild(overlay);

    overlay.querySelector("#join-voice-only").onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector("#join-with-video").onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector("#join-cancel").onclick     = () => { overlay.remove(); resolve(null); };
  });
}

// ══════════════════════════════════════════════════════════════
//  Connect to a peer (mesh — one RTCPeerConnection per participant)
// ══════════════════════════════════════════════════════════════
async function connectToPeer(sid, cid, theirUid, theirData) {
  const myUid = AppState.currentUser.uid;
  if (_voicePeers[theirUid]) return; // already connected

  const pc = new RTCPeerConnection(VOICE_ICE_SERVERS);
  _voicePeers[theirUid] = pc;

  _voiceLocalStream.getTracks().forEach(t => pc.addTrack(t, _voiceLocalStream));

  // Determine who initiates the offer deterministically (avoids glare)
  const iAmInitiator = myUid < theirUid;

  const sigBase = "voiceSignals/" + sid + "/" + cid;

  pc.onicecandidate = e => {
    if (!e.candidate) return;
    db.ref(sigBase + "/" + theirUid + "/" + myUid + "/candidates").push(e.candidate.toJSON());
  };

  pc.ontrack = e => {
    attachRemoteStream(theirUid, theirData, e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) {
      disconnectFromPeer(theirUid);
    }
  };

  if (iAmInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await db.ref(sigBase + "/" + theirUid + "/" + myUid + "/offer").set({ type: offer.type, sdp: offer.sdp });
  }
  // else: wait for their offer via listenForSignals
}

function disconnectFromPeer(uid) {
  if (_voicePeers[uid]) { _voicePeers[uid].close(); delete _voicePeers[uid]; }
  if (_voiceSignalRefs[uid]) { _voiceSignalRefs[uid].off(); delete _voiceSignalRefs[uid]; }
  const el = _voiceAudioEls[uid];
  if (el) { el.remove(); delete _voiceAudioEls[uid]; }
  removeVoiceParticipantTile(uid);
  _speakingUids.delete(uid);
}

// ══════════════════════════════════════════════════════════════
//  Signal listener — handles offers/answers/candidates addressed to me
// ══════════════════════════════════════════════════════════════
function listenForSignals(sid, cid, myUid) {
  const myInboxRef = db.ref("voiceSignals/" + sid + "/" + cid + "/" + myUid);
  _voiceSignalRefs["__inbox__"] = myInboxRef;

  myInboxRef.on("child_added", async snap => {
    const fromUid = snap.key;
    const data    = snap.val();
    if (!data) return;

    let pc = _voicePeers[fromUid];
    if (!pc) {
      // We haven't connected to them yet (they joined after us, or race) — build pc now
      const theirData = (await db.ref("voiceChannels/" + sid + "/" + cid + "/participants/" + fromUid).get()).val();
      if (!theirData) return;
      await connectToPeerPassive(sid, cid, fromUid, theirData);
      pc = _voicePeers[fromUid];
    }
    if (!pc) return;

    if (data.offer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await db.ref("voiceSignals/" + sid + "/" + cid + "/" + fromUid + "/" + myUid + "/answer")
        .set({ type: answer.type, sdp: answer.sdp });
    }
    if (data.answer && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
    if (data.candidates) {
      Object.values(data.candidates).forEach(async c => {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
      });
    }
  });
}

// Passive connection — built when we receive an offer before we proactively connected
async function connectToPeerPassive(sid, cid, theirUid, theirData) {
  if (_voicePeers[theirUid]) return;
  const myUid = AppState.currentUser.uid;
  const pc = new RTCPeerConnection(VOICE_ICE_SERVERS);
  _voicePeers[theirUid] = pc;

  _voiceLocalStream.getTracks().forEach(t => pc.addTrack(t, _voiceLocalStream));

  const sigBase = "voiceSignals/" + sid + "/" + cid;
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    db.ref(sigBase + "/" + theirUid + "/" + myUid + "/candidates").push(e.candidate.toJSON());
  };
  pc.ontrack = e => attachRemoteStream(theirUid, theirData, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) disconnectFromPeer(theirUid);
  };
}

// ══════════════════════════════════════════════════════════════
//  Remote media handling
// ══════════════════════════════════════════════════════════════
function attachRemoteStream(uid, profileData, stream) {
  // Audio always plays through a hidden <audio> element
  let audioEl = document.getElementById("voice-audio-" + uid);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "voice-audio-" + uid;
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  audioEl.muted = _voiceDeafened;
  _voiceAudioEls[uid] = audioEl;

  setupRemoteSpeakingDetection(uid, stream);
  renderVoiceParticipantTile(uid, profileData, stream);
}

// ── Speaking detection via Web Audio analyser ──────────────────────────
let _voiceAudioCtx = null;
function getVoiceAudioCtx() {
  if (!_voiceAudioCtx) _voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _voiceAudioCtx;
}

function setupLocalSpeakingDetection(uid, stream) {
  setupSpeakingDetectionGeneric(uid, stream);
}
function setupRemoteSpeakingDetection(uid, stream) {
  setupSpeakingDetectionGeneric(uid, stream);
}
function setupSpeakingDetectionGeneric(uid, stream) {
  try {
    const ctx = getVoiceAudioCtx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    _voiceAnalysers[uid] = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!_voiceAnalysers[uid]) return; // stopped
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = avg > 12;
      if (speaking) _speakingUids.add(uid); else _speakingUids.delete(uid);
      updateSpeakingUI(uid, speaking);
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { console.warn("Speaking detection unavailable:", e); }
}

function updateSpeakingUI(uid, speaking) {
  const tile = document.getElementById("voice-tile-" + uid);
  if (tile) tile.classList.toggle("speaking", speaking);
  const sideAv = document.querySelector(".voice-participant-avatar[title]");
}

// ══════════════════════════════════════════════════════════════
//  LEAVE voice channel
// ══════════════════════════════════════════════════════════════
async function leaveVoiceChannel(showToastMsg = true) {
  if (!_voiceSid) return;

  // Remove our presence
  if (_voiceMyParticipantRef) {
    _voiceMyParticipantRef.onDisconnect().cancel();
    await _voiceMyParticipantRef.remove();
  }

  // Close all peer connections
  Object.keys(_voicePeers).forEach(uid => disconnectFromPeer(uid));
  _voicePeers = {};

  // Stop listeners
  if (_voiceParticipantsRef) _voiceParticipantsRef.off();
  if (_voiceSignalRefs["__inbox__"]) _voiceSignalRefs["__inbox__"].off();
  _voiceSignalRefs = {};

  // Clean up our own signal inbox in DB
  if (_voiceSid && _voiceCid && AppState.currentUser) {
    db.ref("voiceSignals/" + _voiceSid + "/" + _voiceCid + "/" + AppState.currentUser.uid).remove().catch(() => {});
  }

  // Stop local media
  if (_voiceLocalStream) {
    _voiceLocalStream.getTracks().forEach(t => t.stop());
    _voiceLocalStream = null;
  }

  // Stop speaking detection
  Object.keys(_voiceAnalysers).forEach(uid => delete _voiceAnalysers[uid]);
  _speakingUids.clear();

  hideVoicePanel();

  const wasSid = _voiceSid, wasCid = _voiceCid;
  _voiceSid = null; _voiceCid = null;

  if (showToastMsg) showToast("Left voice channel.");
}

// ══════════════════════════════════════════════════════════════
//  Voice panel UI (persistent bottom bar + expandable grid)
// ══════════════════════════════════════════════════════════════
function ensureVoicePanelDOM() {
  if (document.getElementById("voice-call-panel")) return;

  const panel = document.createElement("div");
  panel.id = "voice-call-panel";
  panel.className = "voice-call-panel hidden";
  panel.innerHTML = `
    <div class="voice-panel-header">
      <span id="voice-panel-title">Voice Connected</span>
      <button class="icon-btn" id="voice-panel-expand" title="Expand">⤢</button>
    </div>
    <div class="voice-panel-grid" id="voice-panel-grid"></div>
    <div class="voice-panel-controls">
      <button class="call-ctrl-btn small" id="voice-mute-btn" title="Mute">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
      </button>
      <button class="call-ctrl-btn small" id="voice-deafen-btn" title="Deafen">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z"/></svg>
      </button>
      <button class="call-ctrl-btn small" id="voice-video-btn" title="Toggle Camera">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg>
      </button>
      <button class="call-ctrl-btn small call-ctrl-end" id="voice-leave-btn" title="Leave">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 9.02C24 5.4 18.67 2 12 2S0 5.4 0 9.02c0 2.04 1.3 3.88 3.34 5.18L2 17.5l4.5-1.26C7.89 16.73 9.9 17 12 17s4.11-.27 5.5-.76L22 17.5l-1.34-3.3C22.7 12.9 24 11.06 24 9.02z"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById("voice-mute-btn").addEventListener("click", toggleVoiceMute);
  document.getElementById("voice-deafen-btn").addEventListener("click", toggleVoiceDeafen);
  document.getElementById("voice-video-btn").addEventListener("click", toggleVoiceCamera);
  document.getElementById("voice-leave-btn").addEventListener("click", () => leaveVoiceChannel(true));
  document.getElementById("voice-panel-expand").addEventListener("click", () => {
    panel.classList.toggle("expanded");
  });
}

function showVoicePanel() {
  ensureVoicePanelDOM();
  const panel = document.getElementById("voice-call-panel");
  panel.classList.remove("hidden");
  document.getElementById("voice-video-btn").style.display = _voiceType === "video" ? "" : "none";
}

function hideVoicePanel() {
  const panel = document.getElementById("voice-call-panel");
  if (panel) panel.classList.add("hidden");
  const grid = document.getElementById("voice-panel-grid");
  if (grid) grid.innerHTML = "";
}

function renderVoiceParticipantSelf() {
  const grid = document.getElementById("voice-panel-grid");
  if (!grid) return;
  const myUid = AppState.currentUser.uid;
  const tile = buildVoiceTile(myUid, AppState.userProfile, _voiceLocalStream, true);
  grid.appendChild(tile);
}

function renderVoiceParticipantTile(uid, profileData, stream) {
  const grid = document.getElementById("voice-panel-grid");
  if (!grid) return;
  if (document.getElementById("voice-tile-" + uid)) return;
  const tile = buildVoiceTile(uid, profileData, stream, false);
  grid.appendChild(tile);
}

function removeVoiceParticipantTile(uid) {
  const tile = document.getElementById("voice-tile-" + uid);
  if (tile) tile.remove();
}

function buildVoiceTile(uid, profileData, stream, isSelf) {
  const tile = document.createElement("div");
  tile.className = "voice-tile";
  tile.id = "voice-tile-" + uid;

  if (_voiceType === "video" && stream && stream.getVideoTracks().length) {
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true;
    if (isSelf) video.muted = true;
    video.srcObject = stream;
    tile.appendChild(video);
  } else {
    const av = document.createElement("div");
    av.className = "voice-tile-avatar";
    renderAvatar(av, profileData);
    tile.appendChild(av);
  }

  const label = document.createElement("div");
  label.className = "voice-tile-label";
  label.textContent = (profileData.username || "User") + (isSelf ? " (you)" : "");
  tile.appendChild(label);

  return tile;
}

// ══════════════════════════════════════════════════════════════
//  Controls
// ══════════════════════════════════════════════════════════════
function toggleVoiceMute() {
  if (!_voiceLocalStream) return;
  _voiceMuted = !_voiceMuted;
  _voiceLocalStream.getAudioTracks().forEach(t => { t.enabled = !_voiceMuted; });
  document.getElementById("voice-mute-btn").classList.toggle("muted", _voiceMuted);
}

function toggleVoiceDeafen() {
  _voiceDeafened = !_voiceDeafened;
  Object.values(_voiceAudioEls).forEach(el => { el.muted = _voiceDeafened; });
  document.getElementById("voice-deafen-btn").classList.toggle("muted", _voiceDeafened);
  // Deafening also mutes your mic, like Discord
  if (_voiceDeafened && !_voiceMuted) toggleVoiceMute();
}

function toggleVoiceCamera() {
  if (!_voiceLocalStream) return;
  _voiceCamOff = !_voiceCamOff;
  _voiceLocalStream.getVideoTracks().forEach(t => { t.enabled = !_voiceCamOff; });
  document.getElementById("voice-video-btn").classList.toggle("muted", _voiceCamOff);
}

// ══════════════════════════════════════════════════════════════
//  Leave on page unload
// ══════════════════════════════════════════════════════════════
window.addEventListener("beforeunload", () => {
  if (_voiceSid && _voiceMyParticipantRef) {
    _voiceMyParticipantRef.remove();
  }
});
