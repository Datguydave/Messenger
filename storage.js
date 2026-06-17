// storage.js — file upload helpers

/**
 * Upload a file to Firebase Storage and return the download URL.
 * @param {File}   file     - File object from <input type="file">
 * @param {string} path     - Storage path e.g. "avatars/uid.jpg"
 * @param {Function} [onProgress] - called with 0–100
 */
async function uploadFile(file, path, onProgress) {
  const ref   = storage.ref(path);
  const task  = ref.put(file);

  return new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      snap => {
        if (onProgress) onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
      },
      reject,
      async () => {
        const url = await task.snapshot.ref.getDownloadURL();
        resolve(url);
      }
    );
  });
}

/**
 * Upload a user avatar and return URL.
 * @param {File}   file
 * @param {string} uid
 */
async function uploadAvatar(file, uid) {
  const ext = file.name.split(".").pop();
  return uploadFile(file, `avatars/${uid}.${ext}`);
}

/**
 * Upload a server icon and return URL.
 */
async function uploadServerIcon(file, serverId) {
  const ext = file.name.split(".").pop();
  return uploadFile(file, `serverIcons/${serverId}.${ext}`);
}

/**
 * Upload a message attachment and return { url, type }.
 * type: "image" | "video" | "pdf" | "zip" | "file"
 */
async function uploadAttachment(file, chatPath) {
  const ext  = file.name.split(".").pop().toLowerCase();
  const name = `${Date.now()}_${file.name}`;
  const url  = await uploadFile(file, `attachments/${chatPath}/${name}`);
  let type = "file";
  if (["jpg","jpeg","png","gif","webp","svg"].includes(ext)) type = "image";
  else if (["mp4","webm","ogg","mov"].includes(ext))          type = "video";
  else if (ext === "pdf")                                      type = "pdf";
  else if (ext === "zip")                                      type = "zip";
  return { url, type, name: file.name };
}
