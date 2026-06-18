// settings.js — user settings: profile, status, theme

function initSettings() {
  document.getElementById("open-settings-btn").addEventListener("click", openSettingsModal);

  // Live avatar preview on file select
  document.getElementById("settings-avatar-input").addEventListener("change", function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const preview = document.getElementById("settings-avatar-preview");
      preview.innerHTML = "<img src='" + e.target.result + "' alt='preview' />";
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("save-profile-btn").addEventListener("click", saveProfile);
  document.getElementById("save-status-btn").addEventListener("click", saveStatus);

  // Theme switcher
  document.querySelectorAll(".theme-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".theme-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.documentElement.dataset.theme = btn.dataset.theme;
      localStorage.setItem("spark-theme", btn.dataset.theme);
    });
  });

  // Restore saved theme
  const saved = localStorage.getItem("spark-theme") || "dark";
  document.documentElement.dataset.theme = saved;
  document.querySelectorAll(".theme-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.theme === saved));
}

function openSettingsModal() {
  const p = AppState.userProfile;

  document.getElementById("settings-username").value = p.username || "";
  document.getElementById("settings-about").value    = p.about    || "";

  const preview = document.getElementById("settings-avatar-preview");
  if (p.avatar) {
    preview.innerHTML = "<img src='" + p.avatar + "' alt='avatar' />";
  } else {
    preview.textContent = (p.username || "?")[0].toUpperCase();
    preview.style.background = stringToColor(p.username || "?");
  }

  // Set status radio
  const status = p.status || "Online";
  const radio  = document.querySelector("input[name='status-radio'][value='" + status + "']");
  if (radio) radio.checked = true;

  openModal("settings-modal");
}

async function saveProfile() {
  const uid        = AppState.currentUser.uid;
  const username   = document.getElementById("settings-username").value.trim();
  const about      = document.getElementById("settings-about").value.trim();
  const avatarFile = document.getElementById("settings-avatar-input").files[0];
  const msgEl      = document.getElementById("settings-profile-msg");
  msgEl.textContent  = "";
  msgEl.style.color  = "#f38888";

  if (!username)          { msgEl.textContent = "Username cannot be empty."; return; }
  if (username.length < 2){ msgEl.textContent = "Username must be at least 2 characters."; return; }
  if (username.length > 32){ msgEl.textContent = "Username must be 32 characters or fewer."; return; }

  const newSlug = slugify(username);
  const oldSlug = slugify(AppState.userProfile.username || "");

  // Check uniqueness if username changed
  if (newSlug !== oldSlug) {
    const snap = await db.ref("usernames/" + newSlug).get();
    if (snap.exists() && snap.val() !== uid) {
      msgEl.textContent = "That username is already taken."; return;
    }
  }

  const updates = { username, about, slug: newSlug };

  // Process new avatar (compress to base64)
  if (avatarFile) {
    try {
      updates.avatar = await uploadAvatar(avatarFile, uid);
    } catch (e) {
      msgEl.textContent = "Avatar upload failed. Try a smaller image."; return;
    }
  }

  // Update username index
  if (newSlug !== oldSlug) {
    await db.ref("usernames/" + oldSlug).remove();
    await db.ref("usernames/" + newSlug).set(uid);
  }

  await db.ref("users/" + uid).update(updates);
  AppState.userProfile = { ...AppState.userProfile, ...updates };

  msgEl.style.color  = "#23a55a";
  msgEl.textContent  = "✅ Profile saved!";
  document.getElementById("settings-avatar-input").value = "";
  showToast("Profile updated!", "success");
}

async function saveStatus() {
  const uid   = AppState.currentUser.uid;
  const radio = document.querySelector("input[name='status-radio']:checked");
  if (!radio) return;
  const status = radio.value;
  await db.ref("users/" + uid + "/status").set(status);
  AppState.userProfile.status = status;
  showToast("Status set to " + status, "success");
}
