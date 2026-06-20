// channels.js — channel list, create, delete, select

// Module-level ref so we detach it independently of the message listener
let _channelsRef = null;

// ── Create channel modal ──────────────────────────────────────────────
document.getElementById("create-channel-btn").addEventListener("click", async () => {
  if (!AppState.activeServer) { showToast("Select a server first.", "error"); return; }
  const myUid = AppState.currentUser.uid;
  const role  = (await db.ref("serverMembers/" + AppState.activeServer.id + "/" + myUid).get()).val();
  if (!["owner","admin","moderator"].includes(role)) {
    showToast("You don't have permission to create channels.", "error"); return;
  }
  openModal("channel-modal");
});

document.getElementById("create-channel-confirm-btn").addEventListener("click", async () => {
  const raw   = document.getElementById("channel-name-input").value.trim();
  const name  = raw.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
  const type  = document.querySelector("input[name='ch-type']:checked").value;
  const errEl = document.getElementById("channel-modal-error");
  errEl.textContent = "";
  if (!name) { errEl.textContent = "Please enter a channel name."; return; }

  const { id } = AppState.activeServer;
  const ref = db.ref("channels/" + id).push();
  await ref.set({ name, type, createdAt: Date.now() });

  closeModal("channel-modal");
  document.getElementById("channel-name-input").value = "";
  showToast("#" + name + " created!", "success");
});

// ── Load channels (live) ──────────────────────────────────────────────
function loadChannels(sid) {
  // Detach any previous channel listener
  if (_channelsRef) _channelsRef.off();
  _channelsRef = db.ref("channels/" + sid);

  _channelsRef.on("value", snap => {
    const textList  = document.getElementById("channel-list");
    const voiceList = document.getElementById("voice-channel-list");
    textList.innerHTML  = "";
    voiceList.innerHTML = "";
    if (!snap.exists()) return;

    Object.entries(snap.val()).forEach(([cid, channel]) => {
      const item = buildChannelItem(sid, cid, channel);
      if (channel.type === "voice") voiceList.appendChild(item);
      else                          textList.appendChild(item);
    });
  });
}

function buildChannelItem(sid, cid, channel) {
  const wrap = document.createElement("div");
  wrap.className = "channel-item-wrap";
  wrap.dataset.cid = cid;

  const item = document.createElement("div");
  item.className = "channel-item";
  item.dataset.cid = cid;

  const prefix = document.createElement("span");
  prefix.className = "ch-prefix";
  prefix.textContent = channel.type === "voice" ? "🔊" : "#";

  const nameEl = document.createElement("span");
  nameEl.className = "ch-name";
  nameEl.textContent = channel.name;

  // Unread badge (populated by notifications.js)
  const badge = document.createElement("span");
  badge.className = "dm-unread hidden";
  badge.id = "ch-badge-" + cid;

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn ch-delete danger";
  delBtn.title = "Delete Channel";
  delBtn.innerHTML = "✕";
  delBtn.style.cssText = "font-size:11px;width:20px;height:20px;";
  delBtn.addEventListener("click", async e => {
    e.stopPropagation();
    if (!confirm("Delete #" + channel.name + "?")) return;
    await deleteChannel(sid, cid, channel.name);
  });

  item.appendChild(prefix);
  item.appendChild(nameEl);
  item.appendChild(badge);
  item.appendChild(delBtn);
  wrap.appendChild(item);

  if (channel.type === "voice") {
    item.classList.add("voice-ch");
    item.addEventListener("click", () => joinVoiceChannel(sid, cid, channel));

    // Live participant avatars under the channel name
    const participantsRow = document.createElement("div");
    participantsRow.className = "voice-participants";
    participantsRow.id = "voice-participants-" + cid;
    wrap.appendChild(participantsRow);

    // Listen for participant presence on this channel
    listenVoiceChannelPresence(sid, cid);
  } else {
    item.addEventListener("click", () => selectChannel(sid, cid, channel));
  }

  // Keep active highlight in sync
  if (AppState.activeChannel && AppState.activeChannel.id === cid) {
    item.classList.add("active");
  }
  return wrap;
}

async function deleteChannel(sid, cid, name) {
  const myUid = AppState.currentUser.uid;
  const role  = (await db.ref("serverMembers/" + sid + "/" + myUid).get()).val();
  if (!["owner","admin","moderator"].includes(role)) {
    showToast("No permission.", "error"); return;
  }
  await db.ref().update({
    ["channels/" + sid + "/" + cid]: null,
    ["messages/" + sid + "/" + cid]: null,
    ["typing/"   + sid + "/" + cid]: null,
  });
  if (AppState.activeChannel && AppState.activeChannel.id === cid) {
    AppState.activeChannel = null;
    document.getElementById("chat-view").classList.remove("active");
  }
  showToast("#" + name + " deleted.");
}

// ── Voice channel participant presence row ────────────────────────────
const _voicePresenceRefs = {};

function listenVoiceChannelPresence(sid, cid) {
  // Avoid duplicate listeners if re-rendered
  if (_voicePresenceRefs[cid]) _voicePresenceRefs[cid].off();
  const ref = db.ref("voiceChannels/" + sid + "/" + cid + "/participants");
  _voicePresenceRefs[cid] = ref;

  ref.on("value", async snap => {
    const row = document.getElementById("voice-participants-" + cid);
    if (!row) return;
    row.innerHTML = "";
    if (!snap.exists()) return;

    const uids = Object.keys(snap.val());
    for (const uid of uids) {
      const profile = await fetchProfile(uid);
      if (!profile) continue;
      const av = document.createElement("div");
      av.className = "voice-participant-avatar";
      av.title = profile.username;
      renderAvatar(av, profile);
      if (typeof isUidSpeaking === "function" && isUidSpeaking(uid)) {
        av.classList.add("speaking");
      }
      row.appendChild(av);
    }
  });
}

// ── Select a channel ──────────────────────────────────────────────────
function selectChannel(sid, cid, channel) {
  AppState.activeChannel = { id: cid, data: channel };
  AppState.activeDM      = null;

  document.querySelectorAll(".channel-item").forEach(el =>
    el.classList.toggle("active", el.dataset.cid === cid));

  document.getElementById("chat-channel-name").textContent = channel.name;
  document.querySelector(".channel-hash").textContent = "#";
  document.getElementById("message-input").placeholder = "Message #" + channel.name;

  document.getElementById("welcome-view").classList.remove("active");
  document.getElementById("chat-view").classList.add("active");
  document.getElementById("member-sidebar").style.display = "";

  // Clear unread badge for this channel
  clearChannelUnread(cid);

  // Load messages via chat.js
  loadMessages("server");
}
