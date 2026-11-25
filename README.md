# Froggy and Jumper Explore the World

Shared bucket-list documents for two. Password: `november` (not case-sensitive).

## 1. Put it online (GitHub Pages)
1. Upload every file in this folder to the root of your repo.
2. Repo -> Settings -> Pages -> Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Your site will be at `https://<your-username>.github.io/<repo-name>/`.

## 2. Turn on live sync (one-time, free, about 5 minutes)
Without this step each browser keeps its own private copy and the top bar says **"Sync off, this device only"**. With it, you both see each other's edits live, see who is online, and see each other's cursor.

1. Go to https://console.firebase.google.com and create a project (Analytics can be off).
2. Project settings -> Your apps -> add a Web app. Copy its `firebaseConfig` values into `FIREBASE_CONFIG` in `config.js` (replace `null` with the object).
3. Build -> Authentication -> Get started -> enable **Email/Password**. Then Users -> Add user:
   - Email: the same address as `SHARED_EMAIL` in `config.js` (it does not need to be a real inbox)
   - Password: `november` (lowercase)
4. Build -> Firestore Database -> Create database (any region, production mode). Open the **Rules** tab, paste this and press Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

5. Authentication -> Settings -> Authorized domains -> Add `<your-username>.github.io`.
6. Commit the edited `config.js`. Open the site on both devices, pick who you are, and log in.

Lists you already wrote in local mode on the first device you open are copied into the shared database automatically.

## If something is wrong, read the message
The login screen and the top-right label say exactly what is missing:

| Message | Fix |
| --- | --- |
| Sync off, this device only | `FIREBASE_CONFIG` in `config.js` is still `null` (step 2) |
| Incorrect password, or the shared login has not been added | Step 3: the user must exist with password `november` and the same email as `SHARED_EMAIL` |
| Turn on Email/Password sign-in | Step 3: enable the Email/Password provider |
| Add this website's domain | Step 5 |
| Sync blocked / Not saved: publish the Firestore rules | Step 4: paste the rules and press Publish |
| Could not reach Firebase | Network problem; try again |

After editing files on GitHub, hard-refresh the site (Ctrl+Shift+R) so the browser loads the new version.

## Notes
- Each tab is its own record. If you both type in the same tab, edits in different paragraphs are merged. If you both edit the exact same paragraph at the same moment, the most recent save wins for that paragraph.
- Presence (who is online, the other person's cursor) shows as online for about a minute after their last activity.
- To change the password: change the Firebase user's password, and use the same word for `PASSWORD_HASH` (SHA-256, lowercase) if you also want local mode to match.
