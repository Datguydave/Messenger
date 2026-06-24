// pings.js — @mentions, paste attachments, polls, idle/offline timers

// ══════════════════════════════════════════════════════════════
//  @MENTION PARSING
// ══════════════════════════════════════════════════════════════
function parseMentions(text, currentMembers) {
  // Replace @username with a styled span
  return text.replace(/@([\w\s.\-_]{1,32})/g, (match, name) => {
    const found = currentMembers && currentMembers.find(m =>
      m.username.toLowerCase() === name.toLowerCase()
    );
    if (found) return `<span class="mention" data-uid="${found.uid}">@${escapeHtml(found.username)}</span>`;
    return `<span class="mention-unknown">${escapeHtml(match)}</span>`;
  });
}

// Called when rendering a message — check if it mentions me
function checkMentionNotify(msg) {
  const myUid      = AppState.currentUser && AppState.currentUser.uid;
  const myUsername = AppState.userProfile  && AppState.userProfile.username;
  if (!myUsername || msg.senderUid === myUid) return;

  const lower = (msg.content || "").toLowerCase();
  if (lower.includes("@" + myUsername.toLowerCase()) || lower.includes("@everyone")) {
    triggerMentionNotif(msg);
  }
}

function triggerMentionNotif(msg) {
  showDesktopNotif(msg.username + " mentioned you", msg.content || "");
}

// ══════════════════════════════════════════════════════════════
//  DESKTOP / IN-APP NOTIFICATIONS
// ══════════════════════════════════════════════════════════════
function requestNotifPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function showDesktopNotif(title, body) {
  // In-app toast always shows
  showToast("🔔 " + title + (body ? ": " + body.substring(0, 40) : ""));

  // Browser notification if permitted and tab not focused
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("⚡ Spark — " + title, { body: body.substring(0, 80), icon: "/icon.png" });
  }
}

// Toast notification for DMs — shown as a pop-up card in top-right
function showDMNotif(fromProfile, text, targetUid) {
  const existing = document.getElementById("dm-notif");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.id = "dm-notif";
  card.className = "dm-notif-card";
  card.innerHTML =
    "<div class='dm-notif-avatar' id='dm-notif-av'></div>" +
    "<div class='dm-notif-body'>" +
      "<div class='dm-notif-name'>" + escapeHtml(fromProfile.username) + "</div>" +
      "<div class='dm-notif-text'>" + escapeHtml((text||"").substring(0,60)) + "</div>" +
    "</div>" +
    "<button class='dm-notif-close' onclick=\"document.getElementById('dm-notif').remove()\">✕</button>";

  renderAvatar(card.querySelector("#dm-notif-av"), fromProfile);
  document.body.appendChild(card);

  card.addEventListener("click", async (e) => {
    if (e.target.classList.contains("dm-notif-close")) return;
    card.remove();
    // Navigate to that DM
    const profile = await fetchProfile(targetUid);
    if (profile) openDM(targetUid, profile);
  });

  setTimeout(() => { if (card.parentNode) card.remove(); }, 5000);
}

// Server activity toast (small, bottom area)
function showServerActivityNotif(serverName, channelName, username) {
  showToast("💬 " + serverName + " › #" + channelName + " — " + username + " is talking");
}

