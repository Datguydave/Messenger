// calling.js — WebRTC 1-to-1 voice & video calls
// Signalling via Firebase Realtime Database  (/calls/<callId>)
//
// Flow:
//   Caller  → writes offer + ICE candidates to /calls/<callId>
//   Callee  → reads offer, writes answer + ICE candidates
//   Both    → exchange ICE, peer connection established
//   Either  → writes { ended: true } to hang up
//
// callId = sorted(myUid, theirUid).join("_")  (deterministic)

// ══════════════════════════════════════════════════════════════
//  STUN / TURN servers  (free public STUN — works on most nets)
// ══════════════════════════════════════════════════════════════
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Free TURN from Open Relay (helps when direct P2P fails)
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// ══════════════════════════════════════════════════════════════
//  Module state
// ══════════════════════════════════════════════════════════════
let _pc            = null;   // RTCPeerConnection
let _localStream   = null;   // MediaStream (mic ± camera)
let _callId        = null;   // Firebase path key
let _callRef       = null;   // db.ref("calls/<callId>")
let _isCaller      = false;
let _callType      = "voice"; // "voice" | "video"
let _remoteUid     = null;
let _remoteProfile = null;
let _timerInterval = null;
let _timerSec      = 0;
let _muted         = false;
let _camOff        = false;
let _incomingUnsub = null;  // unsubscribe fn for incoming call listener

// ══════════════════════════════════════════════════════════════
//  Initialise — called once after login
// ══════════════════════════════════════════════════════════════
function initCalling() {
  listenForIncomingCalls();

  document.getElementById("start-voice-btn").addEventListener("click", () => startCall("voice"));
  document.getElementById("start-video-btn").addEventListener("click", () => startCall("video"));
  document.getElementById("call-accept-btn").addEventListener("click", acceptCall);
  document.getElementById("call-decline-btn").addEventListener("click", declineCall);
  document.getElementById("ctrl-end-btn").addEventListener("click", endCall);
  document.getElementById("ctrl-mute-btn").addEventListener("click", toggleMute);
  document.getElementById("ctrl-video-btn").addEventListener("click", toggleCamera);
}

// ══════════════════════════════════════════════════════════════
//  Show / hide call buttons in chat header
// ══════════════════════════════════════════════════════════════
function setCallButtonsVisible(visible) {
  document.getElementById("start-voice-btn").style.display = visible ? "" : "none";
  document.getElementById("start-video-btn").style.display = visible ? "" : "none";
}

// openDM in friends.js should call this — we hook it:
const _origOpenDM = window.openDM;
window.openDM = function (targetUid, profile) {
  _origOpenDM && _origOpenDM(targetUid, profile);
  _remoteUid     = targetUid;
  _remoteProfile = profile;
  setCallButtonsVisible(true);
};

// When home or server selected, hide call buttons
document.getElementById("home-btn").addEventListener("click", () => setCallButtonsVisible(false));

// Hide call buttons when a server is selected (wrap selectServer)
const _origSelectServer = window.selectServer;
window.selectServer = async function (sid, serverData) {
  setCallButtonsVisible(false);
  return _origSelectServer ? _origSelectServer(sid, serverData) : undefined;
};

// ══════════════════════════════════════════════════════════════
//  Listen for incoming calls
// ══════════════════════════════════════════════════════════════
function listenForIncomingCalls() {
  // Wait until auth is ready
  if (!AppState.currentUser) {
    setTimeout(listenForIncomingCalls, 500);
    return;
  }
  const myUid = AppState.currentUser.uid;

  // Watch /callsIncoming/<myUid> — caller writes here to ring us
  const incomingRef = db.ref("callsIncoming/" + myUid);
  incomingRef.on("value", async snap => {
    if (!snap.exists()) return;
    const data = snap.val();
    if (data.status !== "ringing") return;

    // Already in a call — auto-decline
    if (_pc) {
      await db.ref("callsIncoming/" + myUid + "/status").set("declined");
      return;
    }

    _callId        = data.callId;
    _callType      = data.type || "voice";
    _isCaller      = false;
    _remoteUid     = data.callerUid;
    _remoteProfile = await fetchProfile(data.callerUid);
    _callRef       = db.ref("calls/" + _callId);

    showIncomingUI(_remoteProfile, _callType);
  });
}

