// voicecalls.js — group voice/video for server voice channels
//
// Signalling paths (no orderByChild queries — direct paths only):
//
//   voiceChannels/<sid>/<cid>/participants/<uid>     → presence
//   voiceSignals/<sid>/<cid>/offers/<toUid>/<fromUid>  → SDP offer string
//   voiceSignals/<sid>/<cid>/answers/<toUid>/<fromUid> → SDP answer string
//   voiceSignals/<sid>/<cid>/ice/<fromUid>/<toUid>/<push> → ICE candidate

const VOICE_ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80",  username:"openrelayproject", credential:"openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username:"openrelayproject", credential:"openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username:"openrelayproject", credential:"openrelayproject" },
]};

// ── state ─────────────────────────────────────────────────────
const vc = {
  sid: null, cid: null, type: "voice",
  stream: null,           // my local MediaStream
  peers: {},              // theirUid → RTCPeerConnection
  iceBuf: {},             // theirUid → RTCIceCandidate[] (before remoteDesc)
  audioEls: {},           // theirUid → <audio>
  offs: [],               // cleanup fns
  myRef: null,
  muted: false, cam: true, deafened: false,
  speaking: new Set(),
  analysers: {}, actx: null,
};

function S() { return "voiceSignals/" + vc.sid + "/" + vc.cid; }

function isUidSpeaking(uid) { return vc.speaking.has(uid); }

// ══════════════════════════════════════════════════════════════
//  JOIN
// ══════════════════════════════════════════════════════════════
async function joinVoiceChannel(sid, cid, channel) {
  if (vc.sid === sid && vc.cid === cid) { showVoiceBar(); return; }
  if (vc.sid) await leaveVoiceChannel(false);

  const wantsVideo = await askJoinType();
  if (wantsVideo === null) return;

  vc.sid = sid; vc.cid = cid; vc.type = wantsVideo ? "video" : "voice";
  const myUid = AppState.currentUser.uid;

  // 1. Get local media
  try {
    vc.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
      video: wantsVideo ? { width:640, height:360, frameRate:24 } : false,
    });
  } catch(e) {
    showToast("Cannot access mic/camera. Allow permission in your browser.", "error");
    vc.sid = null; vc.cid = null; return;
  }

  startDetect(myUid, vc.stream);

  // 2. Write presence
  const presRef = db.ref("voiceChannels/"+sid+"/"+cid+"/participants");
  vc.myRef = presRef.child(myUid);
  await vc.myRef.set({ username: AppState.userProfile.username, avatar: AppState.userProfile.avatar||"", joinedAt: Date.now() });
  vc.myRef.onDisconnect().remove();

  // 3. Build UI
  buildVoiceBar(channel.name);
  addTile(myUid, AppState.userProfile, vc.stream, true);

  // 4. Connect to everyone already in the channel (I send offer)
  const snap = await presRef.get();
  if (snap.exists()) {
    const promises = [];
    snap.forEach(ch => { if (ch.key !== myUid) promises.push(callPeer(ch.key, ch.val())); });
    await Promise.all(promises);
  }

  // 5. Watch for new joiners (they'll send me an offer — I just add their tile)
  const presAdd = presRef.on("child_added", snap => {
    if (snap.key === myUid || vc.peers[snap.key]) return;
    addTile(snap.key, snap.val(), null, false);
  });
  const presRem = presRef.on("child_removed", snap => teardown(snap.key));
  vc.offs.push(() => { presRef.off("child_added", presAdd); presRef.off("child_removed", presRem); });

  // 6. Watch for incoming OFFERS to me
  const offerRef = db.ref(S()+"/offers/"+myUid);
  const offerCb = offerRef.on("child_added", async snap => {
    const fromUid = snap.key;
    const offerSdp = snap.val();
    if (!offerSdp || vc.peers[fromUid]) return;
    console.log("[VC] offer from", fromUid);

    const theirData = (await db.ref("voiceChannels/"+sid+"/"+cid+"/participants/"+fromUid).get()).val() || {};
    const pc = makePeer(fromUid, theirData);

    try {
      await pc.setRemoteDescription({ type:"offer", sdp:offerSdp });
      await flushIce(fromUid, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await db.ref(S()+"/answers/"+fromUid+"/"+myUid).set(answer.sdp);
      console.log("[VC] answer sent to", fromUid);
    } catch(e) { console.error("[VC] offer handling:", e); }
  });
  vc.offs.push(() => offerRef.off("child_added", offerCb));

  // 7. Watch for incoming ICE addressed to me (from any sender)
  //    Path: voiceSignals/<sid>/<cid>/ice/<SENDER>/<MY_UID>/<push>
  //    We watch each sender's sub-path as they join.
  //    For senders we already know, watch now:
  function watchIceFrom(fromUid) {
    const iceRef = db.ref(S()+"/ice/"+fromUid+"/"+myUid);
    const iceCb = iceRef.on("child_added", async snap => {
      const c = snap.val();
      const pc = vc.peers[fromUid];
      if (!pc) { if (!vc.iceBuf[fromUid]) vc.iceBuf[fromUid]=[]; vc.iceBuf[fromUid].push(c); return; }
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
      } else {
        if (!vc.iceBuf[fromUid]) vc.iceBuf[fromUid] = [];
        vc.iceBuf[fromUid].push(c);
      }
    });
    vc.offs.push(() => iceRef.off("child_added", iceCb));
  }

  // Watch ICE from current participants
  if (snap.exists()) snap.forEach(ch => { if (ch.key !== myUid) watchIceFrom(ch.key); });

  // Also watch for ICE from new joiners (who send offers to us)
  const iceRootRef = db.ref(S()+"/ice");
  const iceRootCb = iceRootRef.on("child_added", snap => {
    const fromUid = snap.key;
    if (fromUid === myUid) return;
    watchIceFrom(fromUid);
  });
  vc.offs.push(() => iceRootRef.off("child_added", iceRootCb));

  showToast("Joined #"+channel.name, "success");
}

