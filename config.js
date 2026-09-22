/**
 * notelylog — Google Sign-In / cloud sync configuration
 * ------------------------------------------------------
 * This file is NOT secret. Firebase "web config" values (including the
 * apiKey below) are meant to be public — they identify your project,
 * they don't grant access by themselves. Access is controlled by the
 * Firestore security rules you set in the Firebase console (see the
 * SETUP section below). It's safe to commit this file to a public
 * GitHub repo once filled in.
 *
 * HOW TO GET YOUR OWN VALUES (~3 minutes):
 * 1. Go to https://console.firebase.google.com → "Add project" (free).
 * 2. In your new project: Build → Authentication → Get started →
 *    enable the "Google" sign-in provider.
 * 3. Build → Firestore Database → Create database → start in
 *    "production mode" (any region).
 * 4. In Firestore → Rules, replace the default rules with:
 *
 *      rules_version = '2';
 *      service cloud.firestore {
 *        match /databases/{database}/documents {
 *          match /notelylog_users/{userId} {
 *            allow read, write: if request.auth != null && request.auth.uid == userId;
 *          }
 *        }
 *      }
 *
 *    This makes sure a signed-in user can only ever read or write
 *    their OWN data — publish this and click "Publish" in the console.
 * 5. Project settings (gear icon) → General → "Your apps" → add a
 *    Web app (</> icon) → copy the firebaseConfig object it gives you
 *    into FIREBASE_CONFIG below.
 * 6. Still in Authentication → Settings → Authorized domains: add the
 *    domain your site is served from (e.g. yourname.github.io).
 *
 * Until you fill this in, Notelylog runs exactly as before — fully
 * functional, just local to this browser, with the sign-in button
 * hidden.
 */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAEzArSkAPkJnGxgLjbES3OFrcpz63G9gU",
  authDomain: "notely-log-5f79f.firebaseapp.com",
  projectId: "notely-log-5f79f",
  storageBucket: "notely-log-5f79f.firebasestorage.app",
  messagingSenderId: "52253657813",
  appId: "1:52253657813:web:9617e49812f33d7d63f05c"
};
