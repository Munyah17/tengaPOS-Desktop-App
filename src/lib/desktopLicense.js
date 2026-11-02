import { db } from '@/db'

// ── License contract v1 (docs/desktop-license-api-v1.md in the web repo) ──
// Server: Supabase Edge Function `desktop-license` (/v1/*), Ed25519-signed
// lease JSON — no JWTs. Device authenticates with an Ed25519 keypair held in
// OS safeStorage by the Electron main process.

const API_URL = (import.meta.env.VITE_DESKTOP_LICENSE_API_URL || '').replace(/\/+$/, '')
const SERVER_PUBLIC_KEY = import.meta.env.VITE_DESKTOP_LICENSE_PUBLIC_KEY
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0'
const APP_OS = 'win32-x64'
const encoder = new TextEncoder()

function b64encode(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function b64decode(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
async function sha256b64(data) {
  const h = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return b64encode(new Uint8Array(h))
}

/** Canonical JSON per contract §1 — sorted keys recursively, compact. Must
 * byte-match the server's canonicalizer for lease/manifest signature checks. */
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'
}

function publishConnectionState(blocked, message = '') {
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-connection', {
    detail: { blocked, message },
  }))
}

async function getDeviceIdentity() {
  if (window.tengaDesktop?.getLicenseDeviceIdentity) {
    return window.tengaDesktop.getLicenseDeviceIdentity()
  }
  throw new Error('Secure desktop device identity is unavailable')
}

// ── Server public key (embedded at build time; also served by /v1/meta) ──
async function importServerVerificationKey() {
  if (!SERVER_PUBLIC_KEY) throw new Error('Desktop license verification is not configured in this build')
  try {
    return await crypto.subtle.importKey('raw', b64decode(SERVER_PUBLIC_KEY), 'Ed25519', false, ['verify'])
  } catch {
    throw new Error('This build cannot verify license signatures (Ed25519 unsupported)')
  }
}

/**
 * Verify a server-issued lease fully offline (contract §3).
 * Signature = base64 Ed25519 over canonicalize(lease minus `signature`).
 */
export async function verifyDesktopLease(lease, expectedDeviceId) {
  if (!lease || typeof lease !== 'object' || typeof lease.signature !== 'string') {
    throw new Error('License server returned no signed lease')
  }
  const { signature, ...unsigned } = lease
  const key = await importServerVerificationKey()
  const valid = await crypto.subtle.verify(
    'Ed25519', key, b64decode(signature), encoder.encode(canonicalize(unsigned)),
  )
  if (!valid) throw new Error('License signature is invalid')
  if (expectedDeviceId && lease.device_id !== expectedDeviceId) {
    throw new Error('License is bound to a different device')
  }
  if (!lease.lease_id || !lease.tenant_id || !lease.expires_at || !lease.grace_until) {
    throw new Error('License is missing required fields')
  }
  return lease
}

/** Flatten a verified lease into the claims shape the rest of the app reads. */
function leaseToClaims(lease, stored) {
  return {
    license_id: lease.lease_id,
    device_id: lease.device_id,
    tenant_id: lease.tenant_id,
    status: stored?.device_status === 'revoked' ? 'revoked' : 'active',
    expires_at: lease.expires_at,
    grace_until: lease.grace_until,
    issued_at: lease.issued_at,
    plan: lease.entitlements?.plan || stored?.claims?.plan || null,
    currency: stored?.shop_bootstrap?.currency || stored?.claims?.currency || 'USD',
  }
}

/** Contract §1: clock-rollback defense — never trust a clock behind the
 * latest server time we have observed. */
function effectiveNow(stored) {
  const seen = stored?.max_server_time_seen ? Date.parse(stored.max_server_time_seen) : 0
  return Math.max(Date.now(), seen || 0)
}
async function bumpServerTimeSeen(stored, serverTime) {
  if (!serverTime) return
  const prev = stored?.max_server_time_seen ? Date.parse(stored.max_server_time_seen) : 0
  if (Date.parse(serverTime) > prev) stored.max_server_time_seen = serverTime
}

