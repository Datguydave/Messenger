// notifications.js — unread counts, mention badges, DM notifications

function initNotifications() {
  const myUid = AppState.currentUser.uid;

  // Listen to all notifications for this user
  db.ref(`notifications/${myUid}`).on("value", snap => {
    if (!snap.exists()) return;
    const data = snap.val();

    // Channel unread badges
    if (data.channels) {
      Object.entries(data.channels).forEach(([cid, info]) => {
        const badge = document.getElementById(`ch-badge-${cid}`);
        if (badge) {
          const count = info.unread || 0;
          badge.textContent  = count > 99 ? "99+" : count;
          badge.classList.toggle("hidden", count === 0);
        }
      });
    }

    // Server rail badge (sum of channel unreads)
    if (AppState.activeServer && data.channels) {
      const sid    = AppState.activeServer.id;
      const railBadge = document.getElementById(`rail-badge-${sid}`);
      if (railBadge) {
        const total = Object.values(data.channels).reduce((acc, c) => acc + (c.unread || 0), 0);
        railBadge.textContent = total > 99 ? "99+" : total;
        railBadge.classList.toggle("hidden", total === 0);
      }
    }
  });

  // Clear channel unread when user opens it (hook into selectChannel)
  const _origSelect = window.selectChannel || function(){};
  window.selectChannel = function(sid, cid, channel) {
    _origSelect(sid, cid, channel);
    clearChannelUnread(myUid, cid);
  };
}

async function clearChannelUnread(uid, cid) {
  await db.ref(`notifications/${uid}/channels/${cid}/unread`).set(0);
}
