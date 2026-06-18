// storage.js — file helpers
// Avatars and server icons are stored as base64 data URLs directly in
// the Realtime Database (no Firebase Storage required).
// Message attachments use Firebase Storage if available, else are skipped.

/** Resize + compress an image File → base64 data URL (max 128x128, ~15 KB) */
function imageFileToBase64(file, maxSize = 128) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        // Quality 0.75 keeps file size small enough for RTDB
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Upload user avatar → returns base64 data URL */
async function uploadAvatar(file, uid) {
  return imageFileToBase64(file, 128);
}

/** Upload server icon → returns base64 data URL */
async function uploadServerIcon(file, serverId) {
  return imageFileToBase64(file, 128);
}

/** Upload message attachment via Firebase Storage → { url, type, name } */
async function uploadAttachment(file, chatPath) {
  const ext  = file.name.split(".").pop().toLowerCase();
  const name = Date.now() + "_" + file.name;
  const path = "attachments/" + chatPath + "/" + name;

  const ref  = storage.ref(path);
  const task = ref.put(file);

  const url = await new Promise((resolve, reject) => {
    task.on("state_changed", null, reject, async () => {
      resolve(await task.snapshot.ref.getDownloadURL());
    });
  });

  let type = "file";
  if (["jpg","jpeg","png","gif","webp"].includes(ext)) type = "image";
  else if (["mp4","webm","mov"].includes(ext))          type = "video";
  else if (ext === "pdf")                               type = "pdf";
  else if (ext === "zip")                               type = "zip";

  return { url, type, name: file.name };
}
