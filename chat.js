// chat.js — realtime messaging
//
// KEY DESIGN: we use child_added / child_changed / child_removed
// instead of on("value") so we never re-render the whole list.
// Each event appends / updates / removes exactly one message element.

// ── Module state ──────────────────────────────────────────────────────
let _chatMode          = null;   // "dm" | "server"
let _pendingAttachment = null;
let _editingMessageId  = null;
let _typingTimeout     = null;
let _lastSenderUid     = null;
let _lastTimestamp     = 0;
let _messageRef        = null;   // current Firebase ref being listened to

// ── Emoji picker setup ────────────────────────────────────────────────
const EMOJIS = [
  "😀","😂","🥰","😍","🤩","😎","🥳","🤔","😢","😭",
  "😡","🤯","🥺","😴","🤗","😏","🙄","😬","🤫","😤",
  "👋","👍","👎","❤️","🔥","✨","🎉","💯","👀","🙏",
  "😈","💀","🎮","⚡","🌟","💬","🏆","🤝","💪","🚀",
];

const emojiPicker = document.getElementById("emoji-picker");
EMOJIS.forEach(emoji => {
  const btn = document.createElement("button");
  btn.textContent = emoji;
  btn.addEventListener("click", () => {
    document.getElementById("message-input").value += emoji;
    document.getElementById("message-input").focus();
    emojiPicker.classList.add("hidden");
  });
  emojiPicker.appendChild(btn);
});

document.getElementById("emoji-btn").addEventListener("click", e => {
  e.stopPropagation();
  emojiPicker.classList.toggle("hidden");
});
document.addEventListener("click", () => emojiPicker.classList.add("hidden"));

// ── Attachment ────────────────────────────────────────────────────────
document.getElementById("attach-btn").addEventListener("click", () =>
  document.getElementById("attach-file-input").click());

