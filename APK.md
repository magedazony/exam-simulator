# Getting the Android app file (APK)

The APK is built for you by GitHub, free, in about 5 minutes. No Android
Studio needed. It could not be built where this project was prepared (no
Android SDK there), so the first run is also the first real build: if it
fails, open the failed step, copy the red error lines and send them.

## Before you start

The site must be online first (FREE-HOSTING.md or DEPLOY.md), because the
app opens your site. You need its address, for example
`exam-simulator.onrender.com`.

## Steps

1. Put the project in a GitHub repository (the same one used for hosting).
2. On GitHub open the repository → **Actions** → **Build Android APK** →
   **Run workflow**. Fill in:
   - **siteHost**: your site address without `https://`
   - **appName**: the name under the icon
   - **appId**: for example `com.yourname.examsimulator`
3. When the run turns green, open it and download **exam-simulator-apk**
   from *Artifacts*. The zip holds `app-release.apk` (to install on a phone)
   and `app-release.aab` (the file Google Play takes).
4. Send the APK to an Android phone and open it. Android asks to allow
   installing from this source; allow it.

## Opening full screen (no address bar)

The app shows a small address bar until the site confirms the app:

1. On the run's page, **Summary** shows the *SHA-256 fingerprint*.
2. On the server set `ANDROID_PACKAGE` to your appId and
   `ANDROID_CERT_SHA256` to that fingerprint, then restart (on Render:
   Environment → add both → Save).

## For Google Play

A trial build uses a new throwaway key each time. For Google Play create one
permanent key and keep it safe:

```
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 upload.jks        # copy the output
```

In the repository → Settings → Secrets and variables → Actions, add
`ANDROID_KEYSTORE_BASE64` (that output) and `ANDROID_KEYSTORE_PASSWORD`
(the same password for store and key). Run the workflow again and upload the
`.aab` to Play Console. The rest is in PUBLISH.md.