// ══════════════════════════════════════════════════════════════
//  Call a peer (I am caller — I send offer, wait for answer)
// ══════════════════════════════════════════════════════════════
async function callPeer(theirUid, theirData) {
  const myUid = AppState.currentUser.uid;
  console.log("[VC] calling", theirUid);

  const pc = makePeer(theirUid, theirData);
  addTile(theirUid, theirData, null, false);

  // Create and send offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await db.ref(S()+"/offers/"+theirUid+"/"+myUid).set(offer.sdp);
  console.log("[VC] offer written for", theirUid);

  // Watch for answer
  const ansRef = db.ref(S()+"/answers/"+myUid+"/"+theirUid);
  const ansCb = ansRef.on("value", async snap => {
    if (!snap.exists()) return;
    if (pc.signalingState !== "have-local-offer") return;
    console.log("[VC] answer from", theirUid);
    try {
      await pc.setRemoteDescription({ type:"answer", sdp:snap.val() });
      await flushIce(theirUid, pc);
      console.log("[VC] connection established with", theirUid);
    } catch(e) { console.error("[VC] answer error:", e); }
  });
  vc.offs.push(() => ansRef.off("value", ansCb));
}

// ══════════════════════════════════════════════════════════════
//  Create RTCPeerConnection
// ══════════════════════════════════════════════════════════════
function makePeer(theirUid, theirData) {
  const myUid = AppState.currentUser.uid;
  const pc = new RTCPeerConnection(VOICE_ICE);
  vc.peers[theirUid] = pc;

  // Add local tracks
  vc.stream.getTracks().forEach(t => { pc.addTrack(t, vc.stream); });

  // Send my ICE candidates to Firebase
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    db.ref(S()+"/ice/"+myUid+"/"+theirUid).push(e.candidate.toJSON());
  };

  // Logging
  pc.oniceconnectionstatechange = () => console.log("[VC] ICE", theirUid, pc.iceConnectionState);
  pc.onconnectionstatechange    = () => {
    console.log("[VC] conn", theirUid, pc.connectionState);
    if (pc.connectionState === "failed") { pc.restartIce(); }
    if (pc.connectionState === "connected") {
      showToast((theirData.username||"Someone")+" connected", "success");
    }
  };

  // Receive remote tracks
  pc.ontrack = e => {
    console.log("[VC] track from", theirUid, e.track.kind, "streams:", e.streams.length);
    if (!e.streams || !e.streams[0]) return;
    attachStream(theirUid, theirData, e.streams[0]);
  };

  return pc;
}

// Flush buffered ICE candidates after remote description is set
async function flushIce(uid, pc) {
  for (const c of (vc.iceBuf[uid]||[])) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
  }
  vc.iceBuf[uid] = [];
}

function teardown(uid) {
  if (vc.peers[uid]) { vc.peers[uid].close(); delete vc.peers[uid]; }
  delete vc.iceBuf[uid];
  if (vc.audioEls[uid]) { vc.audioEls[uid].srcObject=null; vc.audioEls[uid].remove(); delete vc.audioEls[uid]; }
  delete vc.analysers[uid];
  vc.speaking.delete(uid);
  const tile = document.getElementById("vc-tile-"+uid);
  if (tile) tile.remove();
}