// ══════════════════════════════════════════════════════════════
//  PASTE ATTACHMENT (Ctrl+V image paste into message box)
// ══════════════════════════════════════════════════════════════
function initPasteAttachment() {
  document.getElementById("message-input").addEventListener("paste", async e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        // Treat exactly like a file-input attachment
        window._pendingAttachment = { file };
        document.getElementById("attachment-preview-name").textContent = "Pasted image";
        document.getElementById("attachment-preview").classList.remove("hidden");
        showToast("Image pasted — press Enter to send.");
        break;
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  IDLE / OFFLINE TIMERS
// ══════════════════════════════════════════════════════════════
let _idleTimer = null, _offlineTimer = null, _lastActivity = Date.now();
const IDLE_MS    = 10 * 60 * 1000;   // 10 min → Idle
const OFFLINE_MS = 3  * 60 * 60 * 1000; // 3 hr → Offline + disconnect

function resetActivityTimer() {
  _lastActivity = Date.now();
  clearTimeout(_idleTimer);
  clearTimeout(_offlineTimer);

  // Restore Online if we were Idle
  const uid = AppState.currentUser && AppState.currentUser.uid;
  const profile = AppState.userProfile;
  if (uid && profile && profile.status === "Idle") {
    db.ref("users/" + uid + "/status").set("Online").catch(() => {});
    if (AppState.userProfile) AppState.userProfile.status = "Online";
  }

  _idleTimer = setTimeout(async () => {
    if (!uid) return;
    await db.ref("users/" + uid + "/status").set("Idle").catch(() => {});
    if (AppState.userProfile) AppState.userProfile.status = "Idle";
    showToast("You are now Idle.");
  }, IDLE_MS);

  _offlineTimer = setTimeout(async () => {
    if (!uid) return;
    await db.ref("users/" + uid + "/status").set("Offline").catch(() => {});
    await db.ref("users/" + uid + "/online").set(false).catch(() => {});
    await db.ref("onlineUsers/" + uid).remove().catch(() => {});
    if (AppState.userProfile) AppState.userProfile.status = "Offline";
    showToast("You've been disconnected due to inactivity.");
  }, OFFLINE_MS);
}

function initActivityTracking() {
  ["mousemove", "keydown", "click", "touchstart", "scroll"].forEach(ev => {
    document.addEventListener(ev, resetActivityTimer, { passive: true });
  });
  resetActivityTimer();
}

// ══════════════════════════════════════════════════════════════
//  POLLS
// ══════════════════════════════════════════════════════════════
// Poll format in DB (stored as a message with type:"poll"):
// { type:"poll", question:"...", options:["A","B",...], votes:{uid:optionIndex}, endsAt }

function openPollCreator() {
  const existing = document.getElementById("poll-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "poll-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><h3>Create Poll</h3>
      <button class="modal-close" onclick="document.getElementById('poll-modal').remove()">✕</button></div>
    <div class="form-group"><label>QUESTION</label>
      <input id="poll-q" type="text" placeholder="Ask a question…" style="width:100%;padding:9px 12px" /></div>
    <div class="form-group"><label>OPTIONS</label>
      <div id="poll-opts">
        <input type="text" placeholder="Option 1" class="poll-opt" style="width:100%;padding:8px 10px;margin-bottom:6px" />
        <input type="text" placeholder="Option 2" class="poll-opt" style="width:100%;padding:8px 10px;margin-bottom:6px" />
      </div>
      <button class="btn-secondary" style="font-size:12px;padding:5px 12px;margin-top:4px" id="poll-add-opt">+ Add Option</button>
    </div>
    <button class="btn-primary full-width" id="poll-send">Send Poll</button>
  </div>`;
  document.body.appendChild(modal);

  modal.querySelector("#poll-add-opt").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "Option " + (modal.querySelectorAll(".poll-opt").length + 1);
    inp.className = "poll-opt";
    inp.style.cssText = "width:100%;padding:8px 10px;margin-bottom:6px;background:var(--bg-input);border:1.5px solid transparent;border-radius:6px;color:var(--text-primary);font-family:inherit";
    modal.querySelector("#poll-opts").appendChild(inp);
  });

  modal.querySelector("#poll-send").addEventListener("click", async () => {
    const question = modal.querySelector("#poll-q").value.trim();
    const options  = [...modal.querySelectorAll(".poll-opt")].map(i => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) { showToast("Need a question and at least 2 options.", "error"); return; }

    const myUid = AppState.currentUser.uid;
    const profile = AppState.userProfile;
    const msg = {
      senderUid: myUid, username: profile.username, avatar: profile.avatar || "",
      type: "poll", question, options, votes: {}, timestamp: Date.now(), edited: false,
    };

    let ref;
    if (window._chatMode === "dm" && AppState.activeDM) {
      ref = db.ref("dms/" + AppState.activeDM.chatId).push();
    } else if (AppState.activeServer && AppState.activeChannel) {
      ref = db.ref("messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id).push();
    } else { showToast("Open a channel first.", "error"); return; }

    await ref.set(msg);
    document.getElementById("poll-modal").remove();
    showToast("Poll sent! 📊");
  });
}

function buildPollEl(msg, msgId, mode) {
  const div = document.createElement("div");
  div.className = "poll-card";

  const myUid  = AppState.currentUser.uid;
  const votes  = msg.votes || {};
  const myVote = Object.entries(votes).find(([uid]) => uid === myUid);
  const myOptI = myVote ? parseInt(myVote[1]) : -1;
  const total  = Object.keys(votes).length;

  div.innerHTML = "<div class='poll-question'>" + escapeHtml(msg.question) + "</div>";

  (msg.options || []).forEach((opt, i) => {
    const count = Object.values(votes).filter(v => v == i).length;
    const pct   = total > 0 ? Math.round(count / total * 100) : 0;
    const voted = myOptI === i;

    const btn = document.createElement("button");
    btn.className = "poll-option" + (voted ? " voted" : "");
    btn.innerHTML =
      "<div class='poll-bar' style='width:" + pct + "%'></div>" +
      "<span class='poll-opt-label'>" + escapeHtml(opt) + "</span>" +
      "<span class='poll-opt-pct'>" + pct + "% (" + count + ")</span>";

    btn.addEventListener("click", async () => {
      const ref = mode === "dm"
        ? db.ref("dms/" + AppState.activeDM.chatId + "/" + msgId + "/votes/" + myUid)
        : db.ref("messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id + "/" + msgId + "/votes/" + myUid);
      if (voted) await ref.remove();
      else        await ref.set(i);
    });

    div.appendChild(btn);
  });

  const footer = document.createElement("div");
  footer.className = "poll-footer";
  footer.textContent = total + " vote" + (total !== 1 ? "s" : "");
  div.appendChild(footer);

  return div;
}

// ══════════════════════════════════════════════════════════════
//  PROFILE DECORATIONS (banner, nameplate, frame)
// ══════════════════════════════════════════════════════════════
const BANNERS = [
  { id:"none",     label:"None",          style:"" },
  { id:"brand",    label:"Spark Blue",    style:"background:linear-gradient(135deg,#5865F2,#7289da)" },
  { id:"sunset",   label:"Sunset",        style:"background:linear-gradient(135deg,#f97316,#ec4899,#8b5cf6)" },
  { id:"forest",   label:"Forest",        style:"background:linear-gradient(135deg,#064e3b,#10b981)" },
  { id:"ocean",    label:"Ocean",         style:"background:linear-gradient(135deg,#0c4a6e,#0ea5e9)" },
  { id:"fire",     label:"Fire",          style:"background:linear-gradient(135deg,#7f1d1d,#ef4444,#f97316)" },
  { id:"galaxy",   label:"Galaxy",        style:"background:linear-gradient(135deg,#1e1b4b,#7c3aed,#ec4899,#1e1b4b)" },
  { id:"gold",     label:"Gold",          style:"background:linear-gradient(135deg,#78350f,#f59e0b,#fef3c7,#f59e0b)" },
];

const FRAMES = [
  { id:"none",     label:"None",     style:"" },
  { id:"brand",    label:"Blue",     style:"border:3px solid #5865F2;box-shadow:0 0 0 3px rgba(88,101,242,0.4)" },
  { id:"gold",     label:"Gold",     style:"border:3px solid #f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,0.4)" },
  { id:"fire",     label:"Fire",     style:"border:3px solid #ef4444;box-shadow:0 0 0 6px rgba(239,68,68,0.25)" },
  { id:"rainbow",  label:"Rainbow",  style:"border:3px solid transparent;background-clip:padding-box;outline:3px solid transparent;animation:rainbow-border 3s linear infinite" },
  { id:"success",  label:"Green",    style:"border:3px solid #23a55a;box-shadow:0 0 0 3px rgba(35,165,90,0.4)" },
];

const NAMEPLATES = [
  { id:"none",     label:"None",     style:"" },
  { id:"og",       label:"⚡ OG",     style:"background:linear-gradient(90deg,#5865F2,#7289da);color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800" },
  { id:"pro",      label:"✨ Pro",    style:"background:linear-gradient(90deg,#f59e0b,#fef3c7);color:#78350f;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800" },
  { id:"mod",      label:"🛡️ Mod",   style:"background:var(--brand);color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800" },
  { id:"fire",     label:"🔥 Fire",  style:"background:linear-gradient(90deg,#7f1d1d,#ef4444);color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800" },
];

function openDecorationsModal() {
  const existing = document.getElementById("deco-modal");
  if (existing) existing.remove();

  const p = AppState.userProfile || {};
  const currentBanner    = p.banner    || "none";
  const currentFrame     = p.frame     || "none";
  const currentNameplate = p.nameplate || "none";

  const modal = document.createElement("div");
  modal.id = "deco-modal";
  modal.className = "modal-overlay";

  const bannerOpts   = BANNERS.map(b =>
    `<button class="deco-opt ${currentBanner===b.id?"active":""}" data-type="banner" data-id="${b.id}" style="${b.style};min-width:80px;height:36px;border-radius:6px;border:2px solid ${currentBanner===b.id?"var(--brand)":"var(--divider)"};cursor:pointer;font-size:11px;font-weight:600;color:${b.id==="none"?"var(--text-muted)":"#fff"}">${b.label}</button>`).join("");
  const frameOpts    = FRAMES.map(f =>
    `<button class="deco-opt ${currentFrame===f.id?"active":""}" data-type="frame" data-id="${f.id}" style="padding:6px 12px;border-radius:6px;border:2px solid ${currentFrame===f.id?"var(--brand)":"var(--divider)"};background:var(--bg-tertiary);cursor:pointer;font-size:12px;font-weight:600;color:var(--text-primary)">${f.label}</button>`).join("");
  const nameplateOpts= NAMEPLATES.map(n =>
    `<button class="deco-opt ${currentNameplate===n.id?"active":""}" data-type="nameplate" data-id="${n.id}" style="padding:4px 10px;border-radius:6px;border:2px solid ${currentNameplate===n.id?"var(--brand)":"var(--divider)"};background:var(--bg-tertiary);cursor:pointer;font-size:12px">${n.label}</button>`).join("");

  modal.innerHTML = `<div class="modal modal-wide">
    <div class="modal-header"><h3>✨ Profile Decorations</h3>
      <button class="modal-close" onclick="document.getElementById('deco-modal').remove()">✕</button></div>
    <div class="form-group"><label>BANNER</label><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${bannerOpts}</div></div>
    <div class="form-group"><label>AVATAR FRAME</label><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${frameOpts}</div></div>
    <div class="form-group"><label>NAMEPLATE</label><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${nameplateOpts}</div></div>
    <button class="btn-primary full-width" id="deco-save" style="margin-top:8px">Save Decorations</button>
  </div>`;
  document.body.appendChild(modal);

  let selected = { banner: currentBanner, frame: currentFrame, nameplate: currentNameplate };

  modal.querySelectorAll(".deco-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      selected[type] = btn.dataset.id;
      modal.querySelectorAll("[data-type='" + type + "']").forEach(b => {
        b.style.borderColor = b.dataset.id === selected[type] ? "var(--brand)" : "var(--divider)";
      });
    });
  });

  modal.querySelector("#deco-save").addEventListener("click", async () => {
    const uid = AppState.currentUser.uid;
    await db.ref("users/" + uid).update({ banner: selected.banner, frame: selected.frame, nameplate: selected.nameplate });
    Object.assign(AppState.userProfile, selected);
    document.getElementById("deco-modal").remove();
    showToast("Decorations saved! ✨", "success");
  });
}

// Apply decorations to a profile popup or avatar display
function applyDecorationsToAvatar(avatarEl, profile) {
  if (!profile) return;
  const frame = FRAMES.find(f => f.id === (profile.frame || "none"));
  if (frame && frame.style) {
    avatarEl.style.cssText += ";" + frame.style.replace(/;/g, ";");
  }
}

function getNameplateHTML(profile) {
  if (!profile || !profile.nameplate || profile.nameplate === "none") return "";
  const np = NAMEPLATES.find(n => n.id === profile.nameplate);
  if (!np || !np.style) return "";
  return "<span style='" + np.style + "'>" + np.label + "</span>";
}

function getBannerStyle(profile) {
  if (!profile || !profile.banner || profile.banner === "none") return "background:linear-gradient(135deg,var(--brand),#7289da)";
  const b = BANNERS.find(b => b.id === profile.banner);
  return b ? b.style : "";
}
