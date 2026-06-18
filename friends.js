// friends.js — friends, DMs, online users

// ── Open Friends modal ────────────────────────────────────────────────
document.getElementById("open-friends-btn").addEventListener("click", () => {
  openModal("friends-modal");
  renderFriendLists();
});

// ── Add friend by username ────────────────────────────────────────────
document.getElementById("add-friend-btn").addEventListener("click", addFriendByUsername);
document.getElementById("add-friend-input").addEventListener("keydown", e => {
  if (e.key === "Enter") addFriendByUsername();
});

async function addFriendByUsername() {
  const input    = document.getElementById("add-friend-input");
  const statusEl = document.getElementById("add-friend-status");
  const username = input.value.trim();
  statusEl.textContent = "";
  if (!username) return;

  const slug = slugify(username);
  const snap = await db.ref("usernames/" + slug).get();
  if (!snap.exists()) {
    statusEl.style.color = "#f38888";
    statusEl.textContent = "No user found with that username.";
    return;
  }

  const targetUid = snap.val();
  if (targetUid === AppState.currentUser.uid) {
    statusEl.style.color = "#f38888";
    statusEl.textContent = "You can't add yourself!";
    return;
  }

  const already = (await db.ref("friends/" + AppState.currentUser.uid + "/" + targetUid).get()).exists();
  if (already) {
    statusEl.style.color = "#23a55a";
    statusEl.textContent = "You're already friends!";
    return;
  }

  const sent = (await db.ref("friendRequests/" + targetUid + "/" + AppState.currentUser.uid).get()).exists();
  if (sent) {
    statusEl.style.color = "#f0b232";
    statusEl.textContent = "Request already sent.";
    return;
  }

  await sendFriendRequest(targetUid);
  statusEl.style.color = "#23a55a";
  statusEl.textContent = "Friend request sent!";
  input.value = "";
}

// ── Send / accept / decline / remove ─────────────────────────────────
async function sendFriendRequest(targetUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref("friendRequests/" + targetUid + "/" + myUid).set(true);
  await db.ref("notifications/" + targetUid + "/friendRequests/" + myUid).set({
    from: myUid, timestamp: Date.now(), type: "friendRequest"
  });
}

async function acceptFriendRequest(senderUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref().update({
    ["friends/" + myUid + "/" + senderUid]: true,
    ["friends/" + senderUid + "/" + myUid]: true,
    ["friendRequests/" + myUid + "/" + senderUid]: null,
    ["notifications/" + myUid + "/friendRequests/" + senderUid]: null,
  });
  showToast("Friend added! 🎉", "success");
  renderFriendLists();
  // DM list updates automatically via its live listener
}

async function declineFriendRequest(senderUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref("friendRequests/" + myUid + "/" + senderUid).remove();
  await db.ref("notifications/" + myUid + "/friendRequests/" + senderUid).remove();
  renderFriendLists();
}

async function removeFriend(targetUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref().update({
    ["friends/" + myUid + "/" + targetUid]: null,
    ["friends/" + targetUid + "/" + myUid]: null,
  });
  showToast("Friend removed.");
  renderFriendLists();
}