async function apiFetch(method, apiPath, { body, query, signWithDeviceId } = {}) {
  if (!API_URL) throw new Error('Desktop license service is not configured in this build')
  const endpoint = new URL(`${API_URL}${apiPath}`)
  if (endpoint.protocol !== 'https:') throw new Error('Desktop licensing requires a secure HTTPS service')
  if (query) for (const [k, v] of Object.entries(query)) endpoint.searchParams.set(k, v)

  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json' }
  if (signWithDeviceId) {
    const ts = new Date().toISOString()
    const digest = await sha256b64(bodyText)
    // Contract §1: Ed25519 sig over METHOD\nPATH\nTIMESTAMP\nSHA256(BODY).
    // The signature covers the PATH ONLY — query params are not signed.
    const message = `${method}\n${apiPath}\n${ts}\n${digest}`
    if (!window.tengaDesktop?.signLicenseCheckIn) {
      throw new Error('Secure desktop license signing is unavailable')
    }
    headers['X-Device-Id'] = signWithDeviceId
    headers['X-Device-Signature'] = await window.tengaDesktop.signLicenseCheckIn(message)
    headers['X-Device-Timestamp'] = ts
  }

  let response
  try {
    response = await fetch(endpoint, {
      method, headers,
      body: body === undefined ? undefined : bodyText,
    })
  } catch {
    throw new Error('License service is unreachable. Check internet access and allow tengaPOS License Manager through the firewall.')
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const e = new Error(result?.error?.message || result?.message || `License service rejected the request (${response.status})`)
    e.code = result?.error?.code
    e.status = response.status
    throw e
  }
  return result
}

async function recordLicenseEvent(type, details = {}) {
  await db.desktopLicenseEvents.add({
    report_id: crypto.randomUUID(), // stable id → server dedupes on retry (§2.3b)
    type,
    details,
    created_at: new Date().toISOString(),
  })
}

function reportKindFor(type) {
  const t = String(type || '')
  if (t.includes('sale')) return 'sale'
  if (t.includes('inventory')) return 'inventory'
  if (t.includes('error') || t.includes('failed')) return 'error'
  if (t.includes('check_in') || t.includes('lease') || t.includes('activat')) return 'lease_check'
  return 'session'
}

/** Flush the offline report queue via POST /v1/report (contract §2.3b). */
async function flushReportQueue(deviceId) {
  const events = await db.desktopLicenseEvents.orderBy('created_at').toArray()
  if (!events.length) return
  // Backfill report_id on pre-v1 rows so retries dedupe server-side.
  for (const e of events) {
    if (!e.report_id) await db.desktopLicenseEvents.update(e.id, { report_id: crypto.randomUUID() })
  }
  const reports = events.map((e) => ({
    report_id: e.report_id,
    kind: reportKindFor(e.type),
    occurred_at: e.created_at,
    data: { type: e.type, ...(e.details || {}) },
  }))
  await apiFetch('POST', '/v1/report', { body: { reports }, signWithDeviceId: deviceId })
  await db.desktopLicenseEvents.clear()
}

/**
 * Read the stored lease and verify it offline. Returns null when there is no
 * usable license — including past grace_until, which is the contract's hard
 * stop (§5): the app gate then routes to the activation screen.
 */
export async function readVerifiedDesktopLicense() {
  const stored = await db.desktopLicense.get('current')
  if (!stored?.lease) return null
  const lease = await verifyDesktopLease(stored.lease, stored.device_id)
  const now = effectiveNow(stored)
  if (Date.parse(lease.grace_until) < now) return null
  return { lease, claims: leaseToClaims(lease, stored), checkedAt: stored.checked_at || null }
}

export async function activateDesktopLicense(activationCode) {
  const code = String(activationCode || '').trim()
  if (!code) throw new Error('Enter your license code')
  const identity = await getDeviceIdentity()
  const result = await apiFetch('POST', '/v1/activate', {
    body: {
      code: code.toUpperCase(),
      device_name: identity.deviceName,
      device_public_key: identity.devicePublicKey,
      device_fingerprint: identity.deviceFingerprint,
      app_version: APP_VERSION,
      os: APP_OS,
    },
  })
  const lease = await verifyDesktopLease(result.lease, result.device_id)
  const stored = {
    key: 'current',
    lease,
    device_id: result.device_id,
    tenant_id: result.tenant_id,
    device_status: 'active',
    session_token: null,
    shop_bootstrap: result.shop_bootstrap || null,
    entitlements: result.entitlements || null,
    checked_at: result.server_time || new Date().toISOString(),
    offline_since_start: null,
    max_server_time_seen: result.server_time || null,
  }
  stored.claims = leaseToClaims(lease, stored)
  await db.desktopLicense.put(stored)
  await recordLicenseEvent('activation_confirmed', { license_id: lease.lease_id })
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
  return stored.claims
}