// ══════════════════════════════════════════════════════════════
//  Attach remote audio/video
// ══════════════════════════════════════════════════════════════
function attachStream(uid, theirData, stream) {
  console.log("[VC] attaching stream for", uid, stream.getTracks().map(t=>t.kind));

  // Audio — always use a dedicated <audio> element
  let aud = vc.audioEls[uid];
  if (!aud) {
    aud = document.createElement("audio");
    aud.id = "vc-aud-"+uid;
    aud.autoplay = true;
    aud.style.display = "none";
    document.body.appendChild(aud);
    vc.audioEls[uid] = aud;
  }
  aud.srcObject = stream;
  aud.muted = vc.deafened;
  aud.play().catch(e => console.warn("[VC] audio play:", e));

  startDetect(uid, stream);

  // Video — update tile
  const hasVideo = stream.getVideoTracks().length > 0;
  const tile = document.getElementById("vc-tile-"+uid);
  if (tile) {
    if (hasVideo) {
      const existing = tile.querySelector("video");
      if (!existing) {
        const vid = document.createElement("video");
        vid.autoplay=true; vid.playsInline=true;
        vid.srcObject = stream;
        vid.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;";
        // Remove avatar if present
        const av = tile.querySelector(".vc-tile-av");
        if (av) av.remove();
        tile.insertBefore(vid, tile.firstChild);
      } else {
        existing.srcObject = stream;
      }
    }
  } else {
    // Tile doesn't exist yet — create it
    addTile(uid, theirData, stream, false);
  }
}

// ══════════════════════════════════════════════════════════════
//  Speaking detection
// ══════════════════════════════════════════════════════════════
function startDetect(uid, stream) {
  try {
    if (!vc.actx) vc.actx = new (window.AudioContext||window.webkitAudioContext)();
    const src = vc.actx.createMediaStreamSource(stream);
    const an  = vc.actx.createAnalyser(); an.fftSize=256;
    src.connect(an);
    vc.analysers[uid] = an;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!vc.analysers[uid]) return;
      an.getByteFrequencyData(buf);
      const avg = buf.slice(1,10).reduce((a,b)=>a+b,0)/9;
      const s = avg > 12;
      if (s) vc.speaking.add(uid); else vc.speaking.delete(uid);
      const tile = document.getElementById("vc-tile-"+uid);
      if (tile) tile.classList.toggle("speaking", s);
      requestAnimationFrame(tick);
    };
    tick();
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
//  LEAVE
// ══════════════════════════════════════════════════════════════
async function leaveVoiceChannel(toast=true) {
  if (!vc.sid) return;
  const sid=vc.sid, cid=vc.cid, myUid=AppState.currentUser&&AppState.currentUser.uid;

  vc.offs.forEach(f=>{ try{f();}catch(e){} }); vc.offs=[];

  if (vc.myRef) { vc.myRef.onDisconnect().cancel(); await vc.myRef.remove().catch(()=>{}); }

  // Clean up signals
  if (sid&&cid&&myUid) {
    const base = "voiceSignals/"+sid+"/"+cid;
    ["offers/"+myUid, "answers/"+myUid, "ice/"+myUid].forEach(p => db.ref(base+"/"+p).remove().catch(()=>{}));
  }

  Object.keys(vc.peers).forEach(uid=>teardown(uid));
  vc.peers={}; vc.iceBuf={};

  if (vc.stream) { vc.stream.getTracks().forEach(t=>t.stop()); vc.stream=null; }
  if (vc.actx)   { vc.actx.close().catch(()=>{}); vc.actx=null; }
  vc.analysers={}; vc.speaking.clear();

  destroyVoiceBar();
  vc.sid=null; vc.cid=null;
  vc.muted=false; vc.cam=true; vc.deafened=false;

  if (toast) showToast("Left voice channel.");
}

// ══════════════════════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════════════════════
function buildVoiceBar(channelName) {
  destroyVoiceBar();
  const bar = document.createElement("div");
  bar.id="vc-bar"; bar.className="vc-bar";
  bar.innerHTML=
    "<div class='vc-bar-left'>"+
      "<span class='vc-bar-icon'>🔊</span>"+
      "<span class='vc-bar-status'>Voice Connected</span>"+
      "<span class='vc-bar-channel'>"+escapeHtml(channelName||"")+"</span>"+
    "</div>"+
    "<div class='vc-tiles' id='vc-tiles'></div>"+
    "<div class='vc-bar-controls'>"+
      "<button class='vc-ctrl' id='vc-mute' title='Mute'><svg viewBox='0 0 24 24' fill='currentColor'><path d='M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z'/></svg></button>"+
      "<button class='vc-ctrl' id='vc-deaf' title='Deafen'><svg viewBox='0 0 24 24' fill='currentColor'><path d='M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z'/></svg></button>"+
      "<button class='vc-ctrl' id='vc-cam' title='Camera' "+(vc.type==="video"?"":"style='display:none'")+"><svg viewBox='0 0 24 24' fill='currentColor'><path d='M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z'/></svg></button>"+
      "<button class='vc-ctrl vc-ctrl-leave' id='vc-leave' title='Leave'><svg viewBox='0 0 24 24' fill='currentColor'><path d='M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z'/></svg></button>"+
    "</div>";
  document.getElementById("chat-main").insertBefore(bar, document.getElementById("chat-main").firstChild);
  document.getElementById("vc-mute").onclick  = vcMute;
  document.getElementById("vc-deaf").onclick  = vcDeafen;
  document.getElementById("vc-cam").onclick   = vcCam;
  document.getElementById("vc-leave").onclick = ()=>leaveVoiceChannel(true);
}

