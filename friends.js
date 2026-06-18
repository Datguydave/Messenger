// friends.js — friends list, requests, DM list, user search

// ── Open Friends modal ────────────────────────────────────────────────
document.getElementById("open-friends-btn").addEventListener("click", () => openModal("friends-modal"));

// ── Add friend by username ────────────────────────────────────────────
document.getElementById("add-friend-btn").addEventListener("click", addFriendByUsername);
document.getElementById("add-friend-input").addEventListener("keydown", e => {
  if (e.key === "Enter") addFriendByUsername();
});

async function addFriendByUsername() {
  const input     = document.getElementById("add-friend-input");
  const statusEl  = document.getElementById("add-friend-status");
  const username  = input.value.trim();
  statusEl.textContent = "";
  if (!username) return;

  const safeKey = slugify(username);
  const snap = await db.ref(`usernames/${safeKey}`).get();
  if (!snap.exists()) { statusEl.textContent = "User not found."; statusEl.style.color = "#f38888"; return; }

  const targetUid = snap.val();
  if (targetUid === AppState.currentUser.uid) {
    statusEl.textContent = "You can't add yourself!"; statusEl.style.color = "#f38888"; return;
  }

  // Already friends?
  const fSnap = await db.ref(`friends/${AppState.currentUser.uid}/${targetUid}`).get();
  if (fSnap.exists()) { statusEl.textContent = "Already friends!"; statusEl.style.color = "#23a55a"; return; }

  await sendFriendRequest(targetUid);
  statusEl.textContent = "Friend request sent!";
  statusEl.style.color = "#23a55a";
  input.value = "";
}

async function sendFriendRequest(targetUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref(`friendRequests/${targetUid}/${myUid}`).set(true);
  // Notification
  await db.ref(`notifications/${targetUid}/friendRequests/${myUid}`).set({
    from: myUid, timestamp: Date.now(), type: "friendRequest"
  });
}

// ── Accept / Decline ──────────────────────────────────────────────────
async function acceptFriendRequest(senderUid) {
  const myUid = AppState.currentUser.uid;
  const updates = {};
  updates[`friends/${myUid}/${senderUid}`]   = true;
  updates[`friends/${senderUid}/${myUid}`]   = true;
  updates[`friendRequests/${myUid}/${senderUid}`] = null;
  updates[`notifications/${myUid}/friendRequests/${senderUid}`] = null;
  await db.ref().update(updates);
  showToast("Friend added! 🎉", "success");
  renderFriendLists();
}

async function declineFriendRequest(senderUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref(`friendRequests/${myUid}/${senderUid}`).remove();
  await db.ref(`notifications/${myUid}/friendRequests/${senderUid}`).remove();
  renderFriendLists();
}

async function removeFriend(targetUid) {
  const myUid = AppState.currentUser.uid;
  await db.ref(`friends/${myUid}/${targetUid}`).remove();
  await db.ref(`friends/${targetUid}/${myUid}`).remove();
  showToast("Friend removed.");
  renderFriendLists();
  renderDMList();
}

