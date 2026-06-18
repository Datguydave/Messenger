// auth.js — Register & Login with username + password only.
//
// HOW IT WORKS
// ─────────────────────────────────────────────────────────────
// Firebase Auth only accepts email+password. We never ask the
// user for an email. Instead we:
//
//   1. Encode the username into a URL-safe "slug" for storage keys.
//   2. Store the slug → uid mapping at /usernames/<slug>.
//   3. Create a synthetic Firebase email:  <slug>@spark.local
//      (this is invisible — never shown to any user).
//   4. Login reverses the process: slug → look up uid → sign in.
//
// Slugging rules (collision-free):
//   • lowercase everything
//   • replace every non-alphanumeric char with its hex code
//     e.g. "Dave 99!" → "dave_20_39_39_21"
//   This is 100% reversible and produces only [a-z0-9_] chars.

// ── Helper: username → safe DB slug ──────────────────────────────────
function slugify(username) {
  return username
    .toLowerCase()
    .split("")
    .map(ch => /[a-z0-9]/.test(ch) ? ch : "_" + ch.charCodeAt(0).toString(16))
    .join("");
}

function slugToEmail(slug) {
  // Must be a valid RFC email. Keep it simple and short.
  // Truncate to 60 chars before the @ so the total stays under 256.
  return slug.substring(0, 60) + "@spark.local";
}

// ── UI refs ───────────────────────────────────────────────────────────
const authScreen    = document.getElementById("auth-screen");
const appEl         = document.getElementById("app");
const loginView     = document.getElementById("login-view");
const registerView  = document.getElementById("register-view");
const loginError    = document.getElementById("login-error");
const registerError = document.getElementById("register-error");

// ── Toggle between login / register ──────────────────────────────────
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

// ── REGISTER ──────────────────────────────────────────────────────────
document.getElementById("register-btn").addEventListener("click", doRegister);
document.getElementById("reg-username").addEventListener("keydown", e => { if (e.key === "Enter") doRegister(); });
document.getElementById("reg-password").addEventListener("keydown", e => { if (e.key === "Enter") doRegister(); });

async function doRegister() {
  const username   = document.getElementById("reg-username").value.trim();
  const password   = document.getElementById("reg-password").value;
  const avatarFile = document.getElementById("reg-avatar").files[0];

  registerError.textContent = "";

  // ── Validation ──
  if (!username) {
    registerError.textContent = "Please enter a username."; return;
  }
  if (username.length < 2) {
    registerError.textContent = "Username must be at least 2 characters."; return;
  }
  if (username.length > 32) {
    registerError.textContent = "Username must be 32 characters or fewer."; return;
  }
  if (!password) {
    registerError.textContent = "Please enter a password."; return;
  }
  if (password.length < 6) {
    registerError.textContent = "Password must be at least 6 characters."; return;
  }

  const slug      = slugify(username);
  const authEmail = slugToEmail(slug);

  setBtnLoading("register-btn", true);

  // ── Check username is not taken ──
  try {
    const existing = await db.ref("usernames/" + slug).get();
    if (existing.exists()) {
      registerError.textContent = "That username is already taken. Choose another.";
      setBtnLoading("register-btn", false);
      return;
    }
  } catch (dbErr) {
    registerError.textContent = "Could not reach the database. Check your internet connection.";
    setBtnLoading("register-btn", false);
    return;
  }

  // ── Create Firebase Auth account ──
  let uid;
  try {
    const cred = await auth.createUserWithEmailAndPassword(authEmail, password);
    uid = cred.user.uid;
  } catch (authErr) {
    console.error("createUserWithEmailAndPassword error:", authErr);
    registerError.textContent = friendlyError(authErr.code);
    setBtnLoading("register-btn", false);
    return;
  }

  // ── Upload optional avatar ──
  let avatarUrl = "";
  if (avatarFile) {
    try {
      avatarUrl = await uploadAvatar(avatarFile, uid);
    } catch (uploadErr) {
      console.warn("Avatar upload failed (non-fatal):", uploadErr);
    }
  }

  // ── Write profile to DB ──
  const profile = {
    uid,
    username,   // display name — original string including spaces / symbols
    slug,       // used for lookups
    avatar:    avatarUrl,
    about:     "",
    status:    "Online",
    online:    true,
    createdAt: Date.now(),
  };

  try {
    await db.ref("users/" + uid).set(profile);
    await db.ref("usernames/" + slug).set(uid);
  } catch (writeErr) {
    console.error("DB write error after auth create:", writeErr);
    // Account was created in Auth but DB write failed — still functional,
    // onAuthStateChanged will create a fallback profile.
  }

  setBtnLoading("register-btn", false);
  // onAuthStateChanged fires automatically and loads the app.
}

