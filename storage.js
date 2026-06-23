// storage.js — file helpers
// Everything stored as base64 in RTDB — no Firebase Storage needed.

/** Resize + compress image File → base64 JPEG data URL */
function imageFileToBase64(file, maxSize = 128, quality = 0.75) {
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
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Avatar → base64, max 128px */
async function uploadAvatar(file, uid) {
  return imageFileToBase64(file, 128, 0.8);
}

/** Server icon → base64, max 128px */
async function uploadServerIcon(file, serverId) {
  return imageFileToBase64(file, 128, 0.8);
}

/**
 * Message attachment → base64 stored in DB.
 * Images are compressed to max 800px wide.
 * Other file types (video, pdf, zip) are read as raw base64 data URLs.
 * Returns { dataUrl, type, name, size }
 */
async function uploadAttachment(file) {
  const ext  = file.name.split(".").pop().toLowerCase();
  const MB   = file.size / 1024 / 1024;

  let type = "file";
  if (["jpg","jpeg","png","gif","webp"].includes(ext)) type = "image";
  else if (["mp4","webm","mov"].includes(ext))          type = "video";
  else if (ext === "pdf")                               type = "pdf";
  else if (ext === "zip")                               type = "zip";

  // Hard cap — RTDB nodes have a 10 MB limit per write
  if (MB > 8) {
    throw new Error("File too large for direct upload. Max size is 8 MB.");
  }

  if (type === "image") {
    // Compress images to max 800px
    const dataUrl = await imageFileToBase64(file, 800, 0.82);
    return { dataUrl, type, name: file.name, size: MB };
  }

  // For non-image files, read as raw base64 data URL
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload  = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });

  // Extra guard on actual base64 size
  if (dataUrl.length > 8 * 1024 * 1024) {
    throw new Error("File too large after encoding. Try a smaller file.");
  }

  return { dataUrl, type, name: file.name, size: MB };
}
