# Android app (Trusted Web Activity)

This project packages the production web app (`https://<your domain>/app`)
as an Android app for Google Play. The app opens the site full screen in the
user's Chrome, so every server release updates the app at once; a new upload
is needed only to change the icon, name, package or libraries. Purchases go
through Google Play Billing, as Google Play requires for digital goods.

**It has not been built here**: there was no Android SDK and no network to
download the Android Gradle Plugin and libraries. Build it once in Android
Studio as below; expect Android Studio to offer newer library versions, and
accept them.

## Build

1. Install Android Studio (with Android SDK Platform 36) and open this folder.
2. In `gradle.properties` set `appId` (for example `com.yourcompany.examsimulator`,
   permanent after the first upload), `siteHost` (your production domain) and
   `appName`.
3. Create the upload key once and keep it and its passwords safe:
   ```
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
   cp keystore.properties.example keystore.properties   # then fill in the passwords
   ```
4. Build the bundle Google Play takes:
   ```
   ./gradlew bundleRelease          # app/build/outputs/bundle/release/app-release.aab
   ```

## Connect the app and the site (Digital Asset Links)

Without this step the app shows a browser address bar instead of opening full screen.

1. Upload the bundle to Google Play Console (internal testing first) with
   **Play App Signing** on.
2. In Play Console → *Test and release → App integrity*, copy the **SHA-256**
   fingerprints of the *app signing key* and of the *upload key*.
3. On the server set:
   ```
   ANDROID_PACKAGE=com.yourcompany.examsimulator
   ANDROID_CERT_SHA256=AA:BB:...(app signing key),CC:DD:...(upload key)
   ```
   and restart. Check `https://<your domain>/.well-known/assetlinks.json`.
4. Install from the internal testing track; the app must open without an address bar.

## Google Play Billing

1. In Play Console create one **in-app product** per pass (one-time
   products, not subscriptions), for example `pass30` and `pass90`, with
   their prices per country.
2. In the admin panel → *Plans and access* → set the **store product id** of
   each pass to the same id (on one region's price row).
3. Give the server access to verify purchases: create a service account in
   Google Cloud, invite it in Play Console (*Users and permissions*) with
   "View financial data" and "Manage orders", download its JSON key, then set
   `GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json` on the server.
4. Test with licence testers (Play Console → *Settings → License testing*).

The server checks every purchase with Google, grants the pass once per
order, then acknowledges and consumes the purchase so the pass can be bought
again later. Purchases that could not be completed are sent again the next
time the app opens.
