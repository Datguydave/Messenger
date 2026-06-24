// auth.js — username + password only auth
//
// Firebase Auth requires an email address internally.
// We never ask the user for one. Instead we turn the username
// into a synthetic email:  slugify(username) + "@spark.local"
//
// slugify: replaces every non-alphanumeric char with _XX (hex code)
// so it is safe for Firebase DB keys and email local-parts.

// ── email helper (slugify is defined in firebase.js) ─────────────────
function toEmail(username) {
  return slugify(username) + "@spark.local";
}

// ── UI refs ───────────────────────────────────────────────────────────
const authScreen    = document.getElementById("auth-screen");
const appEl         = document.getElementById("app");
const loginView     = document.getElementById("login-view");
const registerView  = document.getElementById("register-view");
const loginError    = document.getElementById("login-error");
const registerError = document.getElementById("register-error");

// ── Toggle views ──────────────────────────────────────────────────────
document.getElementById("go-register").addEventListener("click", e => {
  e.preventDefault();
  loginView.classList.remove("active");
  registerView.classList.add("active");
  loginError.textContent = "";
});
document.getElementById("go-login").addEventListener("click", e => {
  e.preventDefault();
  registerView.classList.remove("active");
  loginView.classList.add("active");
  registerError.textContent = "";
});

// ── Avatar file label ─────────────────────────────────────────────────
document.getElementById("reg-avatar").addEventListener("change", function () {
  document.getElementById("reg-avatar-name").textContent =
    this.files[0] ? this.files[0].name : "No file chosen";
});

// ── REGISTER ─────────────────────────────────────────────────────────
document.getElementById("register-btn").addEventListener("click", doRegister);
document.getElementById("reg-username").addEventListener("keydown", e => { if (e.key === "Enter") doRegister(); });
document.getElementById("reg-password").addEventListener("keydown", e => { if (e.key === "Enter") doRegister(); });

async function doRegister() {
  const username   = document.getElementById("reg-username").value.trim();
  const password   = document.getElementById("reg-password").value;
  const avatarFile = document.getElementById("reg-avatar").files[0];
  registerError.textContent = "";

  // Basic validation
  if (!username)          { registerError.textContent = "Please enter a username."; return; }
  if (username.length < 2){ registerError.textContent = "Username must be at least 2 characters."; return; }
  if (username.length > 32){ registerError.textContent = "Username can be at most 32 characters."; return; }
  if (!password)          { registerError.textContent = "Please enter a password."; return; }
  if (password.length < 6){ registerError.textContent = "Password must be at least 6 characters."; return; }

  setBtnLoading("register-btn", true);

  const slug  = slugify(username);
  const email = toEmail(username);

  // Check if username is taken (DB read — open rules so this always works)
  try {
    const snap = await db.ref("usernames/" + slug).get();
    if (snap.exists()) {
      registerError.textContent = "That username is already taken. Try another.";
      setBtnLoading("register-btn", false);
      return;
    }
  } catch (e) {
    // DB unreachable — show actionable message
    registerError.textContent = dbError(e);
    setBtnLoading("register-btn", false);
    return;
  }

  // Create Firebase Auth account
  let uid;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    uid = cred.user.uid;
  } catch (e) {
    registerError.textContent = authError(e.code);
    setBtnLoading("register-btn", false);
    return;
  }

  // Upload optional avatar
  let avatarUrl = "";
  if (avatarFile) {
    try { avatarUrl = await uploadAvatar(avatarFile, uid); }
    catch (e) { console.warn("Avatar upload skipped:", e.message); }
  }

  // Write profile
  const profile = {
    uid, username, slug,
    avatar: avatarUrl, about: "",
    status: "Online", online: true,
    createdAt: Date.now(),
  };
  try {
    await db.ref("users/" + uid).set(profile);
    await db.ref("usernames/" + slug).set(uid);
  } catch (e) {
    console.warn("Profile DB write failed:", e.message);
    // Non-fatal — onAuthStateChanged will create a fallback profile
  }

  setBtnLoading("register-btn", false);
  // onAuthStateChanged fires and opens the app automatically
}

// ── LOGIN ─────────────────────────────────────────────────────────────
document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("login-username").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  loginError.textContent = "";

  if (!username) { loginError.textContent = "Please enter your username."; return; }
  if (!password) { loginError.textContent = "Please enter your password."; return; }

  setBtnLoading("login-btn", true);

  const email = toEmail(username);

  // Sign in directly — no DB pre-check needed
  // (wrong username → wrong email → Firebase says invalid-credential)
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // Success: onAuthStateChanged fires and opens the app
  } catch (e) {
    // Translate Firebase error codes to user-friendly messages
    if (e.code === "auth/user-not-found" || e.code === "auth/invalid-credential" || e.code === "auth/wrong-password") {
      loginError.textContent = "Username or password is incorrect.";
    } else {
      loginError.textContent = authError(e.code);
    }
    setBtnLoading("login-btn", false);
  }
}

// ── LOGOUT ────────────────────────────────────────────────────────────
document.getElementById("logout-btn").addEventListener("click", async () => {
  const uid = AppState.currentUser && AppState.currentUser.uid;
  if (uid) {
    try { await db.ref("onlineUsers/" + uid).remove(); } catch(e){}
    try { await db.ref("users/" + uid + "/online").set(false); } catch(e){}
  }
  AppState.clearListeners();
  await auth.signOut();
});

