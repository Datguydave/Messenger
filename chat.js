// chat.js — realtime messaging, editing, reactions, typing, emoji

// ── State ─────────────────────────────────────────────────────────────
let _pendingAttachment = null; // { file, url, type, name }
let _editingMessageId  = null;
let _typingTimeout     = null;

// ── Emoji set ────────────────────────────────────────────────────────
const EMOJIS = [
  "😀","😂","🥰","😍","🤩","😎","🥳","🤔","😢","😭",
  "😡","🤯","🥺","😴","🤗","😏","🙄","😬","🤫","😤",
  "👋","👍","👎","❤️","🔥","✨","🎉","💯","👀","🙏",
  "😈","💀","🎮","⚡","🌟","💬","🏆","🤝","💪","🚀",
];

// ── Build the emoji picker ────────────────────────────────────────────
const emojiPicker = document.getElementById("emoji-picker");
EMOJIS.forEach(emoji => {
  const btn = document.createElement("button");
  btn.textContent = emoji;
  btn.addEventListener("click", () => {
    const input = document.getElementById("message-input");
    input.value += emoji;
    input.focus();
    emojiPicker.classList.add("hidden");
  });
  emojiPicker.appendChild(btn);
});

document.getElementById("emoji-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle("hidden");
});
document.addEventListener("click", () => emojiPicker.classList.add("hidden"));

// ── Attachment ────────────────────────────────────────────────────────
document.getElementById("attach-btn").addEventListener("click", () => {
  document.getElementById("attach-file-input").click();
});

