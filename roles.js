// roles.js — custom server roles, role-gated channels, role management

// ── DB structure ──────────────────────────────────────────────
// roles/<sid>/<roleId> → { name, color, permissions: { sendMessages, viewChannel } }
// channelRoles/<sid>/<cid>/<roleId> → true  (only these roles can use this channel)
// serverMembers/<sid>/<uid> → roleId (already exists, now points to custom role)

// ── Default roles every server gets ──────────────────────────
const DEFAULT_ROLES = [
  { name: "Owner",     color: "#f0a500", permissions: { admin: true, sendMessages: true, viewChannel: true } },
  { name: "Admin",     color: "#ed4245", permissions: { admin: true, sendMessages: true, viewChannel: true } },
  { name: "Moderator", color: "#5865F2", permissions: { admin: false, sendMessages: true, viewChannel: true } },
  { name: "Member",    color: "#b5bac1", permissions: { admin: false, sendMessages: true, viewChannel: true } },
];

async function ensureDefaultRoles(sid) {
  const snap = await db.ref("roles/" + sid).get();
  if (snap.exists()) return;
  const updates = {};
  DEFAULT_ROLES.forEach((r, i) => {
    updates["roles/" + sid + "/" + r.name.toLowerCase()] = r;
  });
  await db.ref().update(updates);
}

// ── Check if user can view/send in a channel ──────────────────
async function canUserAccessChannel(uid, sid, cid) {
  // Check if channel has role restrictions
  const restrictSnap = await db.ref("channelRoles/" + sid + "/" + cid).get();
  if (!restrictSnap.exists()) return true; // no restrictions

  // Get user's role
  const roleSnap = await db.ref("serverMembers/" + sid + "/" + uid).get();
  const userRole = roleSnap.val() || "member";

  // Owner/admin always pass
  if (["owner", "admin"].includes(userRole)) return true;

  // Check if user's role is in the allowed list
  return restrictSnap.child(userRole).exists();
}

async function canUserSendInChannel(uid, sid, cid) {
  return canUserAccessChannel(uid, sid, cid);
}

