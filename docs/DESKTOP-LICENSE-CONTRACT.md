# Desktop Licensing API Contract (v1 draft)

The desktop app has no activation service until the online app implements these endpoints. Do not configure production builds with a fake endpoint, a development signing key, or a placeholder successful response. HTTPS is required.

## Configuration

- `VITE_DESKTOP_LICENSE_API_URL`: HTTPS base URL for the licensing API.
- `VITE_DESKTOP_LICENSE_PUBLIC_KEY`: RSA SubjectPublicKeyInfo PEM used to verify `RS256` license JWTs. Its private key stays in server-side secret storage and is never shipped to desktop builds.

## Signed license token

The API returns a compact JWT in `license_token`. Header algorithm must be `RS256`. Required claims:

- `iss`: `https://tengapos.com`
- `aud`: `tengapos-desktop`
- `license_id`: persistent license ID
- `tenant_id`: provisioned online tenant ID
- `device_id`: base64url SHA-256 of the canonical device public JWK JSON (`{"crv":"P-256","kty":"EC","x":"...","y":"..."}`)
- `status`: `active` or `revoked`
- `currency`: optional initial shop currency

No `exp` claim should be enforced for offline operation. Revocations are effective when a signed revoked token is returned at check-in. The desktop continues using the previously verified active token while genuinely offline, without an expiration limit.

## `POST /activate`

Request JSON:

- `activation_code`: one-time code, consumed atomically on successful activation
- `device_id`: device key fingerprint
- `device_public_key`: P-256 public JWK
- `app_version`: desktop release version

Server validates the code, paid eligibility, unused state, and key/device identity; atomically binds the license to this device; rejects reuse or another device; and responds `{ "license_token": "<signed JWT>" }`. Do not send tenant sales data in activation.

## `POST /check-in`

Request JSON:

- `license_token`: last signed token
- `device_id`, `device_public_key`: binding data
- `timestamp`: UTC ISO time
- `nonce`: unique request nonce
- `signature`: base64url DER ECDSA/SHA-256 signature over the UTF-8 bytes of `${device_id}.${license_id}.${timestamp}.${nonce}`
- `events`: queued license telemetry only; never POS orders, receipts, products, or customer data

Server validates token signature, device binding, timestamp/nonce replay, current license status, and event shape. Response `{ "license_token": "<fresh signed JWT>" }`, including `status: revoked` when appropriate. Activation/check-in events should be auditable on the server. An API error or connection failure must never be treated as activation success.

## Connectivity behavior

- Fresh activation requires successful online activation and signature verification.
- Once activated, a verified local active token works offline indefinitely. License check-in scheduling is independent of business-data synchronization.
- Check in on online event, on app foreground if online, at least every 24 hours while online, and retry failed requests after 60 seconds with continued retries.
- `navigator.onLine === false` is treated as offline and does not block the locally licensed app. If it reports online but the license endpoint cannot be reached, show a connection block and firewall-unblock guidance. The client cannot prove firewall causality; server outage, DNS, captive portal, or routing failures may produce the same message.
- No Internet / offline state must not cause deletion or expiration of local license state.
