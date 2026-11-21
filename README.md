# Froggy and Jumper Explore the World

Shared bucket-list documents for two. Password: `november` (not case-sensitive).

## 1. Put it online (GitHub Pages)
1. Upload every file in this folder to the root of your repo.
2. Repo -> Settings -> Pages -> Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Your site will be at `https://<your-username>.github.io/<repo-name>/`.

## 2. Make it sync between both of your devices (one-time, free, ~5 minutes)
Without this, each browser keeps its own private copy. With it, any change either of you makes appears on the other's screen within a second or two.

1. Go to https://console.firebase.google.com and create a project (turn Analytics off).
2. Project settings -> Your apps -> add a Web app. Copy the `firebaseConfig` values into `FIREBASE_CONFIG` in `config.js` (replace `null` with the object).
3. Build -> Authentication -> Get started -> enable **Email/Password**. Then Users -> Add user:
   - Email: the same address as `SHARED_EMAIL` in `config.js` (it does not have to be a real inbox)
   - Password: `november` (lowercase)
4. Build -> Firestore Database -> Create database (any region, start in production mode). Open the **Rules** tab, paste this, and Publish:

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
6. Commit the edited `config.js`. Open the site on both devices and log in.

Anything you already wrote in local mode on the device you open first is copied into the shared database automatically the first time.

## Notes
- Each tab is saved on its own, so editing different tabs at the same time never clashes. If you both type in the same tab at the exact same moment, the most recent save wins.
- To change the password: update the Firebase user's password, and use the same word for `PASSWORD_HASH` (SHA-256, lowercase) if you also want local mode to match.
