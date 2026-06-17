// profile.js — user profile popup

const profilePopup = document.getElementById("profile-popup");

/**
 * Show profile popup for a given UID near an element or coordinates.
 */
async function showProfile(uid, anchorEl) {
  const profile = await fetchProfile(uid);
  if (!profile) return;

  const popup = profilePopup;

  // Avatar
  const avatarEl = document.getElementById("popup-avatar");
  renderAvatar(avatarEl, profile);

  // Info
  document.getElementById("popup-username").textContent = profile.username || "Unknown";
  document.getElementById("popup-about").textContent    = profile.about || "";

  // Status with dot
  const statusEl = document.getElementById("popup-status");
  statusEl.innerHTML = `<span class="status-dot ${statusClass(profile.status)} " style="display:inline-block;margin-right:4px"></span>${profile.status || "Offline"}`;

  // Actions
  const actionsEl = document.getElementById("popup-actions");
  actionsEl.innerHTML = "";
  const myUid = AppState.currentUser ? AppState.currentUser.uid : null;

  if (myUid && uid !== myUid) {
    // Check friendship
    const friendSnap = await db.ref(`friends/${myUid}/${uid}`).get();
    const isFriend = friendSnap.exists();

    if (isFriend) {
      const dmBtn = document.createElement("button");
      dmBtn.className = "btn-primary";
      dmBtn.textContent = "Message";
      dmBtn.onclick = () => { popup.classList.add("hidden"); openDM(uid, profile); };
      actionsEl.appendChild(dmBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-danger";
      removeBtn.textContent = "Remove Friend";
      removeBtn.onclick = async () => {
        await removeFriend(uid);
        popup.classList.add("hidden");
      };
      actionsEl.appendChild(removeBtn);
    } else {
      // Check if request already sent
      const reqSnap = await db.ref(`friendRequests/${uid}/${myUid}`).get();
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      if (reqSnap.exists()) {
        btn.textContent = "Request Sent";
        btn.disabled = true;
      } else {
        btn.textContent = "Add Friend";
        btn.onclick = async () => {
          await sendFriendRequest(uid);
          btn.textContent = "Request Sent";
          btn.disabled = true;
        };
      }
      actionsEl.appendChild(btn);
    }
  }

  // Position the popup
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  if (rect) {
    let top  = rect.top;
    let left = rect.right + 8;
    if (left + 290 > window.innerWidth)  left = rect.left - 298;
    if (top + 300 > window.innerHeight)  top  = window.innerHeight - 310;
    popup.style.top  = Math.max(8, top) + "px";
    popup.style.left = Math.max(8, left) + "px";
  } else {
    popup.style.top  = "50%";
    popup.style.left = "50%";
    popup.style.transform = "translate(-50%,-50%)";
  }

  popup.classList.remove("hidden");
}

function statusClass(status) {
  if (status === "Online")           return "online";
  if (status === "Idle")             return "idle";
  if (status === "Do Not Disturb")   return "dnd";
  return "offline";
}