// ── AUTH STATE OBSERVER ───────────────────────────────────────────────
auth.onAuthStateChanged(async user => {
  if (user) {
    AppState.currentUser = user;

    let profile = null;
    try { profile = await fetchProfile(user.uid); } catch(e) {}

    if (!profile) {
      // Fallback: derive display name from the synthetic email
      const fallbackName = user.email.replace("@spark.local", "").replace(/_[0-9a-f]{2}/g, " ").trim();
      profile = {
        uid: user.uid,
        username: fallbackName || "User",
        slug: user.email.replace("@spark.local", ""),
        avatar: "", about: "", status: "Online", online: true,
        createdAt: Date.now(),
      };
      try { await db.ref("users/" + user.uid).set(profile); } catch(e) {}
    }

    AppState.userProfile = profile;
    setupPresence(user.uid);

    authScreen.classList.add("hidden");
    appEl.classList.remove("hidden");

    initUserBar();
    initNotifications();
    initFriends();
    initServers();
    initSettings();
    if (typeof initCalling === "function") initCalling();
    if (typeof initActivityTracking === "function") initActivityTracking();
    if (typeof requestNotifPermission === "function") requestNotifPermission();
    if (typeof initPasteAttachment === "function") initPasteAttachment();

  } else {
    AppState.currentUser = null;
    AppState.userProfile = null;
    authScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
    document.getElementById("welcome-view").classList.add("active");
    document.getElementById("chat-view").classList.remove("active");
  }
});

// ── PRESENCE ──────────────────────────────────────────────────────────
function setupPresence(uid) {
  const presenceRef  = db.ref("onlineUsers/" + uid);
  const connectedRef = db.ref(".info/connected");

  connectedRef.on("value", snap => {
    if (!snap.val()) return;
    presenceRef.onDisconnect().remove();
    presenceRef.set({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    db.ref("users/" + uid + "/online").set(true);
  });

  window.addEventListener("beforeunload", () => {
    presenceRef.remove();
    db.ref("users/" + uid + "/online").set(false);
  });
}

// ── ERROR HELPERS ─────────────────────────────────────────────────────
function authError(code) {
  const map = {
    "auth/email-already-in-use":    "That username is already registered.",
    "auth/invalid-email":           "Username produced an invalid key — try a different username.",
    "auth/weak-password":           "Password must be at least 6 characters.",
    "auth/user-not-found":          "Username or password is incorrect.",
    "auth/wrong-password":          "Username or password is incorrect.",
    "auth/invalid-credential":      "Username or password is incorrect.",
    "auth/too-many-requests":       "Too many attempts. Please wait a few minutes.",
    "auth/network-request-failed":  "Network error — check your internet connection.",
    "auth/operation-not-allowed":
      "⚠️ Email/Password sign-in is disabled in Firebase. " +
      "Go to Firebase Console → Authentication → Sign-in methods → " +
      "Email/Password and turn it ON.",
    "auth/configuration-not-found":
      "⚠️ Firebase project not found. Check the config in firebase.js.",
  };
  return map[code] || ("Error: " + code);
}

function dbError(e) {
  const msg = (e && e.message) ? e.message.toLowerCase() : "";
  if (msg.includes("permission") || msg.includes("denied")) {
    return "⚠️ Database permission denied. " +
      "Go to Firebase Console → Realtime Database → Rules " +
      "and replace all the rules with the contents of database.rules.json, then click Publish.";
  }
  return "⚠️ Could not reach the database. " +
    "Make sure Realtime Database is created in your Firebase Console " +
    "(Firebase Console → Realtime Database → Create database).";
}

// ── BUTTON LOADING ────────────────────────────────────────────────────
function setBtnLoading(id, loading) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._orig = btn.innerHTML;
    btn.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:8px">' +
      '<span style="width:15px;height:15px;border:2px solid rgba(255,255,255,.35);' +
      'border-top-color:#fff;border-radius:50%;display:inline-block;' +
      'animation:spin .7s linear infinite"></span>Please wait…</span>';
  } else {
    if (btn._orig) btn.innerHTML = btn._orig;
  }
}

// ── USER BAR ──────────────────────────────────────────────────────────
function initUserBar() {
  const p        = AppState.userProfile;
  const nameEl   = document.getElementById("my-username-bar");
  const statusEl = document.getElementById("my-status-bar");
  const avatarEl = document.getElementById("my-avatar-bar");
  const dotEl    = document.getElementById("my-status-dot");

  nameEl.textContent   = p.username;
  statusEl.textContent = p.status || "Online";
  renderAvatar(avatarEl, p);
  setStatusDot(dotEl, p.status || "Online");

  db.ref("users/" + p.uid).on("value", snap => {
    if (!snap.exists()) return;
    const u = snap.val();
    AppState.userProfile = u;
    nameEl.textContent   = u.username;
    statusEl.textContent = u.status || "Online";
    renderAvatar(avatarEl, u);
    setStatusDot(dotEl, u.status || "Online");
  });
}

function setStatusDot(dotEl, status) {
  dotEl.className = "status-dot";
  if      (status === "Online")           dotEl.classList.add("online");
  else if (status === "Idle")             dotEl.classList.add("idle");
  else if (status === "Do Not Disturb")   dotEl.classList.add("dnd");
  else                                    dotEl.classList.add("offline");
}
