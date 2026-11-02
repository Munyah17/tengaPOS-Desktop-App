import Dexie from 'dexie'

export const db = new Dexie('tengaPOS')

db.version(1).stores({
  products: '++id, sku, barcode, name, category, tenant_id, branch_id, [tenant_id+branch_id]',
  transactions: '++id, receipt_number, tenant_id, branch_id, created_at, synced, [tenant_id+synced]',
  transactionItems: '++id, transaction_id, product_id, tenant_id',
  categories: '++id, name, tenant_id, branch_id',
  customers: '++id, name, phone, tenant_id',
  syncQueue: '++id, table_name, operation, data, created_at, retries',
  settings: 'key',
})

// retries < 5 used to be the query filter itself -- once a queued sale hit
// that count (as fast as 5 failed attempts ~15s apart, including from
// simply still being offline) it silently stopped being retried forever,
// while pendingSyncCount() (no filter) kept counting it as "pending"
// forever anyway -- a permanently stuck, invisible item with no recovery
// path. `failed` now separates "stop auto-retrying, this needs a person"
// (a real business-logic failure like insufficient stock, which retrying
// can never fix on its own) from "still trying," which now retries with no
// cap -- transient/offline failures always eventually succeed once really
// online instead of getting abandoned after an arbitrary attempt count.
db.version(2).stores({
  syncQueue: '++id, table_name, operation, data, created_at, retries, failed',
}).upgrade((tx) => tx.table('syncQueue').toCollection().modify((item) => {
  if (item.failed === undefined) item.failed = 0
}))

db.version(3).stores({
  products: '++id, sku, barcode, name, category, tenant_id, branch_id, [tenant_id+branch_id]',
  transactions: '++id, receipt_number, tenant_id, branch_id, order_id, payment_method, created_at, synced, [tenant_id+synced]',
  transactionItems: '++id, transaction_id, product_id, tenant_id',
  categories: '++id, name, tenant_id, branch_id',
  customers: '++id, name, phone, tenant_id',
  syncQueue: '++id, table_name, operation, data, created_at, retries, failed',
  settings: 'key',
  localShop: 'id, name',
  localUsers: 'id, &username, email, role, is_active',
  localBranches: 'id, tenant_id, name',
  orders: 'id, tenant_id, branch_id, created_at, status, type, pos_mode, receipt_no, &client_ref',
  orderItems: 'id, order_id, product_id, tenant_id',
  payments: 'id, order_id, tenant_id, created_at, method',
  stockMovements: 'id, product_id, tenant_id, created_at, kind',
})

db.version(4).stores({
  localProducts: 'id, sku, barcode, name, category_id, tenant_id, branch_id, [tenant_id+branch_id]',
  localCategories: 'id, name, tenant_id, branch_id',
})

db.version(5).stores({
  desktopLicense: 'key, device_id, license_id, checked_at, status',
  desktopLicenseKeys: 'key',
  desktopLicenseEvents: '++id, created_at, type',
})

export async function addToSyncQueue(tableName, operation, data) {
  await db.syncQueue.add({
    table_name: tableName,
    operation,
    data,
    created_at: new Date().toISOString(),
    retries: 0,
    failed: 0,
    last_error: null,
  })
}

// Only items still being auto-retried -- excludes ones flagged `failed`
// (a person needs to look at those; see markSyncItemFailed).
export async function getSyncQueueItems() {
  return db.syncQueue.where('failed').equals(0).toArray()
}

export async function removeSyncQueueItem(id) {
  await db.syncQueue.delete(id)
}

export async function markSyncItemFailed(id, error) {
  await db.syncQueue.update(id, { failed: 1, last_error: String(error?.message || error || 'Unknown error') })
}

// Puts a failed item back into the auto-retry pool -- e.g. after a person
// has fixed the underlying cause (restocked the item, etc).
export async function retrySyncItem(id) {
  await db.syncQueue.update(id, { failed: 0, retries: 0, last_error: null })
}

export async function fetchAllSyncQueueItems() {
  return db.syncQueue.orderBy('created_at').reverse().toArray()
}
