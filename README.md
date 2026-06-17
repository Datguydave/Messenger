# ⚡ Spark — Discord-Style Messaging Platform

A full-featured Discord-inspired real-time messaging app built with vanilla HTML/CSS/JS and Firebase.

---

## 📁 File Structure

```
discord-app/
├── index.html          ← App shell + all modals
├── style.css           ← Full dark/light theme + responsive layout
├── firebase.js         ← Firebase init, shared utilities, AppState
├── storage.js          ← File upload helpers (avatar, server icons, attachments)
├── auth.js             ← Sign-up, login, logout, online presence
├── profile.js          ← Profile popup viewer
├── notifications.js    ← Unread badges and mention alerts
├── friends.js          ← Friends list, requests, DM list
├── servers.js          ← Server CRUD, member sidebar, server settings
├── channels.js         ← Channel list, create, delete, select
├── chat.js             ← Messages, editing, deleting, reactions, typing, emoji
├── settings.js         ← User settings: profile, status, theme
├── database.rules.json ← Firebase Realtime Database security rules
└── storage.rules       ← Firebase Storage security rules
```

---

## 🚀 Deployment (Firebase Hosting)

### Step 1 — Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### Step 2 — Initialise Firebase in this folder

```bash
cd discord-app
firebase init
```

Select:
- ✅ Hosting
- ✅ Database (to deploy rules)
- ✅ Storage (to deploy rules)

When prompted:
- Public directory: `.` (current folder)
- Single-page app: **No**
- Database rules file: `database.rules.json`
- Storage rules file: `storage.rules`

### Step 3 — Deploy

```bash
firebase deploy
```

Your app will be live at `https://messenger-ac442.web.app`

---

## 🌐 Embedding in Google Sites

1. Host the app (Firebase Hosting above or any static host)
2. In Google Sites → Insert → Embed
3. Paste your hosted URL
4. Resize the embed to fill the page

> **Note:** Google Sites embeds via iframe. Firebase Authentication works inside iframes on most browsers. If you see login issues, ensure your Firebase project allows your Google Sites domain under **Authentication → Settings → Authorised domains**.

---

## 🔧 Firebase Console Setup

### Enable Authentication

1. Firebase Console → **Authentication** → Get started
2. Enable **Email/Password** provider

### Enable Realtime Database

1. Firebase Console → **Realtime Database** → Create database
2. Choose **Europe West** region (already in config)
3. Start in **test mode**, then paste the rules from `database.rules.json`

### Enable Storage

1. Firebase Console → **Storage** → Get started
2. Paste the rules from `storage.rules`

### Add authorised domains (for Google Sites)

1. Firebase Console → Authentication → Settings → **Authorised domains**
2. Add: `sites.google.com`

---

## 🗃️ Database Schema

```
users/
  {uid}/
    uid, username, email, avatar, about, status, online, createdAt

usernames/
  {username_lowercase} → uid       ← for uniqueness checks

onlineUsers/
  {uid}/
    online: true, lastSeen

friendRequests/
  {targetUid}/
    {senderUid}: true

friends/
  {uid}/
    {friendUid}: true

dms/
  {uid1_uid2}/
    {messageId}/
      senderUid, username, avatar, content, timestamp, edited,
      attachmentUrl?, attachmentType?, attachmentName?

servers/
  {serverId}/
    name, icon, owner, createdAt

serverMembers/
  {serverId}/
    {uid}: "owner" | "admin" | "moderator" | "member"

userServers/
  {uid}/
    {serverId}: true

channels/
  {serverId}/
    {channelId}/
      name, type ("text" | "voice"), createdAt

messages/
  {serverId}/
    {channelId}/
      {messageId}/
        senderUid, username, avatar, content, timestamp, edited,
        attachmentUrl?, attachmentType?, attachmentName?

typing/
  {serverId}/
    {channelId}/
      {uid}: true

reactions/
  {reactionKey}/
    {emoji}/
      {uid}: true

notifications/
  {uid}/
    channels/
      {channelId}/
        unread: number
    friendRequests/
      {senderUid}/
        from, timestamp, type
```

---

## ✅ Feature Checklist

| Feature | Status |
|---|---|
| Email/Password sign-up & login | ✅ |
| Profile picture upload | ✅ |
| Persistent sessions | ✅ |
| Online presence (Firebase .info/connected) | ✅ |
| Status: Online / Idle / DND / Offline | ✅ |
| Friend requests (send, accept, decline, remove) | ✅ |
| Username uniqueness check | ✅ |
| Direct Messages (realtime) | ✅ |
| Create / Join / Leave / Delete servers | ✅ |
| Server invite by ID | ✅ |
| Text channels (create, delete) | ✅ |
| Voice channel placeholders | ✅ |
| Real-time messaging | ✅ |
| Message editing (inline) | ✅ |
| Message deletion | ✅ |
| Emoji reactions (10 quick + picker) | ✅ |
| File attachments (images, video, PDF, ZIP) | ✅ |
| Typing indicator | ✅ |
| Unread channel badges | ✅ |
| Mention notifications (@username) | ✅ |
| Member sidebar with roles | ✅ |
| Profile popup (click any user) | ✅ |
| User settings (avatar, username, about) | ✅ |
| Dark / Light theme toggle | ✅ |
| Search messages in channel | ✅ |
| Search conversations in DM list | ✅ |
| Image lightbox viewer | ✅ |
| Responsive (desktop, tablet, mobile) | ✅ |
| Security rules (auth required) | ✅ |

---

## 🔐 Security Notes

- All database reads/writes require `auth != null`
- Users can only write to their own profile node
- DM access is restricted to participants (chatId contains uid)
- Channel/message access is restricted to server members
- Typing indicator writes are restricted to the authenticated uid
- Reaction writes are restricted to the authenticated uid
- Storage uploads limited to 25MB (attachments) and 5MB (avatars/icons)

---

## 📱 Mobile Notes

- On screens < 600px, the channel sidebar slides in as an overlay
- On screens < 900px, the member sidebar is hidden
- The message input and emoji picker are touch-friendly
- Tap any avatar to view a profile popup

---

## 🛠️ Local Development

No build tools needed. Just serve the folder with any static server:

```bash
# Python
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# VS Code
# Use the "Live Server" extension
```

Then open `http://localhost:8080`
