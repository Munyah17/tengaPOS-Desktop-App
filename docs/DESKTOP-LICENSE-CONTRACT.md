# Desktop Licensing Contract (client side)

The binding contract is `docs/desktop-license-api-v1.md` in the `tengaPOS` web
repo (Ed25519 leases, device-signed check-ins, rolling session tokens, signed
release manifests). This file only notes the client implementation points.

## Build-time configuration

- `VITE_DESKTOP_LICENSE_API_URL`: HTTPS base URL, e.g.
  `https://<project>.supabase.co/functions/v1/desktop-license`
- `VITE_DESKTOP_LICENSE_PUBLIC_KEY`: base64 raw 32-byte Ed25519 server public
  key (matches `DESKTOP_LICENSE_PRIVATE_KEY` server-side)
- `VITE_APP_VERSION`: release version reported on activate/check-in

Do not ship a build without the production values — activation is intentionally
unavailable in unconfigured builds.

## Implementation map

- `src/lib/desktopLicense.js` — canonical JSON, offline lease verify,
  activation, check-in + rolling `session_token`, report queue flush
  (`/v1/report`), `min_supported_version`/`rollout_pct` update probes, and
  `applyDesktopUpdate` (download → sha256 + Ed25519 verify → NSIS `/S`).
- `electron/main.cjs` — `license:get-device-identity` (Ed25519 keypair in
  `safeStorage` + install-id fingerprint), `license:sign-check-in`, and
  `license:apply-update` (re-verifies checksum + signature, runs installer).
- `src/pages/DesktopLicensePage.jsx` — first-run activation gate (requires
  network once; offline forever afterwards while the lease is valid).
- `src/App.jsx` — `DesktopUpdateBanner` for optional updates; `mandatory`
  updates (`min_supported_version` floor) apply immediately.

## Offline semantics

- A verified signed lease runs fully offline until `grace_until`; after that
  the app routes to the activation screen (read-only data is the contract's
  D2 alternative).
- License check-ins retry every 60s on failure and never block sales.
- `navigator.onLine === false` is offline; an online OS with an unreachable
  license service shows the firewall-unblock screen.

## Cloud Sync (Cloud Hosting Fee)

`entitlements.features.cloud_sync` inside each signed lease is the gate for
business-data sync to the tenant's cloud. It is true only while the tenant's
paid `desktop_cloud_sync` add-on (signup-checkout `type: 'desktop_cloud_sync'`,
from $10/mo) is unexpired. `isCloudSyncEnabled()` reads the stored
entitlement; a lapsed subscription silently drops the flag at the next lease
renewal — the terminal never loses offline POS either way.
