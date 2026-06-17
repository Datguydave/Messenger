// servers.js — server CRUD, member management, rail icons

// ── Open server modal ─────────────────────────────────────────────────
document.getElementById("add-server-btn").addEventListener("click", () => openModal("server-modal"));

// Server icon file label
document.getElementById("server-icon-input").addEventListener("change", function() {
  document.getElementById("server-icon-name").textContent =
    this.files[0] ? this.files[0].name : "No file chosen";
});

// ── Create server ─────────────────────────────────────────────────────
document.getElementById("create-server-btn").addEventListener("click", async () => {
  const name     = document.getElementById("server-name-input").value.trim();
  const iconFile = document.getElementById("server-icon-input").files[0];
  const errEl    = document.getElementById("create-server-error");
  errEl.textContent = "";

  if (!name) { errEl.textContent = "Please enter a server name."; return; }

  const myUid    = AppState.currentUser.uid;
  const serverRef = db.ref("servers").push();
  const serverId  = serverRef.key;

  let iconUrl = "";
  if (iconFile) {
    try { iconUrl = await uploadServerIcon(iconFile, serverId); }
    catch(e) { console.warn("Icon upload failed", e); }
  }

  const serverData = {
    name, icon: iconUrl,
    owner: myUid,
    createdAt: Date.now(),
  };

  const updates = {};
  updates[`servers/${serverId}`] = serverData;
  updates[`serverMembers/${serverId}/${myUid}`] = "owner";
  updates[`userServers/${myUid}/${serverId}`]   = true;

  await db.ref().update(updates);

  // Create default channels
  const genRef  = db.ref(`channels/${serverId}`).push();
  await db.ref(`channels/${serverId}/${genRef.key}`).set({ name: "general",       type: "text" });
  const annRef  = db.ref(`channels/${serverId}`).push();
  await db.ref(`channels/${serverId}/${annRef.key}`).set({ name: "announcements", type: "text" });

  closeModal("server-modal");
  document.getElementById("server-name-input").value = "";
  document.getElementById("server-icon-input").value = "";
  document.getElementById("server-icon-name").textContent = "No file chosen";

  showToast(`${name} created!`, "success");
  selectServer(serverId, serverData);
});

// ── Join server ───────────────────────────────────────────────────────
document.getElementById("join-server-btn").addEventListener("click", async () => {
  const sid   = document.getElementById("join-server-id-input").value.trim();
  const errEl = document.getElementById("join-server-error");
  errEl.textContent = "";
  if (!sid) { errEl.textContent = "Please enter a server ID."; return; }

  const snap = await db.ref(`servers/${sid}`).get();
  if (!snap.exists()) { errEl.textContent = "Server not found."; return; }

  const myUid = AppState.currentUser.uid;
  const alreadyMember = (await db.ref(`serverMembers/${sid}/${myUid}`).get()).exists();
  if (alreadyMember) { errEl.textContent = "You are already a member!"; return; }

  await db.ref(`serverMembers/${sid}/${myUid}`).set("member");
  await db.ref(`userServers/${myUid}/${sid}`).set(true);

  closeModal("server-modal");
  document.getElementById("join-server-id-input").value = "";
  showToast("Joined server!", "success");
  selectServer(sid, snap.val());
});

// ── Load servers for current user ─────────────────────────────────────
function initServers() {
  const myUid = AppState.currentUser.uid;
  db.ref(`userServers/${myUid}`).on("value", async snap => {
    const list = document.getElementById("server-icons-list");
    list.innerHTML = "";
    if (!snap.exists()) return;

    for (const sid of Object.keys(snap.val())) {
      const sSnap = await db.ref(`servers/${sid}`).get();
      if (!sSnap.exists()) continue;
      const server = sSnap.val();
      const icon = buildServerRailIcon(sid, server);
      list.appendChild(icon);
    }
  });
}