document.getElementById("attach-file-input").addEventListener("change", async function() {
  const file = this.files[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { showToast("Max file size is 25 MB.", "error"); return; }

  _pendingAttachment = { file };
  document.getElementById("attachment-preview-name").textContent = file.name;
  document.getElementById("attachment-preview").classList.remove("hidden");
  this.value = "";
});

document.getElementById("clear-attachment").addEventListener("click", () => {
  _pendingAttachment = null;
  document.getElementById("attachment-preview").classList.add("hidden");
});

// ── Send message ──────────────────────────────────────────────────────
document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("message-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function sendMessage() {
  const input   = document.getElementById("message-input");
  const text    = input.value.trim();
  if (!text && !_pendingAttachment) return;

  const myUid   = AppState.currentUser.uid;
  const profile = AppState.userProfile;

  let msgRef;
  if (AppState.activeDM) {
    msgRef = db.ref(`dms/${AppState.activeDM.chatId}`).push();
  } else if (AppState.activeServer && AppState.activeChannel) {
    msgRef = db.ref(`messages/${AppState.activeServer.id}/${AppState.activeChannel.id}`).push();
  } else return;

  const msg = {
    senderUid: myUid,
    username:  profile.username,
    avatar:    profile.avatar || "",
    content:   text,
    timestamp: Date.now(),
    edited:    false,
  };

  // Upload attachment if any
  if (_pendingAttachment) {
    try {
      showToast("Uploading attachment…");
      let path = AppState.activeDM
        ? `dm_${AppState.activeDM.chatId}`
        : `server_${AppState.activeServer.id}_${AppState.activeChannel.id}`;
      const att = await uploadAttachment(_pendingAttachment.file, path);
      msg.attachmentUrl  = att.url;
      msg.attachmentType = att.type;
      msg.attachmentName = att.name;
    } catch(e) { showToast("Attachment upload failed.", "error"); }
    _pendingAttachment = null;
    document.getElementById("attachment-preview").classList.add("hidden");
  }

  input.value = "";
  clearTypingIndicator();

  await msgRef.set(msg);
  incrementUnreadForOthers();
}

// ── Load / listen to messages ─────────────────────────────────────────
function loadMessages(mode) {
  // Clear previous listener
  AppState.clearListeners();
  _editingMessageId = null;

  const listEl = document.getElementById("messages-list");
  listEl.innerHTML = "";

  let messagesRef;
  if (mode === "dm") {
    messagesRef = db.ref(`dms/${AppState.activeDM.chatId}`);
  } else {
    messagesRef = db.ref(`messages/${AppState.activeServer.id}/${AppState.activeChannel.id}`);
  }

  const off = () => messagesRef.off();
  AppState.registerListener(off);

  // Load last 100 messages
  messagesRef.orderByChild("timestamp").limitToLast(100).on("value", snap => {
    listEl.innerHTML = "";
    if (!snap.exists()) {
      listEl.innerHTML = `<div style="color:var(--text-muted);padding:32px 16px;text-align:center">
        No messages yet. Say hello! 👋</div>`;
      return;
    }

    const msgs = [];
    snap.forEach(child => msgs.push({ id: child.key, ...child.val() }));
    renderMessages(msgs, listEl, mode);

    // Scroll to bottom
    setTimeout(() => {
      const wrap = document.querySelector(".messages-wrap");
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    }, 50);
  });

  // Listen to new messages only (for notification)
  messagesRef.orderByChild("timestamp").startAt(Date.now()).on("child_added", snap => {
    const msg = snap.val();
    if (msg.senderUid === AppState.currentUser.uid) return;
    // Check for mention
    const myUsername = AppState.userProfile.username.toLowerCase();
    if (msg.content && msg.content.toLowerCase().includes(`@${myUsername}`)) {
      showToast(`📣 ${msg.username} mentioned you!`);
    }
  });

  // Typing indicator
  if (mode === "server") {
    listenTyping();
  }
}

// ── Render message list ───────────────────────────────────────────────
function renderMessages(msgs, listEl, mode) {
  let lastSender = null;
  let lastTimestamp = 0;

  msgs.forEach((msg, idx) => {
    const isCompact = msg.senderUid === lastSender &&
      (msg.timestamp - lastTimestamp) < 5 * 60 * 1000;
    listEl.appendChild(buildMessageEl(msg, isCompact, mode));
    lastSender    = msg.senderUid;
    lastTimestamp = msg.timestamp;
  });
}

function buildMessageEl(msg, compact, mode) {
  const myUid   = AppState.currentUser.uid;
  const group   = document.createElement("div");
  group.className = `message-group${compact ? " compact" : ""}`;
  group.dataset.msgId = msg.id;

  // Avatar
  const avatarDiv = document.createElement("div");
  avatarDiv.className = "msg-avatar";
  avatarDiv.style.marginTop = compact ? "0" : "2px";
  if (!compact) {
    if (msg.avatar) {
      const img = document.createElement("img");
      img.src = msg.avatar;
      img.alt = msg.username;
      avatarDiv.appendChild(img);
    } else {
      avatarDiv.textContent = (msg.username || "?")[0].toUpperCase();
      avatarDiv.style.background = stringToColor(msg.username || "?");
    }
    avatarDiv.addEventListener("click", () => showProfile(msg.senderUid, avatarDiv));
  }

  // Body
  const body = document.createElement("div");
  body.className = "msg-body";

  if (!compact) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const author = document.createElement("span");
    author.className = "msg-author";
    author.textContent = msg.username || "Unknown";
    author.addEventListener("click", () => showProfile(msg.senderUid, author));
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(author);
    meta.appendChild(time);
    body.appendChild(meta);
  }

  // Content
  const content = document.createElement("div");
  content.className = `msg-content${msg.edited ? " edited" : ""}`;
  content.textContent = msg.content || "";
  body.appendChild(content);

  // Attachment
  if (msg.attachmentUrl) {
    const attDiv = document.createElement("div");
    attDiv.className = "msg-attachment";
    if (msg.attachmentType === "image") {
      const img = document.createElement("img");
      img.src = msg.attachmentUrl;
      img.alt = msg.attachmentName || "image";
      attDiv.appendChild(img);
    } else if (msg.attachmentType === "video") {
      const vid = document.createElement("video");
      vid.src  = msg.attachmentUrl;
      vid.controls = true;
      attDiv.appendChild(vid);
    } else {
      const link = document.createElement("a");
      link.href = msg.attachmentUrl;
      link.target = "_blank";
      link.className = "attachment-file";
      link.textContent = `📎 ${msg.attachmentName || "Download"}`;
      attDiv.appendChild(link);
    }
    body.appendChild(attDiv);
  }

  // Reactions
  const reactionsDiv = document.createElement("div");
  reactionsDiv.className = "msg-reactions";
  reactionsDiv.id = `reactions-${msg.id}`;
  if (msg.reactions) renderReactions(reactionsDiv, msg.id, msg.reactions);
  body.appendChild(reactionsDiv);

  // Actions bar (appears on hover)
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "msg-actions";

  // React
  const reactBtn = document.createElement("button");
  reactBtn.title = "Add Reaction";
  reactBtn.textContent = "😊";
  reactBtn.addEventListener("click", (e) => { e.stopPropagation(); showReactionPicker(e, msg.id, mode); });
  actionsDiv.appendChild(reactBtn);

  // Edit (own messages only)
  if (msg.senderUid === myUid && !msg.attachmentUrl) {
    const editBtn = document.createElement("button");
    editBtn.title = "Edit";
    editBtn.innerHTML = "✏️";
    editBtn.addEventListener("click", () => startEditMessage(msg, content, mode));
    actionsDiv.appendChild(editBtn);
  }

  // Delete (own messages or moderator+)
  if (msg.senderUid === myUid || canModerate()) {
    const delBtn = document.createElement("button");
    delBtn.title = "Delete";
    delBtn.innerHTML = "🗑️";
    delBtn.addEventListener("click", () => deleteMessage(msg.id, mode));
    actionsDiv.appendChild(delBtn);
  }

  group.appendChild(avatarDiv);
  body.appendChild(actionsDiv);
  group.appendChild(body);
  return group;
}