export async function checkInDesktopLicense() {
  const stored = await db.desktopLicense.get('current')
  if (!stored?.device_id || !stored?.lease) return null
  const identity = await getDeviceIdentity()
  const body = {
    checkin_id: crypto.randomUUID(),
    app_version: APP_VERSION,
    os: APP_OS,
    device_fingerprint: identity.deviceFingerprint,
  }
  if (stored.offline_since_start) body.offline_since = stored.offline_since_start
  if (stored.session_token) body.session_token = stored.session_token

  let result
  try {
    result = await apiFetch('POST', '/v1/checkin', { body, signWithDeviceId: stored.device_id })
  } catch (e) {
    if (!stored.offline_since_start) {
      await db.desktopLicense.update('current', { offline_since_start: new Date().toISOString() })
    }
    throw e
  }

  await bumpServerTimeSeen(stored, result.server_time)
  if (result.duplicate) {
    await db.desktopLicense.put(stored)
    return stored.claims
  }
  if (result.device_status === 'revoked' || result.flags?.revoked) {
    stored.device_status = 'revoked'
    stored.claims = { ...stored.claims, status: 'revoked' }
    await db.desktopLicense.put(stored)
    await recordLicenseEvent('license_revoked', { license_id: stored.lease.lease_id })
    window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
    return { revoked: true, claims: stored.claims }
  }
  if (result.lease) {
    const lease = await verifyDesktopLease(result.lease, stored.device_id)
    stored.lease = lease
  }
  if (result.session_token) stored.session_token = result.session_token
  if (result.entitlements) stored.entitlements = result.entitlements
  stored.device_status = result.device_status || 'active'
  stored.plan_inactive = Boolean(result.flags?.plan_inactive)
  stored.checked_at = result.server_time || new Date().toISOString()
  stored.offline_since_start = null
  stored.claims = leaseToClaims(stored.lease, stored)
  await db.desktopLicense.put(stored)
  try { await flushReportQueue(stored.device_id) } catch { /* queue survives for next flush */ }
  await recordLicenseEvent('check_in_confirmed', { license_id: stored.lease.lease_id })
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
  return stored.claims
}

/** Self-deregister this device on uninstall/transfer — frees the seat (§2.4). */
export async function deactivateDesktopLicense() {
  const stored = await db.desktopLicense.get('current')
  if (!stored?.device_id) return
  try {
    await apiFetch('POST', '/v1/deactivate', { body: {}, signWithDeviceId: stored.device_id })
  } catch { /* best-effort — the lease dies naturally anyway */ }
  await db.desktopLicense.delete('current')
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
}

/** Contract §2.5 — device-signed update probe. Returns {manifest, mandatory}
 * or null when up to date. Any signature failure rejects the manifest. */
export async function checkForDesktopUpdate(channel = 'stable') {
  const stored = await db.desktopLicense.get('current')
  if (!stored?.device_id) return null
  const result = await apiFetch('GET', '/v1/releases/latest', {
    query: { channel, version: APP_VERSION, os: APP_OS },
    signWithDeviceId: stored.device_id,
  })
  if (!result.manifest) return null
  const key = await importServerVerificationKey()
  const valid = await crypto.subtle.verify(
    'Ed25519', key, b64decode(result.manifest_signature), encoder.encode(canonicalize(result.manifest)),
  )
  if (!valid) throw new Error('Update manifest signature is invalid')
  return { manifest: result.manifest, mandatory: Boolean(result.mandatory) }
}

export function startDesktopLicenseMonitor() {
  if (!window.tengaDesktop?.isDesktop) return () => {}
  let stopped = false
  let retryTimer

  const checkIn = async () => {
    if (stopped || !navigator.onLine) return
    try {
      await checkInDesktopLicense()
      publishConnectionState(false)
      try {
        const update = await checkForDesktopUpdate()
        if (update) await recordLicenseEvent('update_available', { version: update.manifest.version, mandatory: update.mandatory })
      } catch { /* update checks never affect sales */ }
    } catch (error) {
      await recordLicenseEvent('check_in_failed', {
        message: String(error?.message || 'License service unreachable'),
      }).catch(() => {})
      publishConnectionState(navigator.onLine, String(error?.message || 'License service unreachable'))
      if (!stopped) retryTimer = window.setTimeout(checkIn, 60_000)
    }
  }

  const onOnline = () => { void checkIn() }
  const onOffline = () => publishConnectionState(false)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void checkIn()
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisibilityChange)

  void readVerifiedDesktopLicense().then(async (license) => {
    if (!license || !navigator.onLine) return
    await checkIn()
  }).catch(() => {})

  const dailyTimer = window.setInterval(() => { void checkIn() }, 24 * 60 * 60 * 1000)
  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearInterval(dailyTimer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export async function queueDesktopLicenseEvent(type, details = {}) {
  await recordLicenseEvent(type, details)
}

export function isDesktopLicenseApiConfigured() {
  return Boolean(API_URL && SERVER_PUBLIC_KEY)
}
