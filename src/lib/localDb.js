import { db } from '@/db'
import { parseOptionalNumber, parseOptionalMoney } from '@/utils/formatters'
import { generateUUID } from '@/lib/uuid'

function mapProduct(product) {
  const category = product.category_id
    ? db.localCategories.get(product.category_id).then((row) => row?.name || '')
    : Promise.resolve(product.category || '')
  return category.then((name) => ({
    ...product,
    stock: product.stock_qty ?? product.stock ?? 0,
    category: name,
    image: product.image_url ?? null,
    barcode: product.barcode ?? '',
  }))
}

function productRecord(tenantId, product, id = generateUUID()) {
  return {
    id,
    tenant_id: tenantId,
    name: String(product.name || '').trim(),
    brand: product.brand || null,
    sku: product.sku || null,
    barcode: product.barcode || null,
    price: parseOptionalMoney(product.price) ?? 0,
    cost_price: parseOptionalMoney(product.landingPrice ?? product.costPrice),
    stock_qty: product.isService ? 0 : (parseOptionalNumber(product.stock) ?? 0),
    low_stock_threshold: parseInt(product.lowStockThreshold, 10) || 10,
    is_service: product.isService === true,
    unit: product.unit || 'each',
    image_url: product.imageUrl || null,
    image_unavailable: product.imageUnavailable === true,
    vat_treatment: product.vatTreatment || 'standard',
    attributes: product.attributes || {},
    branch_id: product.branchId || null,
    category_id: product.categoryId || null,
    price_tiers: (product.priceTiers || []).filter((tier) => Number(tier.min_qty) > 0 && Number(tier.price) >= 0),
    dispensing_class: product.dispensingClass || 'otc',
    controlled_schedule: product.dispensingClass === 'controlled' ? (product.controlledSchedule || null) : null,
    batch_no: product.batchNo || null,
    expiry_date: product.expiryDate || null,
    storage_location: product.storageLocation || null,
    age_restricted: product.ageRestricted === true,
    is_active: true,
    pos_visible: true,
    created_at: new Date().toISOString(),
  }
}

export async function fetchProducts(tenantId) {
  const products = await db.localProducts.where('tenant_id').equals(tenantId).toArray()
  return Promise.all(products.filter((product) => product.is_active !== false).map(mapProduct))
}

export async function insertProduct(tenantId, product) {
  if (!String(product.name || '').trim()) throw new Error('Product name is required')
  const record = productRecord(tenantId, product)
  await db.localProducts.add(record)
  return mapProduct(record)
}

export async function bulkInsertProducts(tenantId, rows, onProgress) {
  const records = rows.map((row) => productRecord(tenantId, row))
  await db.localProducts.bulkPut(records)
  onProgress?.(records.length, records.length)
  return { inserted: records.length, failed: [] }
}

export async function updateProduct(productId, product) {
  const existing = await db.localProducts.get(productId)
  if (!existing) throw new Error('Product not found')
  const record = { ...existing, ...productRecord(existing.tenant_id, { ...existing, ...product }, productId), ...product }
  record.stock_qty = product.stock === undefined ? existing.stock_qty : (parseOptionalNumber(product.stock) ?? 0)
  record.category_id = product.categoryId ?? product.category_id ?? existing.category_id
  record.image_url = product.imageUrl ?? product.image_url ?? existing.image_url
  await db.localProducts.put(record)
  return mapProduct(record)
}

export async function deleteProduct(productId) {
  const product = await db.localProducts.get(productId)
  if (!product) throw new Error('Product not found')
  await db.localProducts.update(productId, { is_active: false })
}

export async function fetchCategories(tenantId) {
  return db.localCategories.where('tenant_id').equals(tenantId).toArray()
}

export async function createCategory(tenantId, { name, color }) {
  const normalized = String(name || '').trim()
  if (!normalized) throw new Error('Category name is required')
  const category = { id: generateUUID(), tenant_id: tenantId, name: normalized, color: color || null }
  await db.localCategories.add(category)
  return category
}

export async function fetchBranches(tenantId) {
  return db.localBranches.where('tenant_id').equals(tenantId).toArray()
}

export async function fetchProductBranches(productId) {
  const product = await db.localProducts.get(productId)
  return product?.branch_id ? [product.branch_id] : []
}

export async function assignProductBranch(productId, branchId) {
  await db.localProducts.update(productId, { branch_id: branchId })
}

export async function unassignProductBranch(productId, branchId) {
  const product = await db.localProducts.get(productId)
  if (product?.branch_id === branchId) await db.localProducts.update(productId, { branch_id: null })
}

