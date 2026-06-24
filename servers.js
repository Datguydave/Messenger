// servers.js — server CRUD, members, rail icons
// Server IDs are 5-char alphanumeric (easy to share).

// ── 5-char ID generator ───────────────────────────────────────────────
function makeServerId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function uniqueServerId() {
  let id, snap;
  do {
    id   = makeServerId();
    snap = await db.ref("servers/" + id).get();
  } while (snap.exists());
  return id;
}

// ── Open server modal ─────────────────────────────────────────────────
document.getElementById("add-server-btn").addEventListener("click", () => openModal("server-modal"));

document.getElementById("server-icon-input").addEventListener("change", function () {
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
  const serverId = await uniqueServerId();

  let iconUrl = "";
  if (iconFile) {
    try { iconUrl = await uploadServerIcon(iconFile, serverId); }
    catch (e) { console.warn("Icon error:", e); }
  }

  const serverData = { name, icon: iconUrl, owner: myUid, createdAt: Date.now() };
  const updates = {};
  updates["servers/" + serverId] = serverData;
  updates["serverMembers/" + serverId + "/" + myUid] = "owner";
  updates["userServers/" + myUid + "/" + serverId]   = true;
  await db.ref().update(updates);

  // Default channels
  const ch1 = db.ref("channels/" + serverId).push().key;
  const ch2 = db.ref("channels/" + serverId).push().key;
  await db.ref("channels/" + serverId).update({
    [ch1]: { name: "general",       type: "text", createdAt: Date.now() },
    [ch2]: { name: "announcements", type: "text", createdAt: Date.now() },
  });

  closeModal("server-modal");
  document.getElementById("server-name-input").value = "";
  document.getElementById("server-icon-input").value = "";
  document.getElementById("server-icon-name").textContent = "No file chosen";
  showToast(name + " created! ID: " + serverId, "success");
  selectServer(serverId, serverData);
});

// ── Join server ───────────────────────────────────────────────────────
document.getElementById("join-server-btn").addEventListener("click", async () => {
  const rawId  = document.getElementById("join-server-id-input").value.trim().toUpperCase();
  const errEl  = document.getElementById("join-server-error");
  errEl.textContent = "";
  if (!rawId) { errEl.textContent = "Please enter a server ID."; return; }

  const snap = await db.ref("servers/" + rawId).get();
  if (!snap.exists()) { errEl.textContent = "Server not found. Check the ID and try again."; return; }

  const myUid = AppState.currentUser.uid;
  const already = (await db.ref("serverMembers/" + rawId + "/" + myUid).get()).exists();
  if (already) { errEl.textContent = "You are already in that server!"; return; }

  await db.ref("serverMembers/" + rawId + "/" + myUid).set("member");
  await db.ref("userServers/" + myUid + "/" + rawId).set(true);

  closeModal("server-modal");
  document.getElementById("join-server-id-input").value = "";
  showToast("Joined " + snap.val().name + "!", "success");
  selectServer(rawId, snap.val());
});

// ── Load servers (live) ───────────────────────────────────────────────
function initServers() {
  const myUid = AppState.currentUser.uid;
  db.ref("userServers/" + myUid).on("value", async snap => {
    const list = document.getElementById("server-icons-list");
    list.innerHTML = "";
    if (!snap.exists()) return;
    for (const sid of Object.keys(snap.val())) {
      const sSnap = await db.ref("servers/" + sid).get();
      if (!sSnap.exists()) continue;
      list.appendChild(buildRailIcon(sid, sSnap.val()));
    }
  });
}