// ══════════════════════════════════════════════════════════════
//  START CALL (caller side)
// ══════════════════════════════════════════════════════════════
async function startCall(type) {
  if (!_remoteUid) { showToast("Open a DM first.", "error"); return; }
  if (_pc)         { showToast("Already in a call.", "error"); return; }

  _callType  = type;
  _isCaller  = true;
  _callId    = [AppState.currentUser.uid, _remoteUid].sort().join("_") + "_" + Date.now();
  _callRef   = db.ref("calls/" + _callId);

  // Get local media
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video",
    });
  } catch (e) {
    showToast("Could not access microphone" + (type === "video" ? "/camera" : "") + ". Check browser permissions.", "error");
    return;
  }

  showActiveCallUI(type, _remoteProfile, "Calling…");
  playRingtone(true);

  // Notify callee
  await db.ref("callsIncoming/" + _remoteUid).set({
    callId:    _callId,
    callerUid: AppState.currentUser.uid,
    type:      type,
    status:    "ringing",
    timestamp: Date.now(),
  });

  // Build peer connection
  _pc = createPeerConnection();
  _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

  // Attach local video preview
  if (type === "video") {
    document.getElementById("local-video").srcObject = _localStream;
  }

  // Create offer
  const offer = await _pc.createOffer();
  await _pc.setLocalDescription(offer);
  await _callRef.set({
    offer:     { type: offer.type, sdp: offer.sdp },
    callerUid: AppState.currentUser.uid,
    calleeUid: _remoteUid,
    type:      type,
    status:    "calling",
    timestamp: Date.now(),
  });

  // Watch for answer
  _callRef.on("value", async snap => {
    if (!snap.exists()) return;
    const data = snap.val();

    if (data.status === "declined" || data.status === "ended") {
      cleanupCall(data.status === "declined" ? "Call declined." : "Call ended.");
      return;
    }

    if (data.answer && _pc && !_pc.currentRemoteDescription) {
      await _pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      stopRingtone();
      setCallStatus("Connected");
      startTimer();
      document.getElementById("active-call-overlay").classList.add("connected");
    }

    // Collect remote ICE candidates
    if (data.calleeCandidates) {
      Object.values(data.calleeCandidates).forEach(async c => {
        if (c && _pc) {
          try { await _pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
        }
      });
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  ACCEPT CALL (callee side)
// ══════════════════════════════════════════════════════════════
async function acceptCall() {
  hideIncomingUI();
  stopRingtone();

  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: _callType === "video",
    });
  } catch (e) {
    showToast("Could not access microphone" + (_callType === "video" ? "/camera" : "") + ". Check browser permissions.", "error");
    await db.ref("callsIncoming/" + AppState.currentUser.uid + "/status").set("declined");
    return;
  }

  showActiveCallUI(_callType, _remoteProfile, "Connecting…");

  _pc = createPeerConnection();
  _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

  if (_callType === "video") {
    document.getElementById("local-video").srcObject = _localStream;
  }

  // Get offer
  const snap = await _callRef.get();
  const data = snap.val();
  await _pc.setRemoteDescription(new RTCSessionDescription(data.offer));

  const answer = await _pc.createAnswer();
  await _pc.setLocalDescription(answer);
  await _callRef.update({
    answer: { type: answer.type, sdp: answer.sdp },
    status: "connected",
  });
  await db.ref("callsIncoming/" + AppState.currentUser.uid + "/status").set("answered");

  // Collect caller's ICE candidates
  _callRef.on("value", snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.status === "ended") { cleanupCall("Call ended."); return; }
    if (d.callerCandidates) {
      Object.values(d.callerCandidates).forEach(async c => {
        if (c && _pc) {
          try { await _pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
        }
      });
    }
  });

  setCallStatus("Connected");
  startTimer();
  document.getElementById("active-call-overlay").classList.add("connected");
}