function buildServerRailIcon(sid, server) {
  const div = document.createElement("div");
  div.className = "rail-icon";
  div.title = server.name;
  div.dataset.sid = sid;

  if (server.icon) {
    const img = document.createElement("img");
    img.src = server.icon;
    img.alt = server.name;
    div.appendChild(img);
  } else {
    div.textContent = server.name.charAt(0).toUpperCase();
    div.style.background = stringToColor(server.name);
    div.style.color = "#fff";
    div.style.fontWeight = "700";
    div.style.fontSize = "18px";
  }

  // Notification badge (live unread count)
  const badge = document.createElement("span");
  badge.className = "notif-badge hidden";
  badge.id = `rail-badge-${sid}`;
  div.appendChild(badge);

  div.addEventListener("click", () => selectServer(sid, server));

  // Live server name updates
  db.ref(`servers/${sid}/name`).on("value", snap => {
    if (snap.exists() && !server.icon) div.textContent = snap.val().charAt(0).toUpperCase();
    div.title = snap.val() || server.name;
    badge && div.appendChild(badge);
  });

  return div;
}

// ── Select / activate a server ────────────────────────────────────────
async function selectServer(sid, serverData) {
  AppState.activeServer  = { id: sid, data: serverData };
  AppState.activeChannel = null;
  AppState.activeDM      = null;
  AppState.clearListeners();

  // Rail highlight
  document.querySelectorAll(".rail-icon").forEach(el => el.classList.remove("active"));
  const railIcon = document.querySelector(`[data-sid="${sid}"]`);
  if (railIcon) railIcon.classList.add("active");

  // Switch panels
  document.getElementById("dm-panel").classList.remove("active");
  document.getElementById("server-panel").classList.add("active");

  // Server header
  document.getElementById("server-name-label").textContent = serverData.name;

  // Member sidebar
  document.getElementById("member-sidebar").style.display = "";

  // Load channels
  loadChannels(sid);

  // Load members
  loadMembers(sid);

  // Hide chat until a channel is chosen
  document.getElementById("chat-view").classList.remove("active");
  document.getElementById("welcome-view").classList.remove("active");
}

// ── Server Settings ───────────────────────────────────────────────────
document.getElementById("server-settings-btn").addEventListener("click", openServerSettings);

async function openServerSettings() {
  const { id, data } = AppState.activeServer;
  const myUid = AppState.currentUser.uid;
  const isOwner = data.owner === myUid;

  document.getElementById("ss-name-input").value = data.name;
  document.getElementById("ss-id-display").value = id;

  const deleteBtn = document.getElementById("ss-delete-btn");
  deleteBtn.classList.toggle("hidden", !isOwner);

  openModal("server-settings-modal");
}

document.getElementById("copy-server-id-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("ss-id-display").value);
  showToast("Server ID copied!", "success");
});

document.getElementById("ss-save-btn").addEventListener("click", async () => {
  const { id } = AppState.activeServer;
  const myUid  = AppState.currentUser.uid;
  const role   = (await db.ref(`serverMembers/${id}/${myUid}`).get()).val();
  if (!["owner","admin"].includes(role)) { showToast("No permission.", "error"); return; }

  const newName = document.getElementById("ss-name-input").value.trim();
  if (!newName) return;
  await db.ref(`servers/${id}/name`).set(newName);
  AppState.activeServer.data.name = newName;
  document.getElementById("server-name-label").textContent = newName;
  closeModal("server-settings-modal");
  showToast("Server updated!", "success");
});

document.getElementById("ss-leave-btn").addEventListener("click", async () => {
  if (!confirm("Leave this server?")) return;
  const { id, data } = AppState.activeServer;
  const myUid = AppState.currentUser.uid;
  if (data.owner === myUid) { showToast("Transfer ownership before leaving.", "error"); return; }
  await db.ref(`serverMembers/${id}/${myUid}`).remove();
  await db.ref(`userServers/${myUid}/${id}`).remove();
  closeModal("server-settings-modal");
  document.getElementById("home-btn").click();
  showToast("Left server.");
});