// ── Render friend lists in modal ──────────────────────────────────────
async function renderFriendLists() {
  const myUid = AppState.currentUser.uid;

  // All friends
  const allEl       = document.getElementById("friends-list-all");
  const incomingEl  = document.getElementById("friends-incoming");
  const outgoingEl  = document.getElementById("friends-outgoing");

  allEl.innerHTML = "<p style='color:var(--text-muted);padding:8px'>Loading…</p>";

  const [friendsSnap, incomingSnap, outgoingSnap] = await Promise.all([
    db.ref(`friends/${myUid}`).get(),
    db.ref(`friendRequests/${myUid}`).get(),
    db.ref("friendRequests").get(),
  ]);

  // Friends
  allEl.innerHTML = "";
  if (!friendsSnap.exists()) {
    allEl.innerHTML = "<p style='color:var(--text-muted);padding:8px'>No friends yet. Add someone!</p>";
  } else {
    const uids = Object.keys(friendsSnap.val());
    for (const uid of uids) {
      const profile = await fetchProfile(uid);
      if (!profile) continue;
      const item = buildFriendItem(profile, [
        { label: "Message", action: () => { closeModal("friends-modal"); openDM(uid, profile); } },
        { label: "Remove Friend", danger: true, action: () => removeFriend(uid) },
      ]);
      allEl.appendChild(item);
    }
  }

  // Incoming requests
  incomingEl.innerHTML = "";
  if (incomingSnap.exists()) {
    for (const senderUid of Object.keys(incomingSnap.val())) {
      const profile = await fetchProfile(senderUid);
      if (!profile) continue;
      const item = buildFriendItem(profile, [
        { label: "Accept", action: () => acceptFriendRequest(senderUid) },
        { label: "Decline", danger: true, action: () => declineFriendRequest(senderUid) },
      ]);
      incomingEl.appendChild(item);
    }
  } else {
    incomingEl.innerHTML = "<p style='color:var(--text-muted);padding:8px'>No incoming requests.</p>";
  }

  // Outgoing (requests I sent)
  outgoingEl.innerHTML = "";
  let foundOutgoing = false;
  if (outgoingSnap.exists()) {
    const all = outgoingSnap.val();
    for (const [targetUid, senders] of Object.entries(all)) {
      if (senders[myUid]) {
        foundOutgoing = true;
        const profile = await fetchProfile(targetUid);
        if (!profile) continue;
        const item = buildFriendItem(profile, [
          { label: "Cancel", danger: true, action: async () => {
            await db.ref(`friendRequests/${targetUid}/${myUid}`).remove();
            renderFriendLists();
          }},
        ]);
        outgoingEl.appendChild(item);
      }
    }
  }
  if (!foundOutgoing) outgoingEl.innerHTML = "<p style='color:var(--text-muted);padding:8px'>No outgoing requests.</p>";
}

function buildFriendItem(profile, actions) {
  const div = document.createElement("div");
  div.className = "dm-item";
  div.style.cssText = "padding:8px;border-radius:8px;display:flex;align-items:center;gap:10px;";

  const avatarDiv = document.createElement("div");
  avatarDiv.className = "dm-avatar";
  renderAvatar(avatarDiv, profile);

  const nameDiv = document.createElement("div");
  nameDiv.style.flex = "1";
  nameDiv.innerHTML = `<div class="dm-name">${escapeHtml(profile.username)}</div>
    <div class="dm-preview" style="color:var(--text-muted);font-size:12px">${profile.status || "Offline"}</div>`;

  div.appendChild(avatarDiv);
  div.appendChild(nameDiv);

  actions.forEach(a => {
    const btn = document.createElement("button");
    btn.className = a.danger ? "btn-danger" : "btn-primary";
    btn.style.cssText = "font-size:12px;padding:5px 10px;flex-shrink:0;";
    btn.textContent = a.label;
    btn.onclick = (e) => { e.stopPropagation(); a.action(); };
    div.appendChild(btn);
  });

  return div;
}

// Listen to incoming friend requests and re-render pending badge
function listenFriendRequests() {
  const myUid = AppState.currentUser.uid;
  db.ref(`friendRequests/${myUid}`).on("value", snap => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    // Update friends label badge
    const label = document.getElementById("open-friends-btn");
    const existing = label.querySelector(".dm-unread");
    if (existing) existing.remove();
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "dm-unread";
      badge.textContent = count;
      label.appendChild(badge);
    }
  });
}

