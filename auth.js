// auth.js — sign-up, login, logout, online presence

// ── UI refs ──────────────────────────────────────────────────────────
const authScreen   = document.getElementById("auth-screen");
const appEl        = document.getElementById("app");
const loginView    = document.getElementById("login-view");
const registerView = document.getElementById("register-view");
const loginError   = document.getElementById("login-error");
const registerError= document.getElementById("register-error");

// ── Toggle views ────────────────────────────────────────────────────
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

// ── Avatar file label ────────────────────────────────────────────────
document.getElementById("reg-avatar").addEventListener("change", function() {
  document.getElementById("reg-avatar-name").textContent =
    this.files[0] ? this.files[0].name : "No file chosen";
});

// ── Register ─────────────────────────────────────────────────────────
document.getElementById("register-btn").addEventListener("click", async () => {
  const email    = document.getElementById("reg-email").value.trim();
  const username = document.getElementById("reg-username").value.trim();
  const password = document.getElementById("reg-password").value;
  const avatarFile = document.getElementById("reg-avatar").files[0];

  registerError.textContent = "";

  if (!email || !username || !password) {
    registerError.textContent = "Please fill in all required fields."; return;
  }
  if (username.length < 2) {
    registerError.textContent = "Username must be at least 2 characters."; return;
  }
  if (password.length < 6) {
    registerError.textContent = "Password must be at least 6 characters."; return;
  }

  // Check username uniqueness
  const snap = await db.ref("usernames").child(username.toLowerCase()).get();
  if (snap.exists()) {
    registerError.textContent = "That username is already taken."; return;
  }

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const uid  = cred.user.uid;

    let avatarUrl = "";
    if (avatarFile) {
      try { avatarUrl = await uploadAvatar(avatarFile, uid); }
      catch(e) { console.warn("Avatar upload failed", e); }
    }

    const profile = {
      uid, username, email,
      avatar:    avatarUrl,
      about:     "",
      status:    "Online",
      online:    true,
      createdAt: Date.now(),
    };

    await db.ref(`users/${uid}`).set(profile);
    await db.ref(`usernames/${username.toLowerCase()}`).set(uid);

  } catch(err) {
    registerError.textContent = friendlyAuthError(err.code);
  }
});

// ── Login ─────────────────────────────────────────────────────────────
document.getElementById("login-btn").addEventListener("click", async () => {
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  loginError.textContent = "";

  if (!email || !password) { loginError.textContent = "Please enter email and password."; return; }

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch(err) {
    loginError.textContent = friendlyAuthError(err.code);
  }
});

// Enter key on login/register
["login-email","login-password"].forEach(id =>
  document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("login-btn").click(); })
);
["reg-email","reg-username","reg-password"].forEach(id =>
  document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("register-btn").click(); })
);

// ── Logout ────────────────────────────────────────────────────────────
document.getElementById("logout-btn").addEventListener("click", async () => {
  if (AppState.currentUser) {
    await db.ref(`onlineUsers/${AppState.currentUser.uid}`).remove();
    await db.ref(`users/${AppState.currentUser.uid}/online`).set(false);
  }
  AppState.clearListeners();
  await auth.signOut();
});

// ── Auth state observer ──────────────────────────────────────────────
auth.onAuthStateChanged(async user => {
  if (user) {
    AppState.currentUser = user;

    // Fetch / create profile
    let profile = await fetchProfile(user.uid);
    if (!profile) {
      profile = {
        uid: user.uid,
        username: user.email.split("@")[0],
        email: user.email,
        avatar: "", about: "", status: "Online", online: true,
        createdAt: Date.now(),
      };
      await db.ref(`users/${user.uid}`).set(profile);
    }
    AppState.userProfile = profile;

    // Presence system
    setupPresence(user.uid);

    // Show app
    authScreen.classList.add("hidden");
    appEl.classList.remove("hidden");

    // Boot subsystems
    initUserBar();
    initNotifications();
    initFriends();
    initServers();
    initSettings();

  } else {
    AppState.currentUser = null;
    AppState.userProfile = null;
    authScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
    document.getElementById("welcome-view").classList.add("active");
    document.getElementById("chat-view").classList.remove("active");
  }
});

// ── Presence ──────────────────────────────────────────────────────────
function setupPresence(uid) {
  const presenceRef  = db.ref(`onlineUsers/${uid}`);
  const connectedRef = db.ref(".info/connected");

  connectedRef.on("value", snap => {
    if (!snap.val()) return;
    presenceRef.onDisconnect().remove();
    presenceRef.set({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    db.ref(`users/${uid}/online`).set(true);
  });

  // Update user status on page close
  window.addEventListener("beforeunload", () => {
    presenceRef.remove();
    db.ref(`users/${uid}/online`).set(false);
  });
}

// ── Error codes → friendly messages ─────────────────────────────────
function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use":    "That email is already registered.",
    "auth/invalid-email":           "Please enter a valid email address.",
    "auth/weak-password":           "Password must be at least 6 characters.",
    "auth/user-not-found":          "No account found with that email.",
    "auth/wrong-password":          "Incorrect password.",
    "auth/too-many-requests":       "Too many attempts. Please try again later.",
    "auth/network-request-failed":  "Network error. Check your connection.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

// ── User bar ──────────────────────────────────────────────────────────
function initUserBar() {
  const p = AppState.userProfile;
  const nameEl   = document.getElementById("my-username-bar");
  const statusEl = document.getElementById("my-status-bar");
  const avatarEl = document.getElementById("my-avatar-bar");
  const dotEl    = document.getElementById("my-status-dot");

  nameEl.textContent   = p.username;
  statusEl.textContent = p.status || "Online";
  renderAvatar(avatarEl, p);

  const dot = document.getElementById("my-status-dot");
  setStatusDot(dot, p.status || "Online");

  // Live updates to own profile
  db.ref(`users/${p.uid}`).on("value", snap => {
    if (!snap.exists()) return;
    const updated = snap.val();
    AppState.userProfile = updated;
    nameEl.textContent   = updated.username;
    statusEl.textContent = updated.status || "Online";
    renderAvatar(avatarEl, updated);
    setStatusDot(dotEl, updated.status || "Online");
  });
}

function setStatusDot(dotEl, status) {
  dotEl.className = "status-dot";
  if (status === "Online")          dotEl.classList.add("online");
  else if (status === "Idle")       dotEl.classList.add("idle");
  else if (status === "Do Not Disturb") dotEl.classList.add("dnd");
  else                              dotEl.classList.add("offline");
}
