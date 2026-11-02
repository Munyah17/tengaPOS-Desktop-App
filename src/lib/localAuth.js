import { db } from '@/db'
import { generateUUID } from '@/lib/uuid'
import { readVerifiedDesktopLicense } from '@/lib/desktopLicense'

const PASSWORD_ITERATIONS = 310000
const encoder = new TextEncoder()

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value) {
  return new Uint8Array(value.match(/.{1,2}/g).map((part) => parseInt(part, 16)))
}

async function hashPassword(password, salt) {
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return new Uint8Array(bits)
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i]
  return difference === 0
}

export async function getLocalInstallation() {
  const shop = await db.localShop.toCollection().first()
  if (!shop) return null
  const branch = await db.localBranches.where('tenant_id').equals(shop.id).first()
  return { shop, branch: branch || null }
}

export async function createLocalInstallation({ shopName, ownerName, username, password, currency = 'USD' }) {
  const existing = await db.localShop.toCollection().first()
  if (existing) throw new Error('This computer has already been set up')
  if (!globalThis.crypto?.subtle) throw new Error('Secure local password storage is unavailable on this computer')

  const license = await readVerifiedDesktopLicense()
  if (!license) throw new Error('A valid online-confirmed desktop license is required before setup')

  const shopId = license.claims.tenant_id
  const branchId = generateUUID()
  const userId = generateUUID()
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const passwordHash = await hashPassword(password, salt)
  const now = new Date().toISOString()
  const shop = {
    id: shopId,
    name: shopName.trim(),
    currency: license.claims.currency || currency,
    pos_mode: 'retail',
    enabled_modes: ['retail'],
    vat_enabled: false,
    vat_rate: 0,
    status: 'active',
    plan_type: 'local_desktop',
    features: {},
    created_at: now,
    license_id: license.claims.license_id,
  }
  const branch = { id: branchId, tenant_id: shopId, name: 'Main', is_active: true, created_at: now }
  const user = {
    id: userId,
    tenant_id: shopId,
    branch_id: branchId,
    name: ownerName.trim(),
    username: username.trim().toLowerCase(),
    email: null,
    role: 'vendor',
    is_active: true,
    password_salt: bytesToHex(salt),
    password_hash: bytesToHex(passwordHash),
    password_iterations: PASSWORD_ITERATIONS,
    created_at: now,
  }

  await db.transaction('rw', db.localShop, db.localBranches, db.localUsers, db.settings, async () => {
    if (await db.localShop.count()) throw new Error('This computer has already been set up')
    await db.localShop.add(shop)
    await db.localBranches.add(branch)
    await db.localUsers.add(user)
    await db.settings.bulkPut([
      { key: 'local_installation', value: true },
      { key: 'receipt_sequence', value: 0 },
    ])
  })

  return { shop, branch, user }
}

export async function authenticateLocalUser(identifier, password) {
  const normalized = identifier.trim().toLowerCase()
  const user = await db.localUsers.where('username').equals(normalized).first()
    || await db.localUsers.where('email').equals(normalized).first()
  if (!user || !user.is_active) throw new Error('Invalid username or password')

  const expected = hexToBytes(user.password_hash)
  const actual = await hashPassword(password, hexToBytes(user.password_salt))
  if (!equalBytes(expected, actual)) throw new Error('Invalid username or password')

  const installation = await getLocalInstallation()
  if (!installation?.shop) throw new Error('Local shop setup is incomplete')
  return {
    user: { id: user.id, email: user.email, user_metadata: { name: user.name } },
    profile: {
      id: user.id,
      tenant_id: user.tenant_id,
      branch_id: user.branch_id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      is_local: true,
    },
    tenant: installation.shop,
    branch: installation.branch,
    role: user.role,
    userType: 'tenant',
    tenantStatus: 'active',
  }
}