function buildRailIcon(sid, server) {
  // Wrap so we can show the pill indicator
  const wrap = document.createElement("div");
  wrap.className = "rail-icon-wrap";
  wrap.dataset.sid = sid;

  const pill = document.createElement("div");
  pill.className = "rail-pill";

  const icon = document.createElement("div");
  icon.className = "rail-icon";
  icon.title = server.name;

  if (server.icon) {
    const img = document.createElement("img");
    img.src = server.icon;
    img.alt = server.name;
    icon.appendChild(img);
  } else {
    icon.textContent = server.name.charAt(0).toUpperCase();
    icon.style.cssText = "background:" + stringToColor(server.name) + ";color:#fff;font-weight:700;font-size:18px;";
  }

  const badge = document.createElement("span");
  badge.className = "notif-badge hidden";
  badge.id = "rail-badge-" + sid;
  icon.appendChild(badge);

  wrap.appendChild(pill);
  wrap.appendChild(icon);
  wrap.addEventListener("click", async () => {
    const s = await db.ref("servers/" + sid).get();
    selectServer(sid, s.val());
  });
  return wrap;
}

// ── Select server ─────────────────────────────────────────────────────
async function selectServer(sid, serverData) {
  AppState.activeServer  = { id: sid, data: serverData };
  AppState.activeChannel = null;
  AppState.activeDM      = null;
  AppState.clearListeners();

  document.querySelectorAll(".rail-icon-wrap").forEach(el => el.classList.remove("active"));
  const wrap = document.querySelector(".rail-icon-wrap[data-sid='" + sid + "']");
  if (wrap) wrap.classList.add("active");

  document.getElementById("home-btn").parentElement && 
    document.getElementById("home-btn").classList.remove("active");

  document.getElementById("dm-panel").classList.remove("active");
  document.getElementById("server-panel").classList.add("active");
  document.getElementById("server-name-label").textContent = serverData.name;
  document.getElementById("member-sidebar").style.display = "";

  loadChannels(sid);
  loadMembers(sid);

  document.getElementById("chat-view").classList.remove("active");
  document.getElementById("welcome-view").classList.remove("active");
}

// ── Server settings ───────────────────────────────────────────────────
document.getElementById("server-settings-btn").addEventListener("click", async () => {
  if (!AppState.activeServer) return;
  const { id, data } = AppState.activeServer;
  const myUid   = AppState.currentUser.uid;
  const isOwner = data.owner === myUid;
  document.getElementById("ss-name-input").value = data.name;
  document.getElementById("ss-id-display").value  = id;
  document.getElementById("ss-delete-btn").classList.toggle("hidden", !isOwner);
  openModal("server-settings-modal");
});

document.getElementById("copy-server-id-btn").addEventListener("click", () => {
  const val = document.getElementById("ss-id-display").value;
  navigator.clipboard.writeText(val).then(() => showToast("Server ID " + val + " copied!", "success"));
});

document.getElementById("ss-roles-btn") && document.getElementById("ss-roles-btn").addEventListener("click", () => {
  if (AppState.activeServer && typeof openRolesModal === "function") {
    closeModal("server-settings-modal");
    openRolesModal(AppState.activeServer.id);
  }
});

document.getElementById("ss-save-btn").addEventListener("click", async () => {
  const { id } = AppState.activeServer;
  const newName = document.getElementById("ss-name-input").value.trim();
  if (!newName) return;
  await db.ref("servers/" + id + "/name").set(newName);
  AppState.activeServer.data.name = newName;
  document.getElementById("server-name-label").textContent = newName;
  closeModal("server-settings-modal");
  showToast("Server updated!", "success");
});

document.getElementById("ss-leave-btn").addEventListener("click", async () => {
  if (!confirm("Leave this server?")) return;
  const { id, data } = AppState.activeServer;
  const myUid = AppState.currentUser.uid;
  if (data.owner === myUid) { showToast("You're the owner — delete the server instead.", "error"); return; }
  await db.ref("serverMembers/" + id + "/" + myUid).remove();
  await db.ref("userServers/" + myUid + "/" + id).remove();
  closeModal("server-settings-modal");
  document.getElementById("home-btn").click();
  showToast("Left server.");
});