// ── Open Roles modal ──────────────────────────────────────────
async function openRolesModal(sid) {
  const myUid = AppState.currentUser.uid;
  const myRole = (await db.ref("serverMembers/" + sid + "/" + myUid).get()).val();
  if (!["owner", "admin"].includes(myRole)) {
    showToast("You need admin permissions to manage roles.", "error"); return;
  }

  // Ensure default roles exist
  await ensureDefaultRoles(sid);

  const existing = document.getElementById("roles-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "roles-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal modal-wide">
      <div class="modal-header">
        <h3>Manage Roles</h3>
        <button class="modal-close" onclick="document.getElementById('roles-modal').remove()">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:200px 1fr;gap:16px;min-height:320px">
        <div id="roles-list-panel" style="border-right:1px solid var(--divider);padding-right:16px">
          <div id="roles-list"></div>
          <button class="btn-secondary full-width" style="margin-top:10px;font-size:13px" id="add-role-btn">+ New Role</button>
        </div>
        <div id="role-editor" style="padding-left:4px">
          <p style="color:var(--text-muted);font-size:13px">Select a role to edit it.</p>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector("#add-role-btn").addEventListener("click", () => createNewRole(sid));
  await refreshRolesList(sid);
}

async function refreshRolesList(sid) {
  const snap = await db.ref("roles/" + sid).get();
  const list = document.getElementById("roles-list");
  if (!list) return;
  list.innerHTML = "";
  if (!snap.exists()) return;
  Object.entries(snap.val()).forEach(([roleId, role]) => {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;cursor:pointer;";
    item.innerHTML = `<span style="width:12px;height:12px;border-radius:50%;background:${role.color};flex-shrink:0"></span>
      <span style="flex:1;font-size:14px;font-weight:500">${escapeHtml(role.name)}</span>`;
    item.addEventListener("click", () => editRole(sid, roleId, role));
    item.addEventListener("mouseenter", () => item.style.background = "var(--bg-hover)");
    item.addEventListener("mouseleave", () => item.style.background = "");
    list.appendChild(item);
  });
}

function editRole(sid, roleId, role) {
  const editor = document.getElementById("role-editor");
  if (!editor) return;
  editor.innerHTML = `
    <div class="form-group"><label>ROLE NAME</label>
      <input id="re-name" type="text" value="${escapeHtml(role.name)}" style="width:100%;padding:9px 12px" /></div>
    <div class="form-group"><label>COLOUR</label>
      <input id="re-color" type="color" value="${role.color||"#b5bac1"}" style="width:48px;height:36px;border:none;background:none;cursor:pointer" /></div>
    <div class="form-group"><label>PERMISSIONS</label>
      <label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--divider);border-radius:6px;margin-bottom:6px;cursor:pointer">
        <input type="checkbox" id="re-admin" ${role.permissions&&role.permissions.admin?"checked":""} /> Administrator (all permissions)
      </label>
      <label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--divider);border-radius:6px;margin-bottom:6px;cursor:pointer">
        <input type="checkbox" id="re-send" ${!role.permissions||role.permissions.sendMessages!==false?"checked":""} /> Send Messages
      </label>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn-primary" id="re-save">Save</button>
      <button class="btn-danger" id="re-delete">Delete Role</button>
    </div>`;

  editor.querySelector("#re-save").addEventListener("click", async () => {
    const updated = {
      name: editor.querySelector("#re-name").value.trim() || role.name,
      color: editor.querySelector("#re-color").value,
      permissions: {
        admin: editor.querySelector("#re-admin").checked,
        sendMessages: editor.querySelector("#re-send").checked,
        viewChannel: true,
      },
    };
    await db.ref("roles/" + sid + "/" + roleId).set(updated);
    showToast("Role saved!", "success");
    await refreshRolesList(sid);
  });

  editor.querySelector("#re-delete").addEventListener("click", async () => {
    if (!confirm("Delete this role?")) return;
    await db.ref("roles/" + sid + "/" + roleId).remove();
    editor.innerHTML = "<p style='color:var(--text-muted);font-size:13px'>Role deleted.</p>";
    await refreshRolesList(sid);
  });
}

async function createNewRole(sid) {
  const id = "role_" + Date.now();
  const role = { name: "New Role", color: "#b5bac1", permissions: { admin: false, sendMessages: true, viewChannel: true } };
  await db.ref("roles/" + sid + "/" + id).set(role);
  await refreshRolesList(sid);
  editRole(sid, id, role);
}

// ── Assign role to member ──────────────────────────────────────
async function assignRoleToMember(sid, targetUid, roleId) {
  await db.ref("serverMembers/" + sid + "/" + targetUid).set(roleId);
  showToast("Role assigned!", "success");
}

// ── Channel permissions modal ──────────────────────────────────
async function openChannelPermissions(sid, cid, channelName) {
  const rolesSnap = await db.ref("roles/" + sid).get();
  const chanRolesSnap = await db.ref("channelRoles/" + sid + "/" + cid).get();
  const allowed = chanRolesSnap.exists() ? chanRolesSnap.val() : null;

  const existing = document.getElementById("chanperms-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "chanperms-modal";
  modal.className = "modal-overlay";

  let rolesHtml = "";
  if (rolesSnap.exists()) {
    Object.entries(rolesSnap.val()).forEach(([roleId, role]) => {
      const checked = !allowed || allowed[roleId] ? "checked" : "";
      rolesHtml += `<label style="display:flex;align-items:center;gap:10px;padding:10px;border:1.5px solid var(--divider);border-radius:6px;margin-bottom:6px;cursor:pointer">
        <input type="checkbox" data-role="${roleId}" ${checked} style="accent-color:var(--brand);width:16px;height:16px" />
        <span style="width:12px;height:12px;border-radius:50%;background:${role.color};flex-shrink:0"></span>
        <span>${escapeHtml(role.name)}</span>
      </label>`;
    });
  } else {
    rolesHtml = "<p style='color:var(--text-muted)'>No custom roles yet. Create roles in Server Settings → Roles.</p>";
  }

  modal.innerHTML = `<div class="modal modal-sm">
    <div class="modal-header"><h3>#${escapeHtml(channelName)} Permissions</h3>
      <button class="modal-close" onclick="document.getElementById('chanperms-modal').remove()">✕</button></div>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">Choose which roles can access this channel. If none are checked, everyone can access it.</p>
    <div id="chanperms-roles">${rolesHtml}</div>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0;color:var(--text-muted);font-size:13px;cursor:pointer">
      <input type="checkbox" id="chanperms-restrict" ${allowed ? "checked" : ""} style="accent-color:var(--brand)"> Restrict this channel to selected roles only
    </label>
    <button class="btn-primary full-width" id="chanperms-save">Save Permissions</button>
  </div>`;
  document.body.appendChild(modal);

  modal.querySelector("#chanperms-save").addEventListener("click", async () => {
    const restrict = modal.querySelector("#chanperms-restrict").checked;
    if (!restrict) {
      await db.ref("channelRoles/" + sid + "/" + cid).remove();
      showToast("Channel open to everyone.", "success");
    } else {
      const updates = {};
      modal.querySelectorAll("[data-role]").forEach(cb => {
        if (cb.checked) updates[cb.dataset.role] = true;
      });
      await db.ref("channelRoles/" + sid + "/" + cid).set(updates);
      showToast("Channel permissions saved!", "success");
    }
    document.getElementById("chanperms-modal").remove();
  });
}