// ══════════════════════════════════════════════════════════════
//  DECLINE (callee side)
// ══════════════════════════════════════════════════════════════
async function declineCall() {
  hideIncomingUI();
  stopRingtone();
  if (_callRef) await _callRef.update({ status: "declined" });
  await db.ref("callsIncoming/" + AppState.currentUser.uid + "/status").set("declined");
  _callId = null; _callRef = null; _remoteProfile = null;
}

// ══════════════════════════════════════════════════════════════
//  END CALL (either side)
// ══════════════════════════════════════════════════════════════
async function endCall() {
  if (_callRef) await _callRef.update({ status: "ended" });
  const myUid = AppState.currentUser && AppState.currentUser.uid;
  if (myUid) await db.ref("callsIncoming/" + myUid + "/status").set("ended").catch(() => {});
  if (_remoteUid) await db.ref("callsIncoming/" + _remoteUid + "/status").set("ended").catch(() => {});
  cleanupCall("Call ended.");
}

// ══════════════════════════════════════════════════════════════
//  CLEANUP
// ══════════════════════════════════════════════════════════════
function cleanupCall(toastMsg) {
  stopTimer();
  stopRingtone();
  hideIncomingUI();
  hideActiveCallUI();

  if (_callRef) { _callRef.off(); _callRef = null; }

  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
    _localStream = null;
  }
  if (_pc) { _pc.close(); _pc = null; }

  // Clear video elements
  const rv = document.getElementById("remote-video");
  const lv = document.getElementById("local-video");
  const ra = document.getElementById("call-audio-remote");
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  if (ra) ra.srcObject = null;

  _callId = null; _isCaller = false; _muted = false; _camOff = false;
  _timerSec = 0;

  if (toastMsg) showToast(toastMsg);
}

// ══════════════════════════════════════════════════════════════
//  RTCPeerConnection factory
// ══════════════════════════════════════════════════════════════
function createPeerConnection() {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // Send our ICE candidates to Firebase
  pc.onicecandidate = async e => {
    if (!e.candidate || !_callRef) return;
    const candidatePath = _isCaller ? "callerCandidates" : "calleeCandidates";
    await _callRef.child(candidatePath).push(e.candidate.toJSON());
  };

  // Receive remote tracks
  pc.ontrack = e => {
    if (e.streams && e.streams[0]) {
      if (_callType === "video") {
        document.getElementById("remote-video").srcObject = e.streams[0];
      } else {
        document.getElementById("call-audio-remote").srcObject = e.streams[0];
      }
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "connected") {
      setCallStatus("Connected");
      stopRingtone();
      startTimer();
      document.getElementById("active-call-overlay").classList.add("connected");
    } else if (["failed","disconnected","closed"].includes(pc.connectionState)) {
      cleanupCall("Call disconnected.");
    }
  };

  return pc;
}

// ══════════════════════════════════════════════════════════════
//  CONTROLS
// ══════════════════════════════════════════════════════════════
function toggleMute() {
  if (!_localStream) return;
  _muted = !_muted;
  _localStream.getAudioTracks().forEach(t => { t.enabled = !_muted; });
  const btn = document.getElementById("ctrl-mute-btn");
  btn.classList.toggle("muted", _muted);
  btn.title = _muted ? "Unmute" : "Mute";
  btn.innerHTML = _muted
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
}

function toggleCamera() {
  if (!_localStream) return;
  _camOff = !_camOff;
  _localStream.getVideoTracks().forEach(t => { t.enabled = !_camOff; });
  const btn = document.getElementById("ctrl-video-btn");
  btn.classList.toggle("muted", _camOff);
  btn.title = _camOff ? "Turn on camera" : "Turn off camera";
}

// ══════════════════════════════════════════════════════════════
//  UI helpers
// ══════════════════════════════════════════════════════════════
function showIncomingUI(profile, type) {
  const overlay = document.getElementById("incoming-call-overlay");
  const av      = document.getElementById("call-incoming-avatar");
  const nm      = document.getElementById("call-incoming-name");
  const tp      = document.getElementById("call-incoming-type");

  renderAvatar(av, profile);
  nm.textContent = profile ? profile.username : "Someone";
  tp.textContent = "Incoming " + type + " call…";
  overlay.classList.remove("hidden");
  playRingtone(false);
}