document.getElementById("ss-delete-btn").addEventListener("click", async () => {
  if (!confirm("Delete this server? This cannot be undone.")) return;
  const { id } = AppState.activeServer;
  const membersSnap = await db.ref("serverMembers/" + id).get();
  const updates = {
    ["servers/" + id]: null,
    ["serverMembers/" + id]: null,
    ["channels/" + id]: null,
    ["messages/" + id]: null,
    ["typing/" + id]: null,
  };
  if (membersSnap.exists()) {
    Object.keys(membersSnap.val()).forEach(uid => {
      updates["userServers/" + uid + "/" + id] = null;
    });
  }
  await db.ref().update(updates);
  closeModal("server-settings-modal");
  document.getElementById("home-btn").click();
  showToast("Server deleted.");
});

// ── Members sidebar ───────────────────────────────────────────────────
function loadMembers(sid) {
  const offFn = () => db.ref("serverMembers/" + sid).off();
  AppState.registerListener(offFn);

  db.ref("serverMembers/" + sid).on("value", async snap => {
    const onlineEl  = document.getElementById("online-members-list");
    const offlineEl = document.getElementById("offline-members-list");
    onlineEl.innerHTML = "";
    offlineEl.innerHTML = "";
    let onC = 0, offC = 0;
    if (!snap.exists()) return;

    for (const [uid, role] of Object.entries(snap.val())) {
      const profile = await fetchProfile(uid);
      if (!profile) continue;

      const item = document.createElement("div");
      item.className = "member-item";

      const av = document.createElement("div");
      av.className = "member-avatar";
      renderAvatar(av, profile);

      const dot = document.createElement("span");
      dot.className = "status-dot " + statusClass(profile.status || "Offline");
      dot.style.cssText = "position:absolute;bottom:-1px;right:-1px;border-color:var(--bg-secondary);";
      av.appendChild(dot);

      const nm = document.createElement("span");
      nm.className = "member-name";
      nm.textContent = profile.username;

      const rl = document.createElement("span");
      rl.className = "member-role role-" + role;
      rl.textContent = role !== "member" ? role : "";

      item.appendChild(av);
      item.appendChild(nm);
      item.appendChild(rl);
      item.addEventListener("click", () => showProfile(uid, item));
      item.addEventListener("contextmenu", e => { e.preventDefault(); showMemberCtx(e, uid, sid); });

      const isOnline = profile.online && profile.status !== "Offline";
      if (isOnline) { onlineEl.appendChild(item); onC++; }
      else          { offlineEl.appendChild(item); offC++; }
    }
    document.getElementById("online-count").textContent  = onC;
    document.getElementById("offline-count").textContent = offC;
  });
}

async function showMemberCtx(e, targetUid, sid) {
  const myUid = AppState.currentUser.uid;
  const items = [{ label: "👤 View Profile", action: () => showProfile(targetUid, e.target) }];
  if (targetUid !== myUid) {
    const isFriend = (await db.ref("friends/" + myUid + "/" + targetUid).get()).exists();
    if (isFriend) {
      items.push({ label: "💬 Message", action: async () => { const p = await fetchProfile(targetUid); openDM(targetUid, p); }});
      items.push("divider");
      items.push({ label: "Remove Friend", danger: true, action: () => removeFriend(targetUid) });
    } else {
      items.push({ label: "➕ Add Friend", action: () => sendFriendRequest(targetUid) });
    }
  }
  showContextMenu(e.clientX, e.clientY, items);
}

// ── Toggle member sidebar ─────────────────────────────────────────────
document.getElementById("toggle-members-btn").addEventListener("click", () => {
  const ms = document.getElementById("member-sidebar");
  AppState.membersVisible = !AppState.membersVisible;
  ms.style.display = AppState.membersVisible ? "" : "none";
});


async function showAssignRoleMenu(e, sid, targetUid) {
  const snap = await db.ref("roles/" + sid).get();
  if (!snap.exists()) { showToast("No custom roles yet. Create them in Server Settings → Manage Roles."); return; }
  const items = Object.entries(snap.val()).map(([roleId, role]) => ({
    label: role.name,
    action: () => assignRoleToMember && assignRoleToMember(sid, targetUid, roleId),
  }));
  showContextMenu(e.clientX, e.clientY, items);
}