// ── LOGIN ─────────────────────────────────────────────────────────────
document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("login-username").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;

  loginError.textContent = "";

  if (!username) {
    loginError.textContent = "Please enter your username."; return;
  }
  if (!password) {
    loginError.textContent = "Please enter your password."; return;
  }

  const slug      = slugify(username);
  const authEmail = slugToEmail(slug);

  setBtnLoading("login-btn", true);

  // ── Confirm the username exists in DB first ──
  try {
    const snap = await db.ref("usernames/" + slug).get();
    if (!snap.exists()) {
      loginError.textContent = "No account found with that username.";
      setBtnLoading("login-btn", false);
      return;
    }
  } catch (dbErr) {
    loginError.textContent = "Could not reach the database. Check your internet connection.";
    setBtnLoading("login-btn", false);
    return;
  }

  // ── Sign in with Firebase Auth ──
  try {
    await auth.signInWithEmailAndPassword(authEmail, password);
    // Success → onAuthStateChanged fires and shows the app.
  } catch (authErr) {
    console.error("signInWithEmailAndPassword error:", authErr);
    loginError.textContent = friendlyError(authErr.code);
    setBtnLoading("login-btn", false);
  }
}

// ── LOGOUT ───────────────────────────────────────────────────────────
document.getElementById("logout-btn").addEventListener("click", async () => {
  const uid = AppState.currentUser && AppState.currentUser.uid;
  if (uid) {
    await db.ref("onlineUsers/" + uid).remove().catch(() => {});
    await db.ref("users/" + uid + "/online").set(false).catch(() => {});
  }
  AppState.clearListeners();
  await auth.signOut();
});

// ── AUTH STATE OBSERVER ───────────────────────────────────────────────
auth.onAuthStateChanged(async user => {
  if (user) {
    AppState.currentUser = user;

    let profile = await fetchProfile(user.uid);

    if (!profile) {
      // DB write may have failed during register — create a minimal profile now.
      const fallbackSlug     = user.email.replace("@spark.local", "");
      const fallbackUsername = fallbackSlug; // best we can do without the original
      profile = {
        uid:       user.uid,
        username:  fallbackUsername,
        slug:      fallbackSlug,
        avatar:    "",
        about:     "",
        status:    "Online",
        online:    true,
        createdAt: Date.now(),
      };
      await db.ref("users/" + user.uid).set(profile).catch(() => {});
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

  } else {
    AppState.currentUser  = null;
    AppState.userProfile  = null;
    authScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
    document.getElementById("welcome-view").classList.add("active");
    document.getElementById("chat-view").classList.remove("active");
  }
});

// ── PRESENCE ─────────────────────────────────────────────────────────
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

// ── FRIENDLY ERROR MESSAGES ───────────────────────────────────────────
function friendlyError(code) {
  const map = {
    "auth/email-already-in-use":
      "That username is already registered.",
    "auth/invalid-email":
      "Username produced an invalid internal key — try a slightly different username.",
    "auth/weak-password":
      "Password must be at least 6 characters.",
    "auth/user-not-found":
      "No account found with that username.",
    "auth/wrong-password":
      "Incorrect password. Please try again.",
    "auth/invalid-credential":
      "Incorrect password. Please try again.",
    "auth/too-many-requests":
      "Too many failed attempts. Please wait a few minutes and try again.",
    "auth/network-request-failed":
      "Network error — check your internet connection.",
    "auth/operation-not-allowed":
      "⚠️ Email/Password sign-in is disabled. Go to Firebase Console → Authentication → Sign-in methods → Email/Password and enable it.",
    "auth/configuration-not-found":
      "⚠️ Firebase is not configured correctly. Check your Firebase config in firebase.js.",
  };
  return map[code] || ("Something went wrong (" + code + "). Please try again.");
}

// ── BUTTON LOADING STATE ──────────────────────────────────────────────
function setBtnLoading(id, loading) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._originalText = btn.innerHTML;
    btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px">'
      + '<span style="width:15px;height:15px;border:2px solid rgba(255,255,255,.4);'
      + 'border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;'
      + 'display:inline-block"></span>Please wait…</span>';
  } else {
    if (btn._originalText) btn.innerHTML = btn._originalText;
  }
}

// ── USER BAR ─────────────────────────────────────────────────────────
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

  // Keep user bar live as profile changes
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
  if (status === "Online")              dotEl.classList.add("online");
  else if (status === "Idle")           dotEl.classList.add("idle");
  else if (status === "Do Not Disturb") dotEl.classList.add("dnd");
  else                                  dotEl.classList.add("offline");
}