function hideIncomingUI() {
  document.getElementById("incoming-call-overlay").classList.add("hidden");
}

function showActiveCallUI(type, profile, statusText) {
  const overlay = document.getElementById("active-call-overlay");
  overlay.classList.remove("hidden", "connected");

  const voiceArea = document.getElementById("call-voice-area");
  const videoArea = document.getElementById("call-video-area");
  const videoBtn  = document.getElementById("ctrl-video-btn");

  if (type === "video") {
    videoArea.classList.remove("hidden");
    voiceArea.style.position = "absolute";
    voiceArea.style.bottom = "110px";
    voiceArea.style.zIndex = "2";
    videoBtn.style.display = "";
  } else {
    videoArea.classList.add("hidden");
    voiceArea.style.position = "";
    videoBtn.style.display = "none";
  }

  // Set remote avatar + name
  const av = document.getElementById("call-remote-avatar");
  const nm = document.getElementById("call-remote-name");
  renderAvatar(av, profile);
  nm.textContent = profile ? profile.username : "...";
  setCallStatus(statusText);
  document.getElementById("call-timer").textContent = "00:00";
}

function hideActiveCallUI() {
  document.getElementById("active-call-overlay").classList.add("hidden");
  document.getElementById("active-call-overlay").classList.remove("connected");
}

function setCallStatus(text) {
  document.getElementById("call-status-text").textContent = text;
}

// ══════════════════════════════════════════════════════════════
//  Timer
// ══════════════════════════════════════════════════════════════
function startTimer() {
  stopTimer();
  _timerSec = 0;
  _timerInterval = setInterval(() => {
    _timerSec++;
    const m = String(Math.floor(_timerSec / 60)).padStart(2, "0");
    const s = String(_timerSec % 60).padStart(2, "0");
    const el = document.getElementById("call-timer");
    if (el) el.textContent = m + ":" + s;
  }, 1000);
}

function stopTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
}

// ══════════════════════════════════════════════════════════════
//  Ringtone (generated via Web Audio — no audio file needed)
// ══════════════════════════════════════════════════════════════
let _audioCtx    = null;
let _ringtoneLoop = null;

function playRingtone(isCaller) {
  stopRingtone();
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let playing = true;

    const ring = () => {
      if (!playing || !_audioCtx) return;
      const osc  = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.type = "sine";

      if (isCaller) {
        // Outgoing: two-tone ringback
        osc.frequency.setValueAtTime(440, _audioCtx.currentTime);
        osc.frequency.setValueAtTime(480, _audioCtx.currentTime + 0.5);
        gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
        gain.gain.setValueAtTime(0,    _audioCtx.currentTime + 1);
        osc.start(); osc.stop(_audioCtx.currentTime + 1.1);
        _ringtoneLoop = setTimeout(ring, 3000);
      } else {
        // Incoming: higher pitch, more urgent
        osc.frequency.setValueAtTime(587, _audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2,  _audioCtx.currentTime);
        gain.gain.setValueAtTime(0,    _audioCtx.currentTime + 0.3);
        osc.start(); osc.stop(_audioCtx.currentTime + 0.35);
        _ringtoneLoop = setTimeout(ring, 600);
      }
    };
    ring();
    _ringtoneLoop._stop = () => { playing = false; };
  } catch(e) {
    console.warn("Ringtone error:", e);
  }
}

function stopRingtone() {
  if (_ringtoneLoop) {
    clearTimeout(_ringtoneLoop);
    if (_ringtoneLoop._stop) _ringtoneLoop._stop();
    _ringtoneLoop = null;
  }
  if (_audioCtx) {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
}

// ══════════════════════════════════════════════════════════════
//  Boot — triggered by auth.js after login via initCalling()
// ══════════════════════════════════════════════════════════════
// auth.js calls initCalling() at the same time as initFriends()
// See auth.js onAuthStateChanged block.