// ── Render friends modal ──────────────────────────────────────────────
async function renderFriendLists() {
  const myUid      = AppState.currentUser.uid;
  const allEl      = document.getElementById("friends-list-all");
  const incomingEl = document.getElementById("friends-incoming");
  const outgoingEl = document.getElementById("friends-outgoing");

  allEl.innerHTML = "<div class='empty-state'>Loading…</div>";

  const [friendsSnap, incomingSnap] = await Promise.all([
    db.ref("friends/" + myUid).get(),
    db.ref("friendRequests/" + myUid).get(),
  ]);

  // ── All friends ──
  allEl.innerHTML = "";
  if (!friendsSnap.exists()) {
    allEl.innerHTML = "<div class='empty-state'>No friends yet — add someone!</div>";
  } else {
    for (const uid of Object.keys(friendsSnap.val())) {
      const p = await fetchProfile(uid);
      if (!p) continue;
      allEl.appendChild(buildFriendRow(p, [
        { label: "Message", action: () => { closeModal("friends-modal"); openDM(uid, p); } },
        { label: "Remove", danger: true, action: () => removeFriend(uid) },
      ]));
    }
  }

  // ── Incoming ──
  incomingEl.innerHTML = "";
  if (!incomingSnap.exists()) {
    incomingEl.innerHTML = "<div class='empty-state'>No incoming requests.</div>";
  } else {
    for (const senderUid of Object.keys(incomingSnap.val())) {
      const p = await fetchProfile(senderUid);
      if (!p) continue;
      incomingEl.appendChild(buildFriendRow(p, [
        { label: "Accept",  action: () => acceptFriendRequest(senderUid) },
        { label: "Decline", danger: true, action: () => declineFriendRequest(senderUid) },
      ]));
    }
  }

  // ── Outgoing ──
  outgoingEl.innerHTML = "";
  const allReqSnap = await db.ref("friendRequests").get();
  let foundOut = false;
  if (allReqSnap.exists()) {
    for (const [targetUid, senders] of Object.entries(allReqSnap.val())) {
      if (senders && senders[myUid]) {
        foundOut = true;
        const p = await fetchProfile(targetUid);
        if (!p) continue;
        outgoingEl.appendChild(buildFriendRow(p, [
          { label: "Cancel", danger: true, action: async () => {
            await db.ref("friendRequests/" + targetUid + "/" + myUid).remove();
            renderFriendLists();
          }},
        ]));
      }
    }
  }
  if (!foundOut) outgoingEl.innerHTML = "<div class='empty-state'>No outgoing requests.</div>";
}

function buildFriendRow(profile, actions) {
  const row = document.createElement("div");
  row.className = "dm-item";
  row.style.cssText = "padding:10px;border-radius:8px;margin-bottom:4px;";

  const av = document.createElement("div");
  av.className = "dm-avatar";
  renderAvatar(av, profile);

  // Status dot
  const dot = document.createElement("span");
  dot.className = "status-dot " + statusClass(profile.status || "Offline");
  dot.style.cssText = "position:absolute;bottom:-1px;right:-1px;border-color:var(--bg-secondary);";
  av.appendChild(dot);

  const info = document.createElement("div");
  info.style.flex = "1";
  info.innerHTML =
    "<div class='dm-name'>" + escapeHtml(profile.username) + "</div>" +
    "<div class='dm-preview'>" + escapeHtml(profile.status || "Offline") + "</div>";

  row.appendChild(av);
  row.appendChild(info);
  actions.forEach(a => {
    const btn = document.createElement("button");
    btn.className = a.danger ? "btn-danger" : "btn-primary";
    btn.style.cssText = "font-size:12px;padding:6px 12px;flex-shrink:0;margin-left:6px;";
    btn.textContent = a.label;
    btn.onclick = e => { e.stopPropagation(); a.action(); };
    row.appendChild(btn);
  });
  return row;
}

// ── Incoming request badge ────────────────────────────────────────────
function listenFriendRequests() {
  const myUid = AppState.currentUser.uid;
  db.ref("friendRequests/" + myUid).on("value", snap => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    const label = document.getElementById("open-friends-btn");
    const old = label.querySelector(".dm-unread");
    if (old) old.remove();
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "dm-unread";
      badge.textContent = count;
      label.appendChild(badge);
    }
  });
}

// ── DM sidebar — live listener on friends ─────────────────────────────
function initDMList() {
  const myUid = AppState.currentUser.uid;
  // Re-render whenever our friends list changes
  db.ref("friends/" + myUid).on("value", () => renderDMList());
}