function canModerate() {
  if (!AppState.activeServer) return false;
  const myUid = AppState.currentUser.uid;
  if (AppState.activeServer.data.owner === myUid) return true;
  return false;
}

// ── Edit message ──────────────────────────────────────────────────────
function startEditMessage(msg, contentEl, mode) {
  if (_editingMessageId) return; // only one edit at a time
  _editingMessageId = msg.id;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "msg-edit-input";
  input.value = msg.content;

  const hint = document.createElement("div");
  hint.className = "msg-edit-hint";
  hint.innerHTML = "Press <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel";

  contentEl.replaceWith(input);
  contentEl.after && input.after(hint);
  input.focus();

  const cancel = () => {
    hint.remove();
    input.replaceWith(contentEl);
    _editingMessageId = null;
  };

  input.addEventListener("keydown", async e => {
    if (e.key === "Escape") { cancel(); return; }
    if (e.key === "Enter") {
      const newText = input.value.trim();
      if (!newText) return;
      let ref;
      if (mode === "dm") ref = db.ref(`dms/${AppState.activeDM.chatId}/${msg.id}`);
      else ref = db.ref(`messages/${AppState.activeServer.id}/${AppState.activeChannel.id}/${msg.id}`);
      await ref.update({ content: newText, edited: true });
      hint.remove();
      contentEl.textContent = newText;
      contentEl.classList.add("edited");
      input.replaceWith(contentEl);
      _editingMessageId = null;
    }
  });

  // Append hint below input
  input.parentNode.insertBefore(hint, input.nextSibling);
}

// ── Delete message ────────────────────────────────────────────────────
async function deleteMessage(msgId, mode) {
  if (!confirm("Delete this message?")) return;
  if (mode === "dm") {
    await db.ref(`dms/${AppState.activeDM.chatId}/${msgId}`).remove();
  } else {
    await db.ref(`messages/${AppState.activeServer.id}/${AppState.activeChannel.id}/${msgId}`).remove();
  }
}

// ── Reactions ────────────────────────────────────────────────────────
const REACTION_EMOJIS = ["👍","👎","❤️","😂","🔥","🎉","😮","😢","😡","💯"];
let _reactionPickerEl = null;

function showReactionPicker(e, msgId, mode) {
  if (_reactionPickerEl) _reactionPickerEl.remove();

  const picker = document.createElement("div");
  picker.style.cssText = `
    position:fixed;z-index:300;
    background:var(--bg-secondary);border:1px solid var(--divider);
    border-radius:8px;padding:8px;display:flex;flex-wrap:wrap;gap:4px;
    width:240px;box-shadow:0 4px 20px rgba(0,0,0,.4);
  `;
  picker.style.top  = (e.clientY - 60) + "px";
  picker.style.left = e.clientX + "px";

  REACTION_EMOJIS.forEach(emoji => {
    const btn = document.createElement("button");
    btn.style.cssText = "font-size:22px;cursor:pointer;transition:transform .1s;";
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      toggleReaction(msgId, emoji, mode);
      picker.remove();
      _reactionPickerEl = null;
    });
    btn.addEventListener("mouseenter", () => btn.style.transform = "scale(1.3)");
    btn.addEventListener("mouseleave", () => btn.style.transform = "");
    picker.appendChild(btn);
  });

  document.body.appendChild(picker);
  _reactionPickerEl = picker;

  setTimeout(() => {
    document.addEventListener("click", () => { picker.remove(); _reactionPickerEl = null; }, { once: true });
  }, 0);
}

async function toggleReaction(msgId, emoji, mode) {
  const myUid = AppState.currentUser.uid;
  let reactionRef;
  if (mode === "dm") {
    reactionRef = db.ref(`reactions/dm_${AppState.activeDM.chatId}_${msgId}/${emoji}/${myUid}`);
  } else {
    reactionRef = db.ref(`reactions/srv_${AppState.activeServer.id}_${AppState.activeChannel.id}_${msgId}/${emoji}/${myUid}`);
  }

  const snap = await reactionRef.get();
  if (snap.exists()) await reactionRef.remove();
  else               await reactionRef.set(true);

  // Re-render reactions in the message
  const reactionKey = mode === "dm"
    ? `dm_${AppState.activeDM.chatId}_${msgId}`
    : `srv_${AppState.activeServer.id}_${AppState.activeChannel.id}_${msgId}`;

  const allSnap = await db.ref(`reactions/${reactionKey}`).get();
  const div = document.getElementById(`reactions-${msgId}`);
  if (div) renderReactions(div, msgId, allSnap.exists() ? allSnap.val() : {}, mode, reactionKey);
}

