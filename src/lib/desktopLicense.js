import { db } from '@/db'

const API_URL = import.meta.env.VITE_DESKTOP_LICENSE_API_URL
const LICENSE_PUBLIC_KEY = import.meta.env.VITE_DESKTOP_LICENSE_PUBLIC_KEY
const encoder = new TextEncoder()

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

function decodeBase64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)))
}

async function getDeviceIdentity() {
  if (window.tengaDesktop?.getLicenseDeviceIdentity) {
    return window.tengaDesktop.getLicenseDeviceIdentity()
  }
  throw new Error('Secure desktop device identity is unavailable')
}

async function importLicenseVerificationKey() {
  if (!LICENSE_PUBLIC_KEY) throw new Error('Desktop license verification is not configured in this build')
  const pem = LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n')
  const encoded = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '')
  const keyBytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
  return crypto.subtle.importKey(
    'spki',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

export async function verifyDesktopLicenseToken(token, expectedDeviceId) {
  if (typeof token !== 'string') throw new Error('License server returned no signed license')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('License server returned an invalid signed license')
  const header = decodeBase64UrlJson(parts[0])
  const claims = decodeBase64UrlJson(parts[1])
  if (header.alg !== 'RS256') throw new Error('License uses an unsupported signature algorithm')

  const key = await importLicenseVerificationKey()
  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  )
  if (!validSignature) throw new Error('License signature is invalid')
  if (claims.iss !== 'https://tengapos.com' || claims.aud !== 'tengapos-desktop') {
    throw new Error('License was issued for a different application')
  }
  if (claims.device_id !== expectedDeviceId) throw new Error('License is bound to a different device')
  if (!['active', 'revoked'].includes(claims.status) || !claims.license_id || !claims.tenant_id) {
    throw new Error('License status is invalid')
  }
  return claims
}

async function postLicenseRequest(path, payload) {
  if (!API_URL) throw new Error('Desktop license service is not configured in this build')
  let response
  try {
    response = await fetch(`${API_URL.replace(/\/$/, '')}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('License service is unreachable. Check internet access and allow tengaPOS License Manager through the firewall.')
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.message || `License service rejected the request (${response.status})`)
  return result
}

async function recordLicenseEvent(type, details = {}) {
  await db.desktopLicenseEvents.add({
    type,
    details,
    created_at: new Date().toISOString(),
  })
}

export async function readVerifiedDesktopLicense() {
  const stored = await db.desktopLicense.get('current')
  if (!stored?.token) return null
  const device = await getDeviceIdentity()
  const claims = await verifyDesktopLicenseToken(stored.token, device.deviceId)
  if (claims.status !== 'active') return null
  return { token: stored.token, claims, checkedAt: stored.checked_at || null }
}

export async function activateDesktopLicense(activationCode) {
  const code = String(activationCode || '').trim()
  if (!code) throw new Error('Enter your license code')
  const device = await getDeviceIdentity()
  const result = await postLicenseRequest('activate', {
    activation_code: code,
    device_id: device.deviceId,
    device_public_key: device.publicKey,
    app_version: import.meta.env.VITE_APP_VERSION || 'desktop',
  })
  const claims = await verifyDesktopLicenseToken(result.license_token, device.deviceId)
  if (claims.status !== 'active') throw new Error('This license is not active')
  const checkedAt = new Date().toISOString()
  await db.desktopLicense.put({
    key: 'current',
    token: result.license_token,
    device_id: device.deviceId,
    license_id: claims.license_id,
    tenant_id: claims.tenant_id,
    status: claims.status,
    checked_at: checkedAt,
  })
  await recordLicenseEvent('activation_confirmed', { license_id: claims.license_id })
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
  return claims
}

export async function checkInDesktopLicense() {
  const verified = await readVerifiedDesktopLicense()
  if (!verified) return null
  const device = await getDeviceIdentity()
  const timestamp = new Date().toISOString()
  const nonce = crypto.randomUUID()
  const message = `${device.deviceId}.${verified.claims.license_id}.${timestamp}.${nonce}`
  if (!window.tengaDesktop?.signLicenseCheckIn) {
    throw new Error('Secure desktop license signing is unavailable')
  }
  const signature = await window.tengaDesktop.signLicenseCheckIn(message)
  const result = await postLicenseRequest('check-in', {
    license_token: verified.token,
    device_id: device.deviceId,
    device_public_key: device.publicKey,
    timestamp,
    nonce,
    signature,
    events: await db.desktopLicenseEvents.orderBy('created_at').toArray(),
  })
  const claims = await verifyDesktopLicenseToken(result.license_token, device.deviceId)
  const checkedAt = new Date().toISOString()
  await db.desktopLicense.put({
    key: 'current',
    token: result.license_token,
    device_id: device.deviceId,
    license_id: claims.license_id,
    tenant_id: claims.tenant_id,
    status: claims.status,
    checked_at: checkedAt,
  })
  await db.desktopLicenseEvents.clear()
  await recordLicenseEvent('check_in_confirmed', { license_id: claims.license_id })
  window.dispatchEvent(new CustomEvent('tenga:desktop-license-updated'))
  return claims
}

export function startDesktopLicenseMonitor() {
  if (!window.tengaDesktop?.isDesktop) return () => {}
  let stopped = false
  let retryTimer

  const checkIn = async () => {
    if (stopped || !navigator.onLine) return
    try {
      await checkInDesktopLicense()
    } catch (error) {
      await recordLicenseEvent('check_in_failed', {
        message: String(error?.message || 'License service unreachable'),
      }).catch(() => {})
      if (!stopped) retryTimer = window.setTimeout(checkIn, 60_000)
    }
  }

  const onOnline = () => { void checkIn() }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void checkIn()
  }
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibilityChange)

  void readVerifiedDesktopLicense().then(async (license) => {
    if (!license || !navigator.onLine) return
    const checkedAt = Date.parse(license.checkedAt || '')
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= 24 * 60 * 60 * 1000) {
      await checkIn()
    }
  }).catch(() => {})

  const dailyTimer = window.setInterval(() => { void checkIn() }, 24 * 60 * 60 * 1000)
  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearInterval(dailyTimer)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export async function queueDesktopLicenseEvent(type, details = {}) {
  await recordLicenseEvent(type, details)
}

export function isDesktopLicenseApiConfigured() {
  return Boolean(API_URL && LICENSE_PUBLIC_KEY)
}