export async function uploadProductImage(_tenantId, file) {
  if (!file) return null
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read product image'))
    reader.readAsDataURL(file)
  })
}

export async function fetchUserBranches(userId) {
  const user = await db.localUsers.get(userId)
  return user?.branch_id ? [user.branch_id] : []
}

async function changeStock(tenantId, productId, delta, kind, note = null) {
  const product = await db.localProducts.get(productId)
  if (!product || product.tenant_id !== tenantId) throw new Error('Product not found')
  if (product.is_service) throw new Error("Services don't carry stock")
  const before = Number(product.stock_qty ?? product.stock ?? 0)
  const after = before + Number(delta)
  if (after < 0) throw new Error('Insufficient stock')
  const movement = {
    id: generateUUID(), tenant_id: tenantId, product_id: productId, kind,
    quantity: Number(delta), stock_before: before, stock_after: after,
    note: note || null, created_at: new Date().toISOString(),
  }
  await db.transaction('rw', db.localProducts, db.stockMovements, async () => {
    await db.localProducts.update(productId, { stock_qty: after, stock: after })
    await db.stockMovements.add(movement)
  })
  return movement
}

export async function receiveStock(tenantId, productId, qty, note) {
  if (!(Number(qty) > 0)) throw new Error('Quantity must be greater than zero')
  return changeStock(tenantId, productId, Number(qty), 'receive', note)
}

export async function adjustStock(tenantId, productId, newQty, note) {
  const product = await db.localProducts.get(productId)
  if (!product || product.tenant_id !== tenantId) throw new Error('Product not found')
  const delta = Number(newQty) - Number(product.stock_qty ?? product.stock ?? 0)
  return changeStock(tenantId, productId, delta, 'adjust', note)
}

export async function adjustStockByDelta(tenantId, productId, delta, note) {
  return changeStock(tenantId, productId, Number(delta), 'adjust', note)
}

