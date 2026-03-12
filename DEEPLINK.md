# Deep Link Verification (Well-Known Routes)

The server serves verification files required for Universal Links (iOS) and App Links (Android), so `https://www.carexmarket.com/listing/{carId}` opens the CarEx app instead of the browser.

## Routes

| Path | Purpose |
|------|---------|
| `GET /.well-known/apple-app-site-association` | iOS Universal Links |
| `GET /.well-known/assetlinks.json` | Android App Links |

## Deployment

For these to work, **carexmarket.com** must serve these paths. Options:

1. **Backend at carexmarket.com** – If this Express app is deployed at www.carexmarket.com, the routes work as-is.

2. **Reverse proxy** – If carexmarket.com is a separate frontend, proxy `/.well-known/*` to this backend:
   ```nginx
   location /.well-known/ {
       proxy_pass https://your-backend-url;
   }
   ```

3. **Vercel/Netlify** – Add rewrites to forward `/.well-known/*` to your backend API.

## Environment Variable

**`ANDROID_SHA256_CERT_FINGERPRINTS`** – Comma-separated SHA256 fingerprints for Android App Links verification.

Add to `.env`:
```
ANDROID_SHA256_CERT_FINGERPRINTS=AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56
```

Get your fingerprint:
```bash
# Debug keystore
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android

# Release keystore
keytool -list -v -keystore android/app/your-release.keystore -alias your-alias
```

Use the `SHA256:` value. For Google Play App Signing, add both upload key and Play signing certificate fingerprints (comma-separated).

If not set, `assetlinks.json` returns an empty fingerprints array and Android verification will fail.
