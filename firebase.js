// firebase.js — initialise Firebase and export shared references

const firebaseConfig = {
  apiKey: "AIzaSyD0VtiBMbVx04EO-Y6DP0YScmTkskaVtko",
  authDomain: "messenger-ac442.firebaseapp.com",
  databaseURL: "https://messenger-ac442-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "messenger-ac442",
  storageBucket: "messenger-ac442.firebasestorage.app",
  messagingSenderId: "303428987686",
  appId: "1:303428987686:web:bdb5bbbea2d73db62befe7",
  measurementId: "G-ZWY454GJJH"
};

firebase.initializeApp(firebaseConfig);

const auth    = firebase.auth();
const db      = firebase.database();
const storage = firebase.storage();

// ── Global app state ────────────────────────────────────────────────
const AppState = {
  currentUser:    null,   // firebase auth user
  userProfile:    null,   // db profile object
  activeServer:   null,   // { id, data }
  activeChannel:  null,   // { id, data }
  activeDM:       null,   // { chatId, otherUid }
  membersVisible: true,
  // cleanup listeners
  _listeners: [],
};

// Register a listener cleanup function so we can detach on navigation
AppState.registerListener = function(fn) { this._listeners.push(fn); };
AppState.clearListeners   = function() {
  this._listeners.forEach(fn => fn());
  this._listeners = [];
};

// ── Utility helpers ──────────────────────────────────────────────────

/** Show a toast notification */
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast${type ? " " + type : ""}`;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3000);
}

/** Generate avatar initials element or image */
function renderAvatar(container, profile, size = 32) {
  container.innerHTML = "";
  if (profile && profile.avatar) {
    const img = document.createElement("img");
    img.src = profile.avatar;
    img.alt = profile.username || "?";
    container.appendChild(img);
  } else {
    const letter = (profile && profile.username) ? profile.username[0].toUpperCase() : "?";
    container.textContent = letter;
    container.style.background = stringToColor(profile && profile.username ? profile.username : "?");
  }
}

/** Deterministic colour from string */
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h},55%,40%)`;
}

/** Format a Firebase timestamp (ms) into HH:MM */
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today at ${hhmm}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hhmm;
}

/** Escape HTML to prevent XSS */
function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/** Build DM chat ID (always lexicographic) */
function buildChatId(uid1, uid2) {
  return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

/** Open / close a modal */
function openModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

/** Show context menu at position */
function showContextMenu(x, y, items) {
  const menu = document.getElementById("context-menu");
  const itemsEl = document.getElementById("context-menu-items");
  itemsEl.innerHTML = "";
  items.forEach(item => {
    if (item === "divider") {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      itemsEl.appendChild(d);
    } else {
      const el = document.createElement("div");
      el.className = `ctx-item${item.danger ? " danger" : ""}`;
      el.textContent = item.label;
      el.onclick = () => { hideContextMenu(); item.action(); };
      itemsEl.appendChild(el);
    }
  });
  menu.style.left = x + "px";
  menu.style.top  = y + "px";
  menu.classList.remove("hidden");
}
function hideContextMenu() { document.getElementById("context-menu").classList.add("hidden"); }

/** Fetch a user profile once */
async function fetchProfile(uid) {
  const snap = await db.ref(`users/${uid}`).get();
  return snap.exists() ? snap.val() : null;
}

// Dismiss context menu + profile popup on outside click
document.addEventListener("click", (e) => {
  if (!document.getElementById("context-menu").contains(e.target)) hideContextMenu();
  if (!document.getElementById("profile-popup").contains(e.target)) {
    document.getElementById("profile-popup").classList.add("hidden");
  }
});

// Modal close buttons (data-close attribute)
document.querySelectorAll(".modal-close").forEach(btn => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});

// Tab switching inside modals
document.querySelectorAll(".modal-tabs .tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset.tab;
    if (!tabId) return;
    const modal = btn.closest(".modal");
    modal.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    modal.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(tabId).classList.add("active");
  });
});

// Settings nav
document.querySelectorAll(".settings-nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const sectionId = btn.dataset.section;
    document.querySelectorAll(".settings-nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".settings-section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(sectionId).classList.add("active");
  });
});

// Image lightbox
document.addEventListener("click", e => {
  if (e.target.matches(".msg-attachment img")) {
    const ov = document.createElement("div");
    ov.className = "img-viewer-overlay";
    const img = document.createElement("img");
    img.src = e.target.src;
    ov.appendChild(img);
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
});