function renderReactions(container, msgId, reactions, mode, reactionKey) {
  container.innerHTML = "";
  const myUid = AppState.currentUser.uid;

  Object.entries(reactions || {}).forEach(([emoji, users]) => {
    const count = Object.keys(users).length;
    if (count === 0) return;

    const pill = document.createElement("button");
    pill.className = `reaction-pill${users[myUid] ? " mine" : ""}`;
    pill.innerHTML = `${emoji} <span>${count}</span>`;
    pill.addEventListener("click", () => {
      if (reactionKey) toggleReaction(msgId, emoji, mode);
    });
    container.appendChild(pill);
  });
}

// Live reaction updates
function listenReactions(msgId, mode) {
  const reactionKey = mode === "dm"
    ? `dm_${AppState.activeDM.chatId}_${msgId}`
    : `srv_${AppState.activeServer.id}_${AppState.activeChannel.id}_${msgId}`;

  db.ref(`reactions/${reactionKey}`).on("value", snap => {
    const div = document.getElementById(`reactions-${msgId}`);
    if (div) renderReactions(div, msgId, snap.exists() ? snap.val() : {}, mode, reactionKey);
  });
}

// ── Typing indicator ──────────────────────────────────────────────────
document.getElementById("message-input").addEventListener("input", () => {
  if (!AppState.activeServer || !AppState.activeChannel) return;
  const myUid = AppState.currentUser.uid;
  const ref   = db.ref(`typing/${AppState.activeServer.id}/${AppState.activeChannel.id}/${myUid}`);
  ref.set(true);

  clearTimeout(_typingTimeout);
  _typingTimeout = setTimeout(() => ref.remove(), 3000);
});

function clearTypingIndicator() {
  if (!AppState.activeServer || !AppState.activeChannel) return;
  const myUid = AppState.currentUser.uid;
  db.ref(`typing/${AppState.activeServer.id}/${AppState.activeChannel.id}/${myUid}`).remove();
  clearTimeout(_typingTimeout);
}

function listenTyping() {
  if (!AppState.activeServer || !AppState.activeChannel) return;
  const sid  = AppState.activeServer.id;
  const cid  = AppState.activeChannel.id;
  const myUid = AppState.currentUser.uid;
  const ref  = db.ref(`typing/${sid}/${cid}`);
  const el   = document.getElementById("typing-indicator");

  const offFn = () => ref.off();
  AppState.registerListener(offFn);

  ref.on("value", async snap => {
    if (!snap.exists()) { el.innerHTML = ""; el.classList.add("hidden"); return; }
    const typingUids = Object.keys(snap.val()).filter(u => u !== myUid);
    if (typingUids.length === 0) { el.innerHTML = ""; el.classList.add("hidden"); return; }

    const names = await Promise.all(typingUids.map(async uid => {
      const p = await fetchProfile(uid);
      return p ? p.username : "Someone";
    }));

    el.classList.remove("hidden");
    const text = names.length === 1 ? `${names[0]} is typing` :
      names.length === 2 ? `${names[0]} and ${names[1]} are typing` :
      `${names.slice(0,-1).join(", ")} and ${names.at(-1)} are typing`;

    el.innerHTML = `<span>•</span><span>•</span><span>•</span> <strong>${text}…</strong>`;
  });
}

// ── Chat search ────────────────────────────────────────────────────────
document.getElementById("chat-search").addEventListener("input", function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll(".message-group").forEach(el => {
    const content = el.querySelector(".msg-content");
    const text = content ? content.textContent.toLowerCase() : "";
    el.style.display = (!q || text.includes(q)) ? "" : "none";
  });
});

// ── Unread counter helpers ─────────────────────────────────────────────
async function incrementUnreadForOthers() {
  if (!AppState.activeServer || !AppState.activeChannel) return;
  const sid = AppState.activeServer.id;
  const cid = AppState.activeChannel.id;
  const myUid = AppState.currentUser.uid;

  const membersSnap = await db.ref(`serverMembers/${sid}`).get();
  if (!membersSnap.exists()) return;
  const updates = {};
  Object.keys(membersSnap.val()).forEach(uid => {
    if (uid !== myUid) {
      updates[`notifications/${uid}/channels/${cid}/unread`] = firebase.database.ServerValue.increment(1);
    }
  });
  await db.ref().update(updates);
}