export async function fetchStockReceipts(tenantId) {
  return (await db.stockMovements.where('tenant_id').equals(tenantId).toArray())
    .filter((row) => row.kind === 'receive')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function fetchStockAdjustments(tenantId) {
  return (await db.stockMovements.where('tenant_id').equals(tenantId).toArray())
    .filter((row) => row.kind === 'adjust')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function fetchStockTransfers() {
  return []
}

export async function transferStock() {
  throw new Error('Stock transfers require multiple branches; this desktop is set up for one shop terminal')
}

function makeReceiptNumber(counter, date = new Date()) {
  const year = date.getFullYear()
  return `TP-${year}-${String(counter).padStart(6, '0')}`
}

export async function fetchTransactionsInRange(tenantId, fromDate, toDate) {
  const rows = await fetchTransactions(tenantId)
  return rows.filter((row) => (!fromDate || row.created_at >= fromDate) && (!toDate || row.created_at <= toDate))
}

export async function fetchVoids() {
  return []
}

export async function fetchReturns() {
  return []
}

export async function saveCheckout(payload) {
  const clientRef = payload.clientRef || generateUUID()
  const existingOrder = await db.orders.where('client_ref').equals(clientRef).first()
  if (existingOrder) return { order: { id: existingOrder.id }, receiptNo: existingOrder.receipt_no }
  if (!payload.cartItems?.length) throw new Error('Cart is empty')

  const branch = payload.branchId ? await db.localBranches.get(payload.branchId) : null
  const orderId = generateUUID()
  const transactionId = generateUUID()
  const createdAt = new Date().toISOString()
  let receiptNo

  await db.transaction(
    'rw',
    db.localProducts,
    db.orders,
    db.orderItems,
    db.transactions,
    db.transactionItems,
    db.payments,
    db.stockMovements,
    db.settings,
    async () => {
      const retryOrder = await db.orders.where('client_ref').equals(clientRef).first()
      if (retryOrder) {
        receiptNo = retryOrder.receipt_no
        return
      }

      const sequence = await db.settings.get('receipt_sequence')
      const next = Number(sequence?.value || 0) + 1
      await db.settings.put({ key: 'receipt_sequence', value: next })
      receiptNo = makeReceiptNumber(next)

      const items = []
      for (const line of payload.cartItems) {
        const product = await db.localProducts.get(line.id)
        if (!product || product.tenant_id !== payload.tenantId || product.is_active === false) {
          throw new Error(`Product not found: ${line.name}`)
        }
        const qty = Number(line.quantity)
        if (!(qty > 0)) throw new Error('Invalid quantity')
        const before = Number(product.stock_qty ?? product.stock ?? 0)
        const after = product.is_service ? before : before - qty
        if (!product.is_service && after < 0) throw new Error(`Insufficient stock for ${product.name}`)
        items.push({
          id: generateUUID(), order_id: orderId, product_id: product.id, tenant_id: payload.tenantId,
          name: product.name, sku: product.sku || null, qty, unit_price: Number(line.price),
          discount: Number(line.itemDiscount || 0),
          total: Number(line.price) * qty * (1 - Number(line.itemDiscount || 0) / 100),
          category_id: product.category_id || null,
        })
        if (!product.is_service) {
          await db.localProducts.update(product.id, { stock_qty: after, stock: after })
          await db.stockMovements.add({
            id: generateUUID(), tenant_id: payload.tenantId, product_id: product.id, kind: 'sale',
            quantity: -qty, stock_before: before, stock_after: after, order_id: orderId,
            created_at: createdAt,
          })
        }
      }

      const order = {
        id: orderId, tenant_id: payload.tenantId, branch_id: payload.branchId || branch?.id || null,
        user_id: payload.userId || null, order_no: receiptNo, receipt_no: receiptNo,
        status: payload.posMode === 'restaurant' ? 'received' : 'completed',
        type: payload.orderType || 'sale', pos_mode: payload.posMode || 'retail',
        subtotal: Number(payload.subtotal), tax_amount: Number(payload.tax),
        discount: Math.max(0, items.reduce((sum, item) => sum + item.unit_price * item.qty, 0) - Number(payload.total)),
        total: Number(payload.total), payment_method: payload.paymentMethod || 'cash',
        created_at: createdAt, client_ref: clientRef,
        salesperson_name: payload.salespersonName || null,
        salesperson_employee_no: payload.salespersonEmployeeNo || null,
        customer_details: payload.customerDetails || null,
        order_items: items,
      }
      await db.orders.add(order)
      await db.orderItems.bulkAdd(items)

      const transaction = {
        receipt_number: receiptNo, order_id: orderId, tenant_id: payload.tenantId,
        branch_id: order.branch_id, amount: Number(payload.total), method: order.payment_method,
        payment_method: order.payment_method, created_at: createdAt, synced: 1,
      }
      const localTransactionId = await db.transactions.add(transaction)
      await db.transactionItems.bulkAdd(items.map((item) => ({
        transaction_id: localTransactionId, product_id: item.product_id, tenant_id: payload.tenantId,
        name: item.name, qty: item.qty, unit_price: item.unit_price, total: item.total,
      })))
      await db.payments.add({
        id: transactionId, order_id: orderId, tenant_id: payload.tenantId,
        amount: Number(payload.total), method: order.payment_method, created_at: createdAt,
      })
    },
  )

  return { order: { id: orderId }, receiptNo }
}

export async function fetchOrders(tenantId, filters = {}) {
  let rows = await db.orders.where('tenant_id').equals(tenantId).toArray()
  if (filters.status) rows = rows.filter((row) => row.status === filters.status)
  if (filters.notStatus) rows = rows.filter((row) => row.status !== filters.notStatus)
  if (filters.posMode) rows = rows.filter((row) => row.pos_mode === filters.posMode)
  if (filters.fromDate) rows = rows.filter((row) => row.created_at >= filters.fromDate)
  if (filters.toDate) rows = rows.filter((row) => row.created_at <= filters.toDate)
  return Promise.all(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(async (row) => ({
    ...row,
    order_items: row.order_items || [],
    users: { name: row.user_id ? (await db.localUsers.get(row.user_id))?.name || '' : '' },
  })))
}

export async function fetchTransactions(tenantId) {
  const rows = await db.transactions.where('tenant_id').equals(tenantId).toArray()
  return Promise.all(rows.map(async (transaction) => {
    const order = await db.orders.get(transaction.order_id)
    const items = await db.transactionItems.where('transaction_id').equals(transaction.id).toArray()
    const user = order?.user_id ? await db.localUsers.get(order.user_id) : null
    const branch = order?.branch_id ? await db.localBranches.get(order.branch_id) : null
    return {
      ...transaction,
      reference: transaction.receipt_number,
      users: { name: user?.name || '—' },
      branches: { name: branch?.name || 'Main' },
      orders: order ? { ...order, order_items: items } : null,
    }
  })).then((transactions) => transactions.sort((a, b) => b.created_at.localeCompare(a.created_at)))
}

export async function fetchStaff(tenantId) {
  const users = await db.localUsers.where('tenant_id').equals(tenantId).toArray()
  return users.filter((user) => user.is_active).map(({ id, name, username, role, branch_id }) => ({ id, name, username, role, branch_id }))
}
