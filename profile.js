// profile.js — profile popup

const profilePopup = document.getElementById("profile-popup");

async function showProfile(uid, anchorEl) {
  // Fetch live profile
  const profile = await fetchProfile(uid);
  if (!profile) return;

  // Banner
  const bannerEl = document.querySelector(".profile-popup-banner");
  if (bannerEl && typeof getBannerStyle === "function") {
    const bs = getBannerStyle(profile);
    bannerEl.style.cssText = bs || "background:linear-gradient(135deg,#5865F2,#7289da)";
  }

  // Avatar with frame
  const avEl = document.getElementById("popup-avatar");
  renderAvatar(avEl, profile);
  if (typeof applyDecorationsToAvatar === "function") applyDecorationsToAvatar(avEl, profile);

  // Name
  const npEl = document.getElementById("popup-username");
  const npHtml = typeof getNameplateHTML === "function" ? getNameplateHTML(profile) : "";
  npEl.innerHTML = escapeHtml(profile.username || "Unknown") + (npHtml ? " " + npHtml : "");

  // Status line with coloured dot
  const st = profile.status || "Offline";
  const statusEl = document.getElementById("popup-status");
  statusEl.innerHTML =
    "<span class='status-dot " + statusClass(st) + "' " +
    "style='display:inline-block;width:8px;height:8px;margin-right:5px;" +
    "border:none;vertical-align:middle'></span>" + escapeHtml(st);

  // About / bio — show a placeholder if empty
  const about = (profile.about || "").trim();
  const aboutEl = document.getElementById("popup-about");
  aboutEl.textContent = about || "No bio yet.";
  aboutEl.style.color = about ? "" : "var(--text-faint)";
  aboutEl.style.fontStyle = about ? "" : "italic";

  // Action buttons
  const actionsEl = document.getElementById("popup-actions");
  actionsEl.innerHTML = "";
  const myUid = AppState.currentUser ? AppState.currentUser.uid : null;

  if (myUid && uid !== myUid) {
    const isFriend = (await db.ref("friends/" + myUid + "/" + uid).get()).exists();

    if (isFriend) {
      const msgBtn = document.createElement("button");
      msgBtn.className = "btn-primary";
      msgBtn.textContent = "💬 Message";
      msgBtn.onclick = () => { profilePopup.classList.add("hidden"); openDM(uid, profile); };
      actionsEl.appendChild(msgBtn);

      const remBtn = document.createElement("button");
      remBtn.className = "btn-danger";
      remBtn.textContent = "Remove Friend";
      remBtn.onclick = async () => { await removeFriend(uid); profilePopup.classList.add("hidden"); };
      actionsEl.appendChild(remBtn);
    } else {
      const reqSent = (await db.ref("friendRequests/" + uid + "/" + myUid).get()).exists();
      const addBtn  = document.createElement("button");
      addBtn.className = "btn-primary";
      if (reqSent) {
        addBtn.textContent = "Request Sent";
        addBtn.disabled = true;
      } else {
        addBtn.textContent = "➕ Add Friend";
        addBtn.onclick = async () => {
          await sendFriendRequest(uid);
          addBtn.textContent = "Request Sent";
          addBtn.disabled = true;
        };
      }
      actionsEl.appendChild(addBtn);
    }
  }

  // Position popup near the anchor element
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  profilePopup.style.transform = "";
  if (rect) {
    let top  = rect.top;
    let left = rect.right + 10;
    if (left + 300 > window.innerWidth)  left = rect.left - 308;
    if (left < 8)                        left = 8;
    if (top + 320 > window.innerHeight)  top  = window.innerHeight - 328;
    if (top < 8)                         top  = 8;
    profilePopup.style.top  = top  + "px";
    profilePopup.style.left = left + "px";
  } else {
    profilePopup.style.top       = "50%";
    profilePopup.style.left      = "50%";
    profilePopup.style.transform = "translate(-50%,-50%)";
  }

  profilePopup.classList.remove("hidden");
}

function statusClass(status) {
  if (status === "Online")           return "online";
  if (status === "Idle")             return "idle";
  if (status === "Do Not Disturb")   return "dnd";
  return "offline";
}