function showVoiceBar()    { const b=document.getElementById("vc-bar"); if(b) b.style.display=""; }
function destroyVoiceBar() { const b=document.getElementById("vc-bar"); if(b) b.remove(); }

function addTile(uid, profile, stream, isSelf) {
  const g=document.getElementById("vc-tiles");
  if (!g||document.getElementById("vc-tile-"+uid)) return;

  const t=document.createElement("div");
  t.className="vc-tile"; t.id="vc-tile-"+uid;

  const hasVideo = stream && stream.getVideoTracks().length>0;
  if (hasVideo) {
    const vid=document.createElement("video");
    vid.autoplay=true; vid.playsInline=true; if(isSelf) vid.muted=true;
    vid.srcObject=stream;
    vid.style.cssText="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;";
    t.appendChild(vid);
  } else {
    const av=document.createElement("div"); av.className="vc-tile-av";
    renderAvatar(av, profile); t.appendChild(av);
  }

  const lbl=document.createElement("div"); lbl.className="vc-tile-label";
  lbl.textContent=(profile.username||"User")+(isSelf?" (you)":""); t.appendChild(lbl);

  const mic=document.createElement("div"); mic.className="vc-tile-mic"; mic.id="vc-mic-"+uid;
  mic.innerHTML="🔇"; mic.style.display="none"; t.appendChild(mic);

  g.appendChild(t);
}

function vcMute() {
  if (!vc.stream) return;
  vc.muted=!vc.muted;
  vc.stream.getAudioTracks().forEach(t=>{t.enabled=!vc.muted;});
  const b=document.getElementById("vc-mute"); if(b){b.classList.toggle("active",vc.muted);b.title=vc.muted?"Unmute":"Mute";}
  const m=document.getElementById("vc-mic-"+(AppState.currentUser&&AppState.currentUser.uid)); if(m) m.style.display=vc.muted?"":"none";
}
function vcDeafen() {
  vc.deafened=!vc.deafened;
  Object.values(vc.audioEls).forEach(e=>{e.muted=vc.deafened;});
  const b=document.getElementById("vc-deaf"); if(b) b.classList.toggle("active",vc.deafened);
  if(vc.deafened&&!vc.muted) vcMute();
}
function vcCam() {
  if (!vc.stream) return;
  vc.cam=!vc.cam;
  vc.stream.getVideoTracks().forEach(t=>{t.enabled=vc.cam;});
  const b=document.getElementById("vc-cam"); if(b) b.classList.toggle("active",!vc.cam);
}

// ══════════════════════════════════════════════════════════════
//  Join type dialog
// ══════════════════════════════════════════════════════════════
function askJoinType() {
  return new Promise(resolve => {
    const ov=document.createElement("div"); ov.className="modal-overlay";
    ov.innerHTML="<div class='modal modal-sm' style='text-align:center'>"+
      "<h3 style='margin-bottom:6px'>Join Voice Channel</h3>"+
      "<p style='color:var(--text-muted);font-size:13px;margin-bottom:18px'>How do you want to join?</p>"+
      "<div style='display:flex;flex-direction:column;gap:10px'>"+
      "<button class='btn-primary full-width' id='jv-v'>🎙️ Voice Only</button>"+
      "<button class='btn-secondary full-width' id='jv-vid'>📹 Voice + Video</button>"+
      "<button class='btn-secondary full-width' id='jv-c' style='opacity:.6'>Cancel</button>"+
      "</div></div>";
    document.body.appendChild(ov);
    ov.querySelector("#jv-v").onclick   = ()=>{ov.remove();resolve(false);};
    ov.querySelector("#jv-vid").onclick = ()=>{ov.remove();resolve(true);};
    ov.querySelector("#jv-c").onclick   = ()=>{ov.remove();resolve(null);};
  });
}

window.addEventListener("beforeunload", ()=>{
  if (vc.myRef) vc.myRef.remove();
});
