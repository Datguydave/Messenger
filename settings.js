// settings.js — user settings modal: profile, status, theme

function initSettings() {
  // Open settings
  document.getElementById("open-settings-btn").addEventListener("click", openSettingsModal);

  // Avatar preview on file select
  document.getElementById("settings-avatar-input").addEventListener("change", function() {
    const file = this.files[0];
    if (!file) return;
    const preview = document.getElementById("settings-avatar-preview");
    const reader  = new FileReader();
    reader.onload  = e => {
      preview.innerHTML = `<img src="${e.target.result}" alt="preview" />`;
    };
    reader.readAsDataURL(file);
  });

  // Save profile
  document.getElementById("save-profile-btn").addEventListener("click", saveProfile);

  // Save status
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

  // Load saved theme
  const savedTheme = localStorage.getItem("spark-theme") || "dark";
  document.documentElement.dataset.theme = savedTheme;
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.theme === savedTheme);
  });
}

function openSettingsModal() {
  const p = AppState.userProfile;

  // Pre-fill fields
  document.getElementById("settings-username").value = p.username || "";
  document.getElementById("settings-about").value    = p.about    || "";

  // Avatar preview
  const preview = document.getElementById("settings-avatar-preview");
  if (p.avatar) {
    preview.innerHTML = `<img src="${p.avatar}" alt="avatar" />`;
  } else {
    preview.textContent = (p.username || "?")[0].toUpperCase();
    preview.style.background = stringToColor(p.username || "?");
  }

  // Status radio
  const status = p.status || "Online";
  const radio  = document.querySelector(`input[name="status-radio"][value="${status}"]`);
  if (radio) radio.checked = true;

  openModal("settings-modal");
}

async function saveProfile() {
  const uid      = AppState.currentUser.uid;
  const username = document.getElementById("settings-username").value.trim();
  const about    = document.getElementById("settings-about").value.trim();
  const msgEl    = document.getElementById("settings-profile-msg");
  const avatarFile = document.getElementById("settings-avatar-input").files[0];
  msgEl.textContent = "";

  if (!username) { msgEl.textContent = "Username cannot be empty."; msgEl.style.color="#f38888"; return; }
  if (username.length < 2) { msgEl.textContent = "Username must be at least 2 characters."; msgEl.style.color="#f38888"; return; }

  // Check username uniqueness if changed
  const oldUsername = AppState.userProfile.username;
  if (username !== oldUsername) {
    const snap = await db.ref(`usernames/${username.toLowerCase()}`).get();
    if (snap.exists() && snap.val() !== uid) {
      msgEl.textContent = "That username is taken."; msgEl.style.color="#f38888"; return;
    }
  }

  const updates = { username, about };

  // Upload new avatar
  if (avatarFile) {
    try {
      const url = await uploadAvatar(avatarFile, uid);
      updates.avatar = url;
    } catch(e) {
      msgEl.textContent = "Avatar upload failed."; msgEl.style.color="#f38888"; return;
    }
  }

  // Update username index
  if (username !== oldUsername) {
    await db.ref(`usernames/${oldUsername.toLowerCase()}`).remove();
    await db.ref(`usernames/${username.toLowerCase()}`).set(uid);
  }

  await db.ref(`users/${uid}`).update(updates);
  AppState.userProfile = { ...AppState.userProfile, ...updates };

  msgEl.textContent  = "Profile saved!";
  msgEl.style.color  = "#23a55a";
  showToast("Profile updated! ✅", "success");

  // Reset file input
  document.getElementById("settings-avatar-input").value = "";
}

async function saveStatus() {
  const uid    = AppState.currentUser.uid;
  const radio  = document.querySelector('input[name="status-radio"]:checked');
  if (!radio) return;
  const status = radio.value;
  await db.ref(`users/${uid}/status`).set(status);
  AppState.userProfile.status = status;
  showToast(`Status set to ${status}`, "success");
}
