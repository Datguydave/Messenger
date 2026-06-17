// channels.js — channel list, create, delete, select

// ── Open create channel modal ─────────────────────────────────────────
document.getElementById("create-channel-btn").addEventListener("click", async () => {
  if (!AppState.activeServer) { showToast("Select a server first.", "error"); return; }

  // Only owner/admin/mod can create channels
  const { id } = AppState.activeServer;
  const myUid  = AppState.currentUser.uid;
  const role   = (await db.ref(`serverMembers/${id}/${myUid}`).get()).val();
  if (!["owner","admin","moderator"].includes(role)) {
    showToast("You don't have permission to create channels.", "error"); return;
  }
  openModal("channel-modal");
});

document.getElementById("create-channel-confirm-btn").addEventListener("click", async () => {
  const name  = document.getElementById("channel-name-input").value.trim().toLowerCase().replace(/\s+/g, "-");
  const type  = document.querySelector('input[name="ch-type"]:checked').value;
  const errEl = document.getElementById("channel-modal-error");
  errEl.textContent = "";

  if (!name) { errEl.textContent = "Please enter a channel name."; return; }
  if (!/^[a-z0-9\-]+$/.test(name)) { errEl.textContent = "Only lowercase letters, numbers, and hyphens."; return; }

  const { id } = AppState.activeServer;
  const ref = db.ref(`channels/${id}`).push();
  await ref.set({ name, type, createdAt: Date.now() });

  closeModal("channel-modal");
  document.getElementById("channel-name-input").value = "";
  showToast(`#${name} created!`, "success");
});

// ── Load channels for a server ────────────────────────────────────────
function loadChannels(sid) {
  // Detach previous listener if any
  const off = () => db.ref(`channels/${sid}`).off();
  AppState.registerListener(off);

  db.ref(`channels/${sid}`).on("value", snap => {
    const textList  = document.getElementById("channel-list");
    const voiceList = document.getElementById("voice-channel-list");
    textList.innerHTML  = "";
    voiceList.innerHTML = "";

    if (!snap.exists()) return;

    const channels = snap.val();
    for (const [cid, channel] of Object.entries(channels)) {
      const item = buildChannelItem(sid, cid, channel);
      if (channel.type === "voice") voiceList.appendChild(item);
      else                          textList.appendChild(item);
    }
  });
}

function buildChannelItem(sid, cid, channel) {
  const item = document.createElement("div");
  item.className = "channel-item";
  item.dataset.cid = cid;

  const prefix = document.createElement("span");
  prefix.className = "ch-prefix";
  prefix.textContent = channel.type === "voice" ? "🔊" : "#";

  const name = document.createElement("span");
  name.className = "ch-name";
  name.textContent = channel.name;

  item.appendChild(prefix);
  item.appendChild(name);

  // Unread badge
  const badge = document.createElement("span");
  badge.className = "dm-unread hidden";
  badge.id = `ch-badge-${cid}`;
  item.appendChild(badge);

  // Delete button (shown on hover for authorised users)
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn ch-delete danger";
  delBtn.title = "Delete Channel";
  delBtn.innerHTML = "✕";
  delBtn.style.cssText = "font-size:12px;width:22px;height:22px;";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete #${channel.name}?`)) return;
    await deleteChannel(sid, cid);
  });
  item.appendChild(delBtn);

  if (channel.type === "voice") {
    item.addEventListener("click", () => showToast("Voice channels coming soon! 🔊"));
  } else {
    item.addEventListener("click", () => selectChannel(sid, cid, channel));
  }

  // Highlight if active
  if (AppState.activeChannel && AppState.activeChannel.id === cid) {
    item.classList.add("active");
  }

  return item;
}

async function deleteChannel(sid, cid) {
  const myUid = AppState.currentUser.uid;
  const role  = (await db.ref(`serverMembers/${sid}/${myUid}`).get()).val();
  if (!["owner","admin","moderator"].includes(role)) {
    showToast("No permission.", "error"); return;
  }

  const updates = {};
  updates[`channels/${sid}/${cid}`] = null;
  updates[`messages/${sid}/${cid}`] = null;
  updates[`typing/${sid}/${cid}`]   = null;
  await db.ref().update(updates);

  if (AppState.activeChannel && AppState.activeChannel.id === cid) {
    document.getElementById("chat-view").classList.remove("active");
    document.getElementById("welcome-view").classList.remove("active");
    AppState.activeChannel = null;
  }
  showToast("Channel deleted.");
}

// ── Select a channel ──────────────────────────────────────────────────
function selectChannel(sid, cid, channel) {
  AppState.activeChannel = { id: cid, data: channel };
  AppState.activeDM      = null;

  // Highlight
  document.querySelectorAll(".channel-item").forEach(el => {
    el.classList.toggle("active", el.dataset.cid === cid);
  });

  // Chat header
  document.getElementById("chat-channel-name").textContent = channel.name;
  document.querySelector(".channel-hash").textContent = "#";
  document.getElementById("message-input").placeholder = `Message #${channel.name}`;

  // Show chat
  document.getElementById("welcome-view").classList.remove("active");
  document.getElementById("chat-view").classList.add("active");

  // Member sidebar
  document.getElementById("member-sidebar").style.display = "";

  // Load messages
  loadMessages("server");
}