document.getElementById("attach-file-input").addEventListener("change", function () {
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
  const input = document.getElementById("message-input");
  const text  = input.value.trim();
  if (!text && !_pendingAttachment) return;

  const myUid   = AppState.currentUser.uid;
  const profile = AppState.userProfile;

  // Build DB ref
  let ref;
  if (_chatMode === "dm" && AppState.activeDM) {
    ref = db.ref("dms/" + AppState.activeDM.chatId).push();
  } else if (_chatMode === "server" && AppState.activeServer && AppState.activeChannel) {
    ref = db.ref("messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id).push();
  } else return;

  const msg = {
    senderUid: myUid,
    username:  profile.username,
    avatar:    profile.avatar || "",
    content:   text,
    timestamp: Date.now(),
    edited:    false,
  };

  if (_pendingAttachment) {
    try {
      showToast("Uploading…");
      const chatPath = _chatMode === "dm"
        ? "dm_" + AppState.activeDM.chatId
        : "srv_" + AppState.activeServer.id + "_" + AppState.activeChannel.id;
      const att = await uploadAttachment(_pendingAttachment.file, chatPath);
      msg.attachmentUrl  = att.url;
      msg.attachmentType = att.type;
      msg.attachmentName = att.name;
    } catch (e) { showToast("Attachment failed.", "error"); }
    _pendingAttachment = null;
    document.getElementById("attachment-preview").classList.add("hidden");
  }

  input.value = "";
  clearTypingIndicator();
  await ref.set(msg);
  notifyOthers();
}

// ── Load messages (switch channel / DM) ──────────────────────────────
function loadMessages(mode) {
  _chatMode = mode;
  _editingMessageId = null;
  _lastSenderUid    = null;
  _lastTimestamp    = 0;

  // Detach previous listener
  if (_messageRef) {
    _messageRef.off();
    _messageRef = null;
  }

  const listEl = document.getElementById("messages-list");
  listEl.innerHTML = "";

  // Stop typing listener from old channel
  stopTypingListener();

  if (mode === "dm" && AppState.activeDM) {
    _messageRef = db.ref("dms/" + AppState.activeDM.chatId).orderByChild("timestamp").limitToLast(100);
  } else if (mode === "server" && AppState.activeServer && AppState.activeChannel) {
    _messageRef = db.ref(
      "messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id
    ).orderByChild("timestamp").limitToLast(100);
  } else return;

  // ── child_added: fires once per existing message on attach,
  //    then again for each new message as it arrives ──
  _messageRef.on("child_added", snap => {
    const msg = { id: snap.key, ...snap.val() };
    appendMessage(msg, listEl, mode);
    scrollToBottom();
  });

  // ── child_changed: edit or reaction update ──
  _messageRef.on("child_changed", snap => {
    const msg = { id: snap.key, ...snap.val() };
    updateMessageEl(msg, listEl, mode);
  });

  // ── child_removed: deletion ──
  _messageRef.on("child_removed", snap => {
    const el = listEl.querySelector("[data-msg-id='" + snap.key + "']");
    if (el) el.remove();
  });

  if (mode === "server") startTypingListener();
}

// ── Append a single message to the list ──────────────────────────────
function appendMessage(msg, listEl, mode) {
  const isCompact =
    msg.senderUid === _lastSenderUid &&
    (msg.timestamp - _lastTimestamp) < 5 * 60 * 1000;

  _lastSenderUid = msg.senderUid;
  _lastTimestamp = msg.timestamp;

  // Remove empty-state placeholder if present
  const placeholder = listEl.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  listEl.appendChild(buildMessageEl(msg, isCompact, mode));
}

// ── Update an existing message element in place ───────────────────────
function updateMessageEl(msg, listEl, mode) {
  const existing = listEl.querySelector("[data-msg-id='" + msg.id + "']");
  if (!existing) return;
  const contentEl = existing.querySelector(".msg-content");
  if (contentEl) {
    contentEl.textContent = msg.content || "";
    contentEl.className   = "msg-content" + (msg.edited ? " edited" : "");
  }
}

function scrollToBottom() {
  const wrap = document.querySelector(".messages-wrap");
  if (!wrap) return;
  // Only auto-scroll if user is near the bottom
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 200;
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
}

// ── Build a message DOM element ───────────────────────────────────────
function buildMessageEl(msg, compact, mode) {
  const myUid = AppState.currentUser.uid;
  const group = document.createElement("div");
  group.className = "message-group" + (compact ? " compact" : "");
  group.dataset.msgId = msg.id;

  // Avatar column
  const avatarDiv = document.createElement("div");
  avatarDiv.className = "msg-avatar";
  if (!compact) {
    if (msg.avatar) {
      const img = document.createElement("img");
      img.src = msg.avatar; img.alt = msg.username || "";
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
    const meta   = document.createElement("div");
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
  content.className = "msg-content" + (msg.edited ? " edited" : "");
  content.textContent = msg.content || "";
  body.appendChild(content);

  // Attachment
  if (msg.attachmentUrl) {
    const attDiv = document.createElement("div");
    attDiv.className = "msg-attachment";
    if (msg.attachmentType === "image") {
      const img = document.createElement("img");
      img.src = msg.attachmentUrl; img.alt = msg.attachmentName || "image";
      attDiv.appendChild(img);
    } else if (msg.attachmentType === "video") {
      const vid = document.createElement("video");
      vid.src = msg.attachmentUrl; vid.controls = true;
      attDiv.appendChild(vid);
    } else {
      const a = document.createElement("a");
      a.href = msg.attachmentUrl; a.target = "_blank";
      a.className = "attachment-file";
      a.textContent = "📎 " + (msg.attachmentName || "Download");
      attDiv.appendChild(a);
    }
    body.appendChild(attDiv);
  }

  // Reactions
  const reactDiv = document.createElement("div");
  reactDiv.className = "msg-reactions";
  reactDiv.id = "reactions-" + msg.id;
  if (msg.reactions) renderReactions(reactDiv, msg.id, msg.reactions, mode);
  body.appendChild(reactDiv);

  // Hover actions
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const reactBtn = document.createElement("button");
  reactBtn.title = "React"; reactBtn.textContent = "😊";
  reactBtn.addEventListener("click", e => { e.stopPropagation(); showReactionPicker(e, msg.id, mode); });
  actions.appendChild(reactBtn);

  if (msg.senderUid === myUid) {
    const editBtn = document.createElement("button");
    editBtn.title = "Edit"; editBtn.textContent = "✏️";
    editBtn.addEventListener("click", () => startEditMessage(msg, content, mode));
    actions.appendChild(editBtn);
  }

  if (msg.senderUid === myUid || isServerMod()) {
    const delBtn = document.createElement("button");
    delBtn.title = "Delete"; delBtn.textContent = "🗑️";
    delBtn.addEventListener("click", () => deleteMessage(msg.id, mode));
    actions.appendChild(delBtn);
  }

  body.appendChild(actions);
  group.appendChild(avatarDiv);
  group.appendChild(body);
  return group;
}

function isServerMod() {
  if (!AppState.activeServer) return false;
  return AppState.activeServer.data.owner === AppState.currentUser.uid;
}

// ── Edit ─────────────────────────────────────────────────────────────
function startEditMessage(msg, contentEl, mode) {
  if (_editingMessageId) return;
  _editingMessageId = msg.id;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "msg-edit-input";
  input.value = msg.content;

  const hint = document.createElement("div");
  hint.className = "msg-edit-hint";
  hint.innerHTML = "Press <kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel";

  const cancel = () => {
    hint.remove(); input.replaceWith(contentEl); _editingMessageId = null;
  };

  input.addEventListener("keydown", async e => {
    if (e.key === "Escape") { cancel(); return; }
    if (e.key === "Enter") {
      const newText = input.value.trim();
      if (!newText) return;
      const ref = mode === "dm"
        ? db.ref("dms/" + AppState.activeDM.chatId + "/" + msg.id)
        : db.ref("messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id + "/" + msg.id);
      await ref.update({ content: newText, edited: true });
      hint.remove(); input.replaceWith(contentEl); _editingMessageId = null;
    }
  });

  contentEl.replaceWith(input);
  input.parentNode.insertBefore(hint, input.nextSibling);
  input.focus();
}

// ── Delete ────────────────────────────────────────────────────────────
async function deleteMessage(msgId, mode) {
  if (!confirm("Delete this message?")) return;
  const ref = mode === "dm"
    ? db.ref("dms/" + AppState.activeDM.chatId + "/" + msgId)
    : db.ref("messages/" + AppState.activeServer.id + "/" + AppState.activeChannel.id + "/" + msgId);
  await ref.remove();
}

// ── Reactions ────────────────────────────────────────────────────────
const REACTION_EMOJIS = ["👍","👎","❤️","😂","🔥","🎉","😮","😢","😡","💯"];
let _reactionPickerEl = null;

function showReactionPicker(e, msgId, mode) {
  if (_reactionPickerEl) _reactionPickerEl.remove();
  const picker = document.createElement("div");
  picker.style.cssText =
    "position:fixed;z-index:300;background:var(--bg-secondary);" +
    "border:1px solid var(--divider-strong);border-radius:10px;" +
    "padding:8px;display:flex;flex-wrap:wrap;gap:4px;width:244px;" +
    "box-shadow:var(--shadow-lg);";
  picker.style.top  = (e.clientY - 60) + "px";
  picker.style.left = e.clientX + "px";
  REACTION_EMOJIS.forEach(emoji => {
    const btn = document.createElement("button");
    btn.style.cssText = "font-size:22px;cursor:pointer;width:36px;height:36px;border-radius:6px;";
    btn.textContent = emoji;
    btn.onmouseenter = () => btn.style.background = "var(--bg-hover)";
    btn.onmouseleave = () => btn.style.background = "";
    btn.addEventListener("click", () => {
      toggleReaction(msgId, emoji, mode);
      picker.remove(); _reactionPickerEl = null;
    });
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
  const key   = mode === "dm"
    ? "dm_" + AppState.activeDM.chatId + "_" + msgId
    : "srv_" + AppState.activeServer.id + "_" + AppState.activeChannel.id + "_" + msgId;
  const ref   = db.ref("reactions/" + key + "/" + emoji + "/" + myUid);
  const snap  = await ref.get();
  if (snap.exists()) await ref.remove(); else await ref.set(true);

  const allSnap = await db.ref("reactions/" + key).get();
  const div     = document.getElementById("reactions-" + msgId);
  if (div) renderReactions(div, msgId, allSnap.exists() ? allSnap.val() : {}, mode);
}

function renderReactions(container, msgId, reactions, mode) {
  container.innerHTML = "";
  const myUid = AppState.currentUser.uid;
  Object.entries(reactions || {}).forEach(([emoji, users]) => {
    const count = Object.keys(users).length;
    if (!count) return;
    const pill = document.createElement("button");
    pill.className = "reaction-pill" + (users[myUid] ? " mine" : "");
    pill.innerHTML = emoji + " <span>" + count + "</span>";
    pill.addEventListener("click", () => toggleReaction(msgId, emoji, mode));
    container.appendChild(pill);
  });
}

// ── Typing indicator ──────────────────────────────────────────────────
let _typingRef     = null;
let _typingOffFn   = null;

document.getElementById("message-input").addEventListener("input", () => {
  if (_chatMode !== "server" || !AppState.activeServer || !AppState.activeChannel) return;
  const myUid = AppState.currentUser.uid;
  const ref   = db.ref("typing/" + AppState.activeServer.id + "/" + AppState.activeChannel.id + "/" + myUid);
  ref.set(true);
  clearTimeout(_typingTimeout);
  _typingTimeout = setTimeout(() => ref.remove(), 3000);
});

function clearTypingIndicator() {
  clearTimeout(_typingTimeout);
  if (_chatMode !== "server" || !AppState.activeServer || !AppState.activeChannel) return;
  const myUid = AppState.currentUser.uid;
  db.ref("typing/" + AppState.activeServer.id + "/" + AppState.activeChannel.id + "/" + myUid).remove();
}

function stopTypingListener() {
  if (_typingRef && _typingOffFn) { _typingRef.off("value", _typingOffFn); }
  _typingRef = null; _typingOffFn = null;
  const el = document.getElementById("typing-indicator");
  if (el) el.innerHTML = "";
}

function startTypingListener() {
  if (!AppState.activeServer || !AppState.activeChannel) return;
  const sid    = AppState.activeServer.id;
  const cid    = AppState.activeChannel.id;
  const myUid  = AppState.currentUser.uid;
  const el     = document.getElementById("typing-indicator");

  _typingRef = db.ref("typing/" + sid + "/" + cid);
  _typingOffFn = async snap => {
    if (!snap.exists()) { el.innerHTML = ""; return; }
    const uids = Object.keys(snap.val()).filter(u => u !== myUid);
    if (!uids.length) { el.innerHTML = ""; return; }
    const names = await Promise.all(uids.map(async uid => {
      const p = await fetchProfile(uid); return p ? p.username : "Someone";
    }));
    const text = names.length === 1
      ? names[0] + " is typing"
      : names.slice(0, -1).join(", ") + " and " + names.at(-1) + " are typing";
    el.innerHTML =
      "<span class='typing-dots'><span></span><span></span><span></span></span> " +
      "<strong>" + escapeHtml(text) + "…</strong>";
  };
  _typingRef.on("value", _typingOffFn);
}

// ── Chat search ────────────────────────────────────────────────────────
document.getElementById("chat-search").addEventListener("input", function () {
  const q = this.value.toLowerCase();
  document.querySelectorAll(".message-group").forEach(el => {
    const c = el.querySelector(".msg-content");
    el.style.display = (!q || (c && c.textContent.toLowerCase().includes(q))) ? "" : "none";
  });
});

// ── Notify other members of new message ───────────────────────────────
async function notifyOthers() {
  if (_chatMode !== "server" || !AppState.activeServer || !AppState.activeChannel) return;
  const sid   = AppState.activeServer.id;
  const cid   = AppState.activeChannel.id;
  const myUid = AppState.currentUser.uid;
  const snap  = await db.ref("serverMembers/" + sid).get();
  if (!snap.exists()) return;
  const updates = {};
  Object.keys(snap.val()).forEach(uid => {
    if (uid !== myUid) {
      updates["notifications/" + uid + "/channels/" + cid + "/unread"] =
        firebase.database.ServerValue.increment(1);
      updates["notifications/" + uid + "/channels/" + cid + "/sid"] = sid;
    }
  });
  await db.ref().update(updates);
}