// ── DM List (sidebar) ─────────────────────────────────────────────────
async function renderDMList() {
  const myUid  = AppState.currentUser.uid;
  const listEl = document.getElementById("dm-list");
  listEl.innerHTML = "";

  const snap = await db.ref(`friends/${myUid}`).get();
  if (!snap.exists()) {
    listEl.innerHTML = "<p style='color:var(--text-muted);padding:8px 16px;font-size:13px'>Add some friends to start chatting!</p>";
    return;
  }

  const friendUids = Object.keys(snap.val());
  for (const uid of friendUids) {
    const profile = await fetchProfile(uid);
    if (!profile) continue;
    const chatId = buildChatId(myUid, uid);

    const item = document.createElement("div");
    item.className = "dm-item";
    item.dataset.uid = uid;

    const avatarDiv = document.createElement("div");
    avatarDiv.className = "dm-avatar";
    renderAvatar(avatarDiv, profile);

    // Status dot on DM avatar
    const dot = document.createElement("span");
    dot.className = `status-dot ${statusClass(profile.status || "Offline")}`;
    dot.style.cssText = "position:absolute;bottom:-1px;right:-1px;border-color:var(--bg-secondary);";
    avatarDiv.appendChild(dot);

    const infoDiv = document.createElement("div");
    infoDiv.className = "dm-info";
    infoDiv.innerHTML = `<div class="dm-name">${escapeHtml(profile.username)}</div>
      <div class="dm-preview" id="dm-preview-${uid}"></div>`;

    item.appendChild(avatarDiv);
    item.appendChild(infoDiv);
    item.addEventListener("click", () => openDM(uid, profile));

    // Unread badge (live)
    const badge = document.createElement("span");
    badge.className = "dm-unread hidden";
    badge.id = `dm-badge-${uid}`;
    item.appendChild(badge);

    listEl.appendChild(item);

    // Live last message preview
    db.ref(`dms/${chatId}`).orderByChild("timestamp").limitToLast(1).on("value", snap => {
      if (!snap.exists()) return;
      const msg = Object.values(snap.val())[0];
      const preview = document.getElementById(`dm-preview-${uid}`);
      if (preview) preview.textContent = msg.text ? msg.text.substring(0, 30) : "[attachment]";
    });
  }
}

// ── Open a DM conversation ────────────────────────────────────────────
function openDM(targetUid, profile) {
  AppState.activeServer  = null;
  AppState.activeChannel = null;
  AppState.activeDM      = { chatId: buildChatId(AppState.currentUser.uid, targetUid), otherUid: targetUid };

  // Reset sidebar highlights
  document.querySelectorAll(".dm-item").forEach(el => {
    el.classList.toggle("active", el.dataset.uid === targetUid);
  });
  document.querySelectorAll(".rail-icon").forEach(el => el.classList.remove("active"));
  document.getElementById("home-btn").classList.add("active");

  // Show DM panel
  document.getElementById("dm-panel").classList.add("active");
  document.getElementById("server-panel").classList.remove("active");

  // Update chat header
  document.getElementById("chat-channel-name").textContent = profile.username;
  const hashEl = document.querySelector(".channel-hash");
  hashEl.textContent = "@";
  document.getElementById("message-input").placeholder = `Message @${profile.username}`;

  // Hide member sidebar in DMs
  document.getElementById("member-sidebar").style.display = "none";

  // Show chat view
  document.getElementById("welcome-view").classList.remove("active");
  document.getElementById("chat-view").classList.add("active");

  // Load messages
  loadMessages("dm");
}

// ── Search ────────────────────────────────────────────────────────────
document.getElementById("search-input").addEventListener("input", function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll(".dm-item").forEach(item => {
    const name = item.querySelector(".dm-name").textContent.toLowerCase();
    item.style.display = name.includes(q) ? "" : "none";
  });
});

// ── Initialise friends subsystem ──────────────────────────────────────
function initFriends() {
  renderDMList();
  listenFriendRequests();

  // Re-render when friends modal is opened
  document.getElementById("open-friends-btn").addEventListener("click", renderFriendLists);
  document.querySelector('[data-tab="friends-all"]').addEventListener("click", renderFriendLists);
  document.querySelector('[data-tab="friends-pending"]').addEventListener("click", renderFriendLists);

  // Home button
  document.getElementById("home-btn").addEventListener("click", () => {
    AppState.activeServer  = null;
    AppState.activeChannel = null;
    AppState.activeDM      = null;
    AppState.clearListeners();

    document.querySelectorAll(".rail-icon").forEach(e => e.classList.remove("active"));
    document.getElementById("home-btn").classList.add("active");
    document.getElementById("dm-panel").classList.add("active");
    document.getElementById("server-panel").classList.remove("active");
    document.getElementById("member-sidebar").style.display = "";
    document.getElementById("chat-view").classList.remove("active");
    document.getElementById("welcome-view").classList.add("active");
  });

  // Welcome button
  document.getElementById("welcome-add-server").addEventListener("click", () => openModal("server-modal"));
}