document.getElementById("ss-delete-btn").addEventListener("click", async () => {
  if (!confirm("Delete this server? This cannot be undone.")) return;
  const { id } = AppState.activeServer;
  const myUid = AppState.currentUser.uid;

  // Remove all member references
  const membersSnap = await db.ref(`serverMembers/${id}`).get();
  const updates = {};
  updates[`servers/${id}`] = null;
  updates[`serverMembers/${id}`] = null;
  updates[`channels/${id}`] = null;
  updates[`messages/${id}`] = null;
  updates[`typing/${id}`] = null;

  if (membersSnap.exists()) {
    Object.keys(membersSnap.val()).forEach(uid => {
      updates[`userServers/${uid}/${id}`] = null;
    });
  }
  await db.ref().update(updates);
  closeModal("server-settings-modal");
  document.getElementById("home-btn").click();
  showToast("Server deleted.");
});

// ── Members sidebar ───────────────────────────────────────────────────
function loadMembers(sid) {
  db.ref(`serverMembers/${sid}`).on("value", async snap => {
    const onlineEl  = document.getElementById("online-members-list");
    const offlineEl = document.getElementById("offline-members-list");
    const onlineCount  = document.getElementById("online-count");
    const offlineCount = document.getElementById("offline-count");
    onlineEl.innerHTML = "";
    offlineEl.innerHTML = "";

    if (!snap.exists()) return;

    const members = snap.val();
    let onC = 0, offC = 0;

    for (const [uid, role] of Object.entries(members)) {
      const profile = await fetchProfile(uid);
      if (!profile) continue;

      const item = document.createElement("div");
      item.className = "member-item";

      const avatarDiv = document.createElement("div");
      avatarDiv.className = "member-avatar";
      renderAvatar(avatarDiv, profile);

      const dot = document.createElement("span");
      dot.className = `status-dot ${statusClass(profile.status || "Offline")}`;
      dot.style.cssText = "position:absolute;bottom:-1px;right:-1px;border-color:var(--bg-secondary);";
      avatarDiv.appendChild(dot);

      const nameEl = document.createElement("span");
      nameEl.className = "member-name";
      nameEl.textContent = profile.username;

      const roleEl = document.createElement("span");
      roleEl.className = `member-role role-${role}`;
      roleEl.textContent = role !== "member" ? role : "";

      item.appendChild(avatarDiv);
      item.appendChild(nameEl);
      item.appendChild(roleEl);

      item.addEventListener("click", (e) => showProfile(uid, item));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMemberContextMenu(e, uid, role, sid);
      });

      const isOnline = profile.online && profile.status !== "Offline";
      if (isOnline) { onlineEl.appendChild(item); onC++; }
      else          { offlineEl.appendChild(item); offC++; }
    }

    onlineCount.textContent  = onC;
    offlineCount.textContent = offC;
  });
}

function showMemberContextMenu(e, targetUid, targetRole, sid) {
  const myUid = AppState.currentUser.uid;
  const myRole = AppState.activeServer.data.owner === myUid ? "owner" : "member";
  const items = [];

  items.push({ label: "View Profile", action: () => showProfile(targetUid, e.target) });

  const isFriendCheck = async () => {
    const s = await db.ref(`friends/${myUid}/${targetUid}`).get();
    if (s.exists()) {
      showContextMenu(e.clientX, e.clientY, [
        ...items,
        { label: "Message", action: async () => {
          const p = await fetchProfile(targetUid);
          openDM(targetUid, p);
        }},
        { label: "Remove Friend", danger: true, action: () => removeFriend(targetUid) },
      ]);
    } else {
      showContextMenu(e.clientX, e.clientY, [
        ...items,
        { label: "Add Friend", action: () => sendFriendRequest(targetUid) },
      ]);
    }
  };

  if (targetUid !== myUid) {
    isFriendCheck();
  } else {
    showContextMenu(e.clientX, e.clientY, items);
  }
}

// ── Toggle member sidebar ─────────────────────────────────────────────
document.getElementById("toggle-members-btn").addEventListener("click", () => {
  const ms = document.getElementById("member-sidebar");
  AppState.membersVisible = !AppState.membersVisible;
  ms.style.display = AppState.membersVisible ? "" : "none";
});
