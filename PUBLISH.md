# Publishing the web app and the mobile apps

The product reaches candidates in three ways. All three run the same
candidate app from your server, so a server release updates them all.

| Channel | What candidates get | State |
| --- | --- | --- |
| **Web** | `https://<domain>/` (landing page) and `/app`, installable from the browser on phones and computers | Ready: deploy with [DEPLOY.md](DEPLOY.md) |
| **Android, Google Play** | An app built from `android/` (a Trusted Web Activity) with Google Play Billing | Project ready; must be built in Android Studio (not possible here) |
| **iPhone and iPad** | "Add to Home Screen" from Safari now; an App Store app later | No App Store app yet: see below |

## 1. Web

Deploy the server as described in [DEPLOY.md](DEPLOY.md). Then:

- `https://<domain>/` is a bilingual landing page (features, notice, terms,
  privacy and support links from the server settings). It is the address to
  give in store listings and adverts.
- `https://<domain>/app` is the candidate app. It is an installable web app:
  a manifest, icons for every platform and a service worker. Chrome, Edge and
  Samsung Internet offer **Install**; the app's Settings show an install
  button there, and instructions on iPhone and iPad. The installed app opens
  without browser bars and starts even without a connection (it then shows
  that practice and exams need a connection).
- The service worker keeps only the app's own page and icons. It never stores
  answers, results or personal data.
- `robots.txt` lets search engines index the landing page and keeps them out
  of `/admin` and the API.
- Set `APP_NAME` (and `APP_SHORT_NAME`, at most 12 characters) to your product
  name. The server refuses a name containing PMP or PMI.

Check after deploying: open the site in Chrome, DevTools → Application →
Manifest shows no errors; Lighthouse "Installable" passes.

## 2. Android: Google Play

### Before you start

- A Google Play developer account (one-time fee) and, for new personal
  accounts, Google's identity verification and closed-testing requirements:
  check Play Console for the rules that apply to your account.
- The web app deployed on its final domain with HTTPS.
- Your privacy policy URL, support email and the store texts and images in
  [store/listing.md](store/listing.md).

### Steps

1. **Build** the app bundle from `android/` in Android Studio, following
   [android/README.md](android/README.md): set the package id, domain and name
   in `android/gradle.properties`, create the upload key, run
   `./gradlew bundleRelease`. The project targets Android 16 (API 36), which
   Google Play requires for new apps and updates from 31 August 2026.
2. **Create the app** in Play Console, turn on Play App Signing, and upload
   the bundle to the internal testing track.
3. **Link the app and the site**: copy the SHA-256 fingerprints of the app
   signing key and the upload key (Play Console → App integrity), set
   `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256` on the server, restart, and
   check `https://<domain>/.well-known/assetlinks.json`. Install from the
   testing track: the app must open with no address bar.
4. **In-app products**: create one-time products for the passes (for
   example `pass30`, `pass90`) with prices per country. In the admin panel →
   Plans and access, enter each product id as the store product id of the
   matching pass.
5. **Purchase verification**: create a Google Cloud service account, give it
   access to the app in Play Console (*Users and permissions*: view financial
   data, manage orders), download its JSON key and set
   `GOOGLE_SERVICE_ACCOUNT_FILE` on the server. Test with licence testers.
6. **Store listing**: paste the texts, upload the icon, feature graphic and
   screenshots from `store/screenshots/`, fill in the data safety form and the
   content rating questionnaire with the answers in `store/listing.md`.
7. **Release**: closed or open testing first, then production.

### How payments work in the Android app

Google Play requires Google Play Billing for digital goods sold in apps it
distributes. Inside the Android app, the plan screen therefore shows Google
Play prices and a **Buy** button; the web prices, the region choice and the
"purchases are not available yet" note are hidden. The purchase is confirmed
by the server with Google, the pass is granted once per order, and the
purchase is acknowledged and consumed so the pass can be bought again later.
Purchases that could not be completed (for example a lost connection) are
sent again the next time the app opens. Google refunds purchases that are not
acknowledged within three days, so watch the logs for "store completion
failed".

**[Check before release]** Access codes: the app lets candidates redeem codes
given by training providers. Google Play's payments policy limits leading
users to pay outside Google Play for content used in the app. Free codes for
course students are the safer use; have the policy checked before codes are
sold for money, and remove the redeem form from the Android app if needed.

## 3. iPhone and iPad

**Now:** candidates open the site in Safari and use Share → **Add to Home
Screen**. The app then opens full screen with its own icon. The app's Settings
show these instructions on Apple devices. No App Store review or fee is
involved, but there is no App Store listing and no Apple in-app purchase;
access is given by codes or bought on the web.

**App Store app: not ready.** Two Apple requirements decide the route:

- An app that mostly displays a website is often rejected under the App
  Store Review Guidelines' minimum-functionality rule. A plain web wrapper,
  like the Android project, is therefore a poor fit for iOS.
- Digital access sold inside an iOS app must use Apple's in-app purchase.
  The server has the interface for it (`StoreVerifier`), but Apple's
  verification is not implemented.

The planned route is a native app (Flutter, as in the architecture), built
on a Mac with Xcode, using the same API, plus Apple in-app purchase
verification on the server. It cannot be built in this environment.

## What was and was not verified here

Verified by automated tests: the landing page, manifest, icons, robots.txt
and asset links; the service worker caching the app shell and the app
opening offline; a full Google Play purchase inside a simulated Trusted Web
Activity (Digital Goods API and Payment Request API stand-ins), through the
server, granting the pass and completing it; the server's Google Play
verifier against a fake Google API (signed service-account sign-in, purchase
lookup, acknowledge, consume, pending and forged purchases); a purchase never
granted to a second account; a failed completion keeping the pass and being
reported.

Not verified here: building the Android project (no Android SDK or network),
the real Google Play Developer API, a real device, and the Play Console
review. Library versions in `android/gradle.properties` should be updated to
the newest ones Android Studio offers; Google Play requires Play Billing
Library 8 or newer from 31 August 2026.
