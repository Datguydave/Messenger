// notifications.js — live unread badges on channels + server rail

function initNotifications() {
  const myUid = AppState.currentUser.uid;

  // Listen to ALL notifications for this user in real time
  db.ref("notifications/" + myUid + "/channels").on("value", snap => {
    let railTotals = {}; // sid → total unread

    if (!snap.exists()) {
      clearAllBadges();
      return;
    }

    const data = snap.val();

    Object.entries(data).forEach(([cid, info]) => {
      const count = info.unread || 0;
      const sid   = info.sid   || null;

      // Update channel badge in sidebar
      setChannelBadge(cid, count);

      // Accumulate for server rail badge
      if (sid) {
        railTotals[sid] = (railTotals[sid] || 0) + count;
      }
    });

    // Update rail badges
    Object.entries(railTotals).forEach(([sid, total]) => {
      setRailBadge(sid, total);
    });
  });

  // Patch selectChannel to clear unread when opening a channel
  // We do this by watching AppState.activeChannel changes via a proxy
  // Instead: channels.js calls clearChannelUnread directly (see channels.js)
}

function setChannelBadge(cid, count) {
  const badge = document.getElementById("ch-badge-" + cid);
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : count;
  badge.classList.toggle("hidden", count <= 0);
}

function setRailBadge(sid, count) {
  const badge = document.getElementById("rail-badge-" + sid);
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : count;
  badge.classList.toggle("hidden", count <= 0);
}

function clearAllBadges() {
  document.querySelectorAll(".notif-badge").forEach(b => b.classList.add("hidden"));
  document.querySelectorAll("[id^='ch-badge-']").forEach(b => b.classList.add("hidden"));
}

// Called from channels.js when user opens a channel
async function clearChannelUnread(cid) {
  const myUid = AppState.currentUser.uid;
  await db.ref("notifications/" + myUid + "/channels/" + cid + "/unread").set(0);
  setChannelBadge(cid, 0);
}