async function renderDMList() {
  const myUid  = AppState.currentUser.uid;
  const listEl = document.getElementById("dm-list");
  listEl.innerHTML = "";

  const snap = await db.ref("friends/" + myUid).get();
  if (!snap.exists()) {
    listEl.innerHTML = "<div class='empty-state'>Add some friends to start chatting!</div>";
    return;
  }

  for (const uid of Object.keys(snap.val())) {
    const profile = await fetchProfile(uid);
    if (!profile) continue;
    const chatId = buildChatId(myUid, uid);

    const item = document.createElement("div");
    item.className = "dm-item";
    item.dataset.uid = uid;

    const av = document.createElement("div");
    av.className = "dm-avatar";
    renderAvatar(av, profile);

    // Online dot
    const dot = document.createElement("span");
    dot.className = "status-dot " + statusClass(profile.status || "Offline");
    dot.style.cssText = "position:absolute;bottom:-1px;right:-1px;border-color:var(--bg-secondary);";
    av.appendChild(dot);

    const info = document.createElement("div");
    info.className = "dm-info";
    info.innerHTML =
      "<div class='dm-name'>" + escapeHtml(profile.username) + "</div>" +
      "<div class='dm-preview' id='dm-preview-" + uid + "'></div>";

    const badge = document.createElement("span");
    badge.className = "dm-unread hidden";
    badge.id = "dm-badge-" + uid;

    item.appendChild(av);
    item.appendChild(info);
    item.appendChild(badge);
    item.addEventListener("click", () => openDM(uid, profile));

    listEl.appendChild(item);

    // Live last-message preview
    db.ref("dms/" + chatId).orderByChild("timestamp").limitToLast(1).on("value", s => {
      if (!s.exists()) return;
      const msg     = Object.values(s.val())[0];
      const preview = document.getElementById("dm-preview-" + uid);
      if (preview) preview.textContent = msg.content ? msg.content.substring(0, 35) : "[attachment]";
    });
  }
}

// ── Open DM ───────────────────────────────────────────────────────────
function openDM(targetUid, profile) {
  AppState.activeServer  = null;
  AppState.activeChannel = null;
  AppState.activeDM      = { chatId: buildChatId(AppState.currentUser.uid, targetUid), otherUid: targetUid };

  document.querySelectorAll(".dm-item").forEach(el =>
    el.classList.toggle("active", el.dataset.uid === targetUid));
  document.querySelectorAll(".rail-icon-wrap").forEach(el => el.classList.remove("active"));
  document.getElementById("home-btn").classList.add("active");

  document.getElementById("dm-panel").classList.add("active");
  document.getElementById("server-panel").classList.remove("active");

  document.getElementById("chat-channel-name").textContent = profile.username;
  document.querySelector(".channel-hash").textContent = "@";
  document.getElementById("message-input").placeholder = "Message " + profile.username;
  document.getElementById("member-sidebar").style.display = "none";

  document.getElementById("welcome-view").classList.remove("active");
  document.getElementById("chat-view").classList.add("active");

  loadMessages("dm");
}

// ── Search DM list ────────────────────────────────────────────────────
document.getElementById("search-input").addEventListener("input", function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll("#dm-list .dm-item").forEach(item => {
    const name = item.querySelector(".dm-name");
    item.style.display = (!q || (name && name.textContent.toLowerCase().includes(q))) ? "" : "none";
  });
});

// ── Init ──────────────────────────────────────────────────────────────
function initFriends() {
  initDMList();
  listenFriendRequests();

  // Tab click listeners
  document.querySelector('[data-tab="friends-all"]').addEventListener("click", renderFriendLists);
  document.querySelector('[data-tab="friends-pending"]').addEventListener("click", renderFriendLists);

  // Home button
  document.getElementById("home-btn").addEventListener("click", () => {
    AppState.activeServer  = null;
    AppState.activeChannel = null;
    AppState.activeDM      = null;
    AppState.clearListeners();

    document.querySelectorAll(".rail-icon-wrap").forEach(el => el.classList.remove("active"));
    document.getElementById("home-btn").classList.add("active");
    document.getElementById("dm-panel").classList.add("active");
    document.getElementById("server-panel").classList.remove("active");
    document.getElementById("member-sidebar").style.display = "";
    document.getElementById("chat-view").classList.remove("active");
    document.getElementById("welcome-view").classList.add("active");
  });

  document.getElementById("welcome-add-server").addEventListener("click", () => openModal("server-modal"));
}
