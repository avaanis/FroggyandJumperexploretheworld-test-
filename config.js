// ============================================================
//  Froggy & Jumper settings
// ============================================================
//
//  LOCAL MODE (works right away)
//  Password: november   (not case-sensitive)
//  Lists are saved in THIS browser only, so you and your partner
//  will not see each other's edits.
//  To change the password, get the SHA-256 hash of the new one
//  (lowercase) from any "sha256 online" tool and replace the
//  hash below.
//
//  SHARED MODE (real password + same lists on both devices)
//  Fill in FIREBASE_CONFIG below.
//   1. console.firebase.google.com -> create project -> add a Web
//      app, copy its config object into FIREBASE_CONFIG.
//   2. Build -> Authentication -> enable "Email/Password" -> add ONE
//      user: the SHARED_EMAIL below, password "november" (lowercase).
//   3. Build -> Firestore Database -> create -> Rules tab, paste:
//        rules_version = '2';
//        service cloud.firestore {
//          match /databases/{db}/documents {
//            match /{document=**} {
//              allow read, write: if request.auth != null;
//            }
//          }
//        }
//   4. Authentication -> Settings -> Authorized domains -> add
//      <your-username>.github.io
//
//  Note: Firebase needs passwords of 6+ characters, "november" is fine.
// ============================================================

const PASSWORD_HASH =
  "b68823eded0bc9c7f3317d601ac24f6ac563895cee8e5a2bd2ca475906fe2615";

const SHARED_EMAIL = "froggy-and-jumper@example.com";

const FIREBASE_CONFIG = null;
// Example:
// const FIREBASE_CONFIG = {
//   apiKey: "...",
//   authDomain: "...firebaseapp.com",
//   projectId: "...",
//   appId: "..."
// };

// The playlist that is placed in the first tab on a fresh start.
const SEED_PLAYLIST = "https://open.spotify.com/playlist/5QyhTdpNqhS7nS5MlOxUcE";
