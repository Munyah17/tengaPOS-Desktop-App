import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Search, Plus, Upload, Download, ExternalLink, Edit, Trash2,
  AlertTriangle, Package, BarChart3, RefreshCw, ImageOff, ImagePlus, X, ArrowLeftRight, PackagePlus, SlidersHorizontal,
} from 'lucide-react'
import Button from '@/components/common/Button'
import Modal from '@/components/common/Modal'
import ExportMenu from '@/components/common/ExportMenu'
import { formatCurrency, formatUnitPrice, formatDateTime, stripLeadingZero } from '@/utils/formatters'
import { generateTemplate, parseCSV, filterValidImportRows } from '@/utils/exportUtils'
import { UNITS } from '@/lib/units'
import { useThemeStore } from '@/stores/themeStore'
import { useAuthStore } from '@/stores/authStore'
import {
  fetchProducts, insertProduct, bulkInsertProducts, updateProduct, deleteProduct, uploadProductImage,
  fetchBranches, fetchProductBranches, assignProductBranch, unassignProductBranch,
  fetchCategories, createCategory, fetchStockTransfers, transferStock,
  fetchStockReceipts, receiveStock, adjustStock, fetchStockAdjustments,
} from '@/lib/dataLayer'
import { getOfflineProducts, queueOfflineInventoryWrite, queueOfflineAction } from '@/lib/offlineSync'
import { isNetworkError } from '@/lib/authRetry'
import { resizeImageFile } from '@/utils/imageResize'
import toast from 'react-hot-toast'

const BLANK = {
  name: '', brand: '', sku: '', barcode: '', price: '', landingPrice: '',
  stock: '', lowStockThreshold: '10', imageUrl: '', imageUnavailable: false,
  vatTreatment: 'standard', attributePairs: [], branchIds: [], categoryId: '',
  priceTiers: [], dispensingClass: 'otc', controlledSchedule: '', isService: false,
  ageRestricted: false, unit: 'each',
  batchNo: '', expiryDate: '', storageLocation: '',
}

const BLANK_PRICE_TIER = { min_qty: '', price: '' }

const ATTRIBUTE_PRESETS = ['Weight', 'Volume', 'Color', 'Size']

const VAT_TREATMENTS = [
  { key: 'standard', label: 'Standard-rated', hint: 'VAT charged at the normal rate' },
  { key: 'zero_rated', label: 'Zero-rated', hint: '0% VAT — still a taxable supply (e.g. basic foodstuffs, exports)' },
  { key: 'exempt', label: 'Exempt', hint: 'Outside VAT entirely (e.g. medicines, education)' },
]

const DISPENSING_CLASSES = [
  { key: 'otc', label: 'Over-the-counter', hint: 'No prescription needed — sells like any other product' },
  { key: 'prescription', label: 'Prescription required', hint: 'POS requires customer + prescriber details before this can be sold' },
  { key: 'controlled', label: 'Controlled substance', hint: 'Same as prescription, plus a schedule/class recorded on every dispense' },
]

export default function Inventory() {
  const isDesktop = window.tengaDesktop?.isDesktop === true
  const { posMode } = useThemeStore()
  const { tenant, branch } = useAuthStore()
  const isRestaurant = posMode === 'restaurant'
  const isHardware = posMode === 'hardware'
  const isPharmacy = posMode === 'pharmacy'
  const isBar = posMode === 'bar'
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importProgress, setImportProgress] = useState(null) // { done, total } while a mass import is running
  const [editTarget, setEditTarget] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [branches, setBranches] = useState([])
  const [originalBranchIds, setOriginalBranchIds] = useState([])
  const [categories, setCategories] = useState([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [addingCategory, setAddingCategory] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferForm, setTransferForm] = useState({ productId: '', toBranchId: '', qty: '', note: '' })
  const [transferring, setTransferring] = useState(false)
  const [transfers, setTransfers] = useState([])
  const [showReceive, setShowReceive] = useState(false)
  const [receiveForm, setReceiveForm] = useState({ productId: '', qty: '', note: '' })
  const [receiving, setReceiving] = useState(false)
  const [receipts, setReceipts] = useState([])
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustForm, setAdjustForm] = useState({ productId: '', newQty: '', note: '' })
  const [adjusting, setAdjusting] = useState(false)
  const [adjustments, setAdjustments] = useState([])
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!tenant?.id) return
    fetchBranches(tenant.id).then(setBranches).catch(() => toast.error("Couldn't load branches"))
  }, [tenant?.id])

  const loadTransfers = () => {
    if (!tenant?.id) return
    fetchStockTransfers(tenant.id).then(setTransfers).catch(() => {})
  }
  useEffect(loadTransfers, [tenant?.id])

  const openTransfer = () => {
    setTransferForm({ productId: '', toBranchId: '', qty: '', note: '' })
    setShowTransfer(true)
  }

  const loadReceipts = () => {
    if (!tenant?.id) return
    fetchStockReceipts(tenant.id).then(setReceipts).catch(() => {})
  }
  useEffect(loadReceipts, [tenant?.id])

  const openReceive = () => {
    setReceiveForm({ productId: '', qty: '', note: '' })
    setShowReceive(true)
  }

  const loadAdjustments = () => {
    if (!tenant?.id) return
    fetchStockAdjustments(tenant.id).then(setAdjustments).catch(() => {})
  }
  useEffect(loadAdjustments, [tenant?.id])

  const loadCategories = () => {
    if (!tenant?.id) return
    fetchCategories(tenant.id).then(setCategories).catch(() => {})
  }
  useEffect(loadCategories, [tenant?.id])

  const addCategory = async () => {
    if (!newCategoryName.trim()) return
    setAddingCategory(true)
    try {
      const created = await createCategory(tenant.id, { name: newCategoryName.trim() })
      setCategories((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setForm((f) => ({ ...f, categoryId: created.id }))
      setNewCategoryName('')
      toast.success('Category added')
    } catch (err) {
      toast.error(err.message || 'Failed to add category')
    } finally {
      setAddingCategory(false)
    }
  }

  const queryClient = useQueryClient()
  // Same cache key as POS's product query — editing a product here makes
  // POS see the change immediately too, without either page re-fetching
  // from scratch just because the other one changed something.
  const productsQuery = useQuery({
    queryKey: ['products', tenant?.id],
    queryFn: async () => {
      try {
        return await fetchProducts(tenant.id)
      } catch {
        // Same offline-cache fallback POS already uses — AppLayout keeps this
        // cache warm in the background, so it's rarely more than a minute stale.
        const cached = await getOfflineProducts(tenant.id)
        if (cached.length > 0) {
          toast('Offline — showing cached inventory', { icon: '📴' })
          return cached
        }
        throw new Error('Failed to load products')
      }
    },
    enabled: !!tenant?.id,
    staleTime: 30000,
  })
  const products = productsQuery.data || []
  const loading = productsQuery.isLoading

  const transferProduct = products.find((p) => p.id === transferForm.productId)
  const transferDestBranches = branches.filter((b) => b.id !== transferProduct?.branch_id)

  const handleTransfer = async (e) => {
    e.preventDefault()
    const qty = Number(transferForm.qty)
    if (!transferForm.productId) { toast.error('Choose a product'); return }
    if (!transferForm.toBranchId) { toast.error('Choose a destination branch'); return }
    if (!qty || qty <= 0) { toast.error('Enter a quantity greater than zero'); return }
    setTransferring(true)
    try {
      await transferStock(tenant.id, transferForm.productId, transferForm.toBranchId, qty, transferForm.note.trim() || null)
      toast.success('Stock transferred')
      queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
      loadTransfers()
      setShowTransfer(false)
    } catch (err) {
      // Same principle as POS checkout: attempt the real call first and
      // only treat it as offline if the network itself failed, rather
      // than pre-guessing off navigator.onLine (unreliable -- see
      // offlineSync.js). A genuine server rejection (branch mismatch,
      // insufficient stock) surfaces immediately instead of being queued
      // to fail the exact same way again later.
      if (isNetworkError(err)) {
        await queueOfflineAction('transfer_stock', { tenantId: tenant.id, productId: transferForm.productId, toBranchId: transferForm.toBranchId, qty, note: transferForm.note.trim() || null })
        toast('Offline — transfer saved, will sync automatically', { icon: '📴' })
        setShowTransfer(false)
      } else {
        toast.error(err.message || 'Failed to transfer stock')
      }
    } finally {
      setTransferring(false)
    }
  }

  const receiveProduct = products.find((p) => p.id === receiveForm.productId)

  const handleReceive = async (e) => {
    e.preventDefault()
    const qty = Number(receiveForm.qty)
    if (!receiveForm.productId) { toast.error('Choose a product'); return }
    if (!qty || qty <= 0) { toast.error('Enter a quantity greater than zero'); return }
    setReceiving(true)
    try {
      await receiveStock(tenant.id, receiveForm.productId, qty, receiveForm.note.trim() || null)
      toast.success('Stock added')
      queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
      loadReceipts()
      setShowReceive(false)
    } catch (err) {
      if (isNetworkError(err)) {
        await queueOfflineAction('receive_stock', { tenantId: tenant.id, productId: receiveForm.productId, qty, note: receiveForm.note.trim() || null })
        // Optimistic bump so the addition shows up right away instead of
        // waiting for the eventual sync -- same treatment offline product
        // inserts/edits already get.
        queryClient.setQueryData(['products', tenant.id], (old) =>
          (old || []).map((p) => p.id === receiveForm.productId ? { ...p, stock: (p.stock ?? 0) + qty, stock_qty: (p.stock_qty ?? 0) + qty } : p))
        toast('Offline — stock added, will sync automatically', { icon: '📴' })
        setShowReceive(false)
      } else {
        toast.error(err.message || 'Failed to add stock')
      }
    } finally {
      setReceiving(false)
    }
  }

  const openAdjust = (productId = '') => {
    const p = products.find((pr) => pr.id === productId)
    setAdjustForm({ productId, newQty: p ? String(p.stock ?? p.stock_qty ?? 0) : '', note: '' })
    setShowAdjust(true)
  }

  const adjustProduct = products.find((p) => p.id === adjustForm.productId)

  const handleAdjust = async (e) => {
    e.preventDefault()
    const newQty = Number(adjustForm.newQty)
    if (!adjustForm.productId) { toast.error('Choose a product'); return }
    if (adjustForm.newQty === '' || isNaN(newQty) || newQty < 0) { toast.error('Enter a valid quantity'); return }
    setAdjusting(true)
    try {
      await adjustStock(tenant.id, adjustForm.productId, newQty, adjustForm.note.trim() || null)
      toast.success('Stock quantity updated')
      queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
      loadAdjustments()
      setShowAdjust(false)
    } catch (err) {
      if (isNetworkError(err)) {
        // Queued as a DELTA (this correction's intent, captured right
        // now), not the absolute newQty -- adjust_stock_by_delta applies
        // it on top of whatever stock genuinely is by the time this
        // finally syncs, instead of stomping it with a stale number.
        const delta = newQty - (adjustProduct?.stock_qty ?? adjustProduct?.stock ?? 0)
        await queueOfflineAction('adjust_stock', { tenantId: tenant.id, productId: adjustForm.productId, delta, note: adjustForm.note.trim() || null })
        queryClient.setQueryData(['products', tenant.id], (old) =>
          (old || []).map((p) => p.id === adjustForm.productId ? { ...p, stock: newQty, stock_qty: newQty } : p))
        toast('Offline — correction saved, will sync automatically', { icon: '📴' })
        setShowAdjust(false)
      } else {
        toast.error(err.message || 'Failed to adjust stock')
      }
    } finally {
      setAdjusting(false)
    }
  }

  // Paint instantly from the local cache (already kept warm by AppLayout's
  // background sync) instead of a blank loading state, while the query above
  // fetches a fresh copy in the background and replaces it when it lands.
  useEffect(() => {
    if (!tenant?.id) return
    if (queryClient.getQueryData(['products', tenant.id])) return
    getOfflineProducts(tenant.id).then((cached) => {
      if (cached.length > 0) queryClient.setQueryData(['products', tenant.id], cached)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id])

  useEffect(() => {
    if (productsQuery.isError) toast.error('Failed to load products')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsQuery.isError])

  const filtered = useMemo(() => {
    if (!search) return products
    const q = search.toLowerCase()
    return products.filter(
      p => (p.name || '').toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.barcode || '').includes(q) ||
        (p.category || '').toLowerCase().includes(q)
    )
  }, [products, search])

  const stats = useMemo(() => ({
    total: products.length,
    lowStock: products.filter(p => !p.is_service && p.stock_qty <= (p.low_stock_threshold ?? 10)).length,
    totalValue: products.reduce((s, p) => s + parseFloat(p.price || 0) * (p.stock_qty ?? p.stock ?? 0), 0),
  }), [products])

  const resetImagePicker = () => {
    setImageFile(null)
    setImagePreview('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openAdd = () => {
    // Non-vendor staff default to their own branch — matches "1 branch
    // unless manually assigned"; vendors default to unassigned (all branches).
    const defaultBranchIds = branch?.id ? [branch.id] : []
    setForm({ ...BLANK, branchIds: defaultBranchIds })
    setOriginalBranchIds([])
    setEditTarget(null)
    resetImagePicker()
    setShowAdd(true)
  }
  const openEdit = async (p) => {
    let extraBranchIds = []
    try {
      extraBranchIds = await fetchProductBranches(p.id)
    } catch { /* non-fatal — just starts with none pre-selected */ }
    const branchIds = [...new Set([p.branch_id, ...extraBranchIds].filter(Boolean))]
    setForm({
      name: p.name,
      brand: p.brand || '',
      sku: p.sku || '',
      barcode: p.barcode || '',
      price: p.price ?? '',
      landingPrice: p.cost_price ?? '',
      // stock_qty (the raw column, preserved through fetchProducts' spread)
      // is checked before the derived `stock` display field, which itself
      // already defaults to 0 -- re-opening a product with genuinely unset
      // stock must show blank here, not silently re-save it as 0 the
      // moment any other field on the form gets edited.
      stock: p.stock_qty ?? '',
      lowStockThreshold: p.low_stock_threshold ?? 10,
      imageUrl: p.image_url || p.image || '',
      imageUnavailable: p.image_unavailable === true,
      vatTreatment: p.vat_treatment || 'standard',
      attributePairs: Object.entries(p.attributes || {}).map(([key, value]) => ({ key, value })),
      branchIds,
      categoryId: p.category_id || '',
      priceTiers: (p.price_tiers || []).map((t) => ({ min_qty: String(t.min_qty), price: String(t.price) })),
      dispensingClass: p.dispensing_class || 'otc',
      controlledSchedule: p.controlled_schedule || '',
      batchNo: p.batch_no || '',
      expiryDate: p.expiry_date || '',
      storageLocation: p.storage_location || '',
      isService: p.is_service === true,
      ageRestricted: p.age_restricted === true,
      unit: p.unit || 'each',
    })
    setOriginalBranchIds(branchIds)
    setEditTarget(p)
    resetImagePicker()
    setShowAdd(true)
  }
  const toggleBranch = (branchId) => setForm((f) => ({
    ...f,
    branchIds: f.branchIds.includes(branchId)
      ? f.branchIds.filter((id) => id !== branchId)
      : [...f.branchIds, branchId],
  }))

  const handleImagePick = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { toast.error('Image must be under 5MB'); return }
    // Shrink to a thumbnail-appropriate size before it ever reaches upload --
    // this is what actually renders everywhere (POS grid, search, this list),
    // so there's no reason to ship a multi-MB camera photo for a 36px tile.
    const resized = await resizeImageFile(file)
    setImageFile(resized)
    setImagePreview(URL.createObjectURL(resized))
    setForm((f) => ({ ...f, imageUnavailable: false }))
  }

  // Product Image is mandatory unless the "not available" override is ticked.
  // Stock is optional -- some vendors add the product record first and
  // count/enter actual stock later; left blank, it saves as 0 (out of
  // stock until updated), same as the Mass Import template already does.
  const hasImage = !!(imagePreview || form.imageUrl)
  // price, like stock, is optional -- some vendors record a product before
  // it's been priced. Blank saves as NULL (see parseOptionalMoney in
  // db.js), distinct from an explicit $0.00.
  const canSave = form.name && (hasImage || form.imageUnavailable)

  const addAttributePreset = (preset) => {
    setForm((f) => {
      if (f.attributePairs.some((p) => p.key.toLowerCase() === preset.toLowerCase())) return f
      return { ...f, attributePairs: [...f.attributePairs, { key: preset, value: '' }] }
    })
  }
  const addAttributePair = () => setForm((f) => ({ ...f, attributePairs: [...f.attributePairs, { key: '', value: '' }] }))
  const updateAttributePair = (i, field, val) => setForm((f) => ({
    ...f,
    attributePairs: f.attributePairs.map((p, idx) => (idx === i ? { ...p, [field]: val } : p)),
  }))
  const removeAttributePair = (i) => setForm((f) => ({ ...f, attributePairs: f.attributePairs.filter((_, idx) => idx !== i) }))

  const addPriceTier = () => setForm((f) => ({ ...f, priceTiers: [...f.priceTiers, { ...BLANK_PRICE_TIER }] }))
  const updatePriceTier = (i, field, val) => setForm((f) => ({
    ...f,
    priceTiers: f.priceTiers.map((t, idx) => (idx === i ? { ...t, [field]: val } : t)),
  }))
  const removePriceTier = (i) => setForm((f) => ({ ...f, priceTiers: f.priceTiers.filter((_, idx) => idx !== i) }))

  const handleSave = async (e) => {
    e.preventDefault()
    if (isDesktop && imageFile) {
      try {
        const dataUrl = await uploadProductImage(tenant.id, imageFile)
        setForm((current) => ({ ...current, imageUrl: dataUrl }))
        setImagePreview(dataUrl)
        setImageFile(null)
      } catch (error) {
        toast.error(error.message || 'Could not save product image')
        return
      }
    }
    if (!hasImage && !form.imageUnavailable) {
      toast.error('Add a product image, or tick "Product Image Not Available"')
      return
    }
    setSaving(true)
    const offline = !isDesktop && !navigator.onLine
    try {
      let imageUrl = form.imageUrl
      // Can't upload to Storage without a connection — keep whatever image
      // URL already exists (edits) or go blank for now (new products); the
      // tenant can attach the photo once they're reconnected.
      if (imageFile && !offline) {
        setUploadingImage(true)
        imageUrl = await uploadProductImage(tenant.id, imageFile)
        setUploadingImage(false)
      }
      const attributes = form.attributePairs.reduce((acc, p) => {
        if (p.key.trim()) acc[p.key.trim()] = p.value
        return acc
      }, {})
      const priceTiers = form.priceTiers
        .map((t) => ({ min_qty: Number(t.min_qty) || 0, price: Number(t.price) || 0 }))
        .filter((t) => t.min_qty > 0)
        .sort((a, b) => a.min_qty - b.min_qty)
      // First checked branch becomes the "home" branch_id; any further ones
      // are extra grants recorded in product_branches.
      const [primaryBranchId, ...extraBranchIds] = form.branchIds
      const payload = { ...form, imageUrl: form.imageUnavailable ? '' : imageUrl, attributes, priceTiers, branchId: primaryBranchId || null }

      let productId = editTarget?.id

      if (offline) {
        // Offline: queue the write and patch the cache optimistically so the
        // product shows up right away — same treatment as offline POS sales.
        await queueOfflineInventoryWrite(editTarget ? 'update' : 'insert', tenant.id, payload, editTarget?.id)
        if (editTarget) {
          // stock is never part of an edit anymore (the field is disabled
          // above) -- keep whatever's already cached rather than the
          // form's snapshot, which can be stale by the time this queued
          // write finally syncs.
          queryClient.setQueryData(['products', tenant.id], (old) =>
            (old || []).map(p => p.id === editTarget.id ? { ...p, ...payload, stock: p.stock } : p))
        } else {
          queryClient.setQueryData(['products', tenant.id], (old) => [...(old || []), { ...payload, id: `offline-${Date.now()}`, stock: payload.stock }])
        }
        toast('Offline — product saved, will sync automatically', { icon: '📴' })
        setShowAdd(false)
        return
      }

      try {
        if (editTarget) {
          const updated = await updateProduct(editTarget.id, payload)
          const newCategoryName = categories.find((c) => c.id === updated.category_id)?.name || ''
          queryClient.setQueryData(['products', tenant.id], (old) =>
            (old || []).map(p => p.id === editTarget.id ? { ...updated, stock: updated.stock_qty, category: newCategoryName } : p))
          toast.success('Product updated')
        } else {
          const created = await insertProduct(tenant.id, payload)
          productId = created.id
          queryClient.setQueryData(['products', tenant.id], (old) => [...(old || []), created])
          toast.success('Product added')
        }
      } catch (err) {
        if (isDesktop) throw err
        // Network/server error mid-save — queue it rather than lose the edit
        await queueOfflineInventoryWrite(editTarget ? 'update' : 'insert', tenant.id, payload, editTarget?.id)
        toast('Connection issue — product saved, will sync automatically', { icon: '📴' })
        setShowAdd(false)
        return
      }

      // Reconcile extra branch grants against whatever was there before.
      const previousExtra = originalBranchIds.filter((id) => id !== primaryBranchId)
      const toAdd = extraBranchIds.filter((id) => !previousExtra.includes(id))
      const toRemove = previousExtra.filter((id) => !extraBranchIds.includes(id))
      await Promise.allSettled([
        ...toAdd.map((id) => assignProductBranch(productId, id)),
        ...toRemove.map((id) => unassignProductBranch(productId, id)),
      ])

      setShowAdd(false)
    } catch (err) {
      toast.error(err.message || 'Failed to save product')
    } finally {
      setSaving(false)
      setUploadingImage(false)
    }
  }

  const handleDelete = async (id) => {
    try {
      await deleteProduct(id)
      queryClient.setQueryData(['products', tenant.id], (old) => (old || []).filter(p => p.id !== id))
      toast.success('Product deleted')
    } catch (err) {
      toast.error(navigator.onLine ? (err.message || 'Failed to delete') : "You're offline — deleting needs a connection")
    }
  }

  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const data = await parseCSV(file)
      const rows = filterValidImportRows(data)
      if (rows.length === 0) {
        toast.error('No valid rows found — check the template format')
        return
      }
      setSaving(true)
      setImportProgress({ done: 0, total: rows.length })
      const productRows = rows.map((row) => {
        const attributes = {}
        if (row.weight) attributes.Weight = String(row.weight)
        if (row.volume) attributes.Volume = String(row.volume)
        if (row.color) attributes.Color = String(row.color)
        if (row.size) attributes.Size = String(row.size)
        return {
          name: row.name,
          brand: row.brand,
          sku: row.sku,
          barcode: row.barcode,
          price: row.price,
          landingPrice: row.landing_price,
          stock: row.stock,
          lowStockThreshold: row.low_stock_threshold,
          vatTreatment: ['standard', 'zero_rated', 'exempt'].includes(row.vat_treatment) ? row.vat_treatment : 'standard',
          attributes,
          // Bulk-imported rows are assumed to have no photo yet — flagged for follow-up
          imageUnavailable: true,
        }
      })
      const { inserted, total, failedChunks } = await bulkInsertProducts(
        tenant.id, productRows, (done, totalRows) => setImportProgress({ done, total: totalRows })
      )
      queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
      setShowImport(false)
      if (failedChunks.length > 0) {
        toast.error(`${inserted} of ${total} imported — ${failedChunks.length} batch(es) failed: ${failedChunks[0].message}`)
      } else {
        toast.success(`${inserted} of ${total} products imported — add photos from the product list when ready`)
      }
    } catch {
      toast.error('Failed to parse file — use the downloaded template format')
    } finally {
      setSaving(false)
      setImportProgress(null)
    }
  }

  // Headers match Mass Import's expected column names exactly (lowercase,
  // snake_case) -- so exporting the current inventory and using that file
  // as a re-import template (a real workflow, reported live) round-trips
  // cleanly, the same as the dedicated "Download CSV Template" button.
  // Deliberately excludes id/tenant_id/timestamps/other internal columns
  // that used to leak straight into CSV/Excel/Access exports (see
  // exportUtils.js's shapeRows) -- those broke re-import entirely and
  // have no meaning outside this one tenant's database anyway.
  const exportColumns = [
    { header: 'name', key: 'name' },
    { header: 'sku', key: 'sku' },
    { header: 'barcode', key: 'barcode' },
    { header: 'price', key: 'price' },
    { header: 'landing_price', key: 'cost_price' },
    { header: 'stock', key: 'stock_qty' },
    { header: 'low_stock_threshold', key: 'low_stock_threshold' },
    { header: 'brand', key: 'brand' },
    { header: 'vat_treatment', key: 'vat_treatment' },
  ]

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white">Inventory</h1>
          <p className="text-sm text-slate-500">Manage your products and stock levels</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="http://scancode.co.zw" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Get Barcodes <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button onClick={() => productsQuery.refetch()} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300" title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Button variant="secondary" onClick={() => setShowImport(true)}>
            <Upload className="h-4 w-4" /> Mass Import
          </Button>
          <ExportMenu data={products} columns={exportColumns} title="Inventory" filename="tengapos_inventory" />
          <Button variant="secondary" onClick={openReceive}>
            <PackagePlus className="h-4 w-4" /> Add Stock
          </Button>
          <Button variant="secondary" onClick={() => openAdjust()}>
            <SlidersHorizontal className="h-4 w-4" /> Adjust Stock
          </Button>
          {branches.length > 1 && (
            <Button variant="secondary" onClick={openTransfer}>
              <ArrowLeftRight className="h-4 w-4" /> Transfer Stock
            </Button>
          )}
          <Button variant={isRestaurant ? 'restaurant' : isHardware ? 'hardware' : isPharmacy ? 'pharmacy' : 'primary'} onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add Product
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {[
          { label: 'Total Products', value: stats.total, icon: Package, color: 'brand' },
          { label: 'Low Stock Items', value: stats.lowStock, icon: AlertTriangle, color: 'amber' },
          { label: 'Total Inventory Value', value: formatCurrency(stats.totalValue), icon: BarChart3, color: 'green' },
        ].map(stat => (
          <div key={stat.label} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3">
              <div className={`rounded-xl p-2 ${stat.color === 'brand' ? 'bg-brand-100 text-brand-600 dark:bg-brand-900 dark:text-brand-400' : stat.color === 'amber' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' : 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400'}`}>
                <stat.icon className="h-4 w-4" />
              </div>
              <div>
                <div className="text-xs text-slate-500">{stat.label}</div>
                <div className="text-xl font-extrabold text-slate-900 dark:text-white">{stat.value}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search products by name, SKU, barcode, or category..."
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-400">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading products…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                  {['Product', 'SKU', 'Category', 'Price', 'Stock', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="py-12 text-center text-sm text-slate-400">
                    {products.length === 0 ? 'No products yet — add your first product to get started.' : 'No products match your search.'}
                  </td></tr>
                ) : filtered.map(product => {
                  const stockQty = product.stock_qty ?? product.stock ?? 0
                  const threshold = product.low_stock_threshold ?? 10
                  const img = product.image_url || product.image
                  return (
                    <motion.tr
                      key={product.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="border-b border-slate-100 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
                            {img
                              ? <img src={img} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                              : <ImageOff className="h-4 w-4 text-slate-400" />}
                          </div>
                          <div className="min-w-0">
                            <span className="truncate text-sm font-medium text-slate-900 dark:text-white">{product.name}</span>
                            {product.brand && <p className="truncate text-xs text-slate-400">{product.brand}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{product.sku || '—'}</td>
                      <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">
                        {product.category
                          ? <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{product.category}</span>
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900 dark:text-white">{formatUnitPrice(product.price)}</td>
                      <td className="px-4 py-3">
                        {product.is_service ? (
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">Service</span>
                        ) : (
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${stockQty <= 0 ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' : stockQty <= threshold ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'}`}>
                            {stockQty}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {!product.is_service && (
                            <button onClick={() => openAdjust(product.id)} title="Adjust stock" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800">
                              <SlidersHorizontal className="h-4 w-4" />
                            </button>
                          )}
                          <button onClick={() => openEdit(product)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800">
                            <Edit className="h-4 w-4" />
                          </button>
                          <button onClick={() => handleDelete(product.id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent stock additions -- the audit trail requested alongside
          "Add Stock", separate from branch transfers so the two kinds of
          movement are never confused with each other. */}
      {receipts.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recent Stock Additions</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                  {['Date', 'Product', 'Qty Added', 'By', 'Note'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(r.created_at)}</td>
                    <td className="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">{r.products?.name || '—'}</td>
                    <td className="px-4 py-2 text-sm font-semibold text-green-600 dark:text-green-400">+{r.qty}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{r.users?.name || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent direct corrections -- kept separate from Recent Stock
          Additions, since these can go either direction and always
          include the reason a human gave for the change. */}
      {adjustments.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recent Stock Adjustments</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                  {['Date', 'Product', 'Was', 'Now', 'Change', 'By', 'Reason'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(a.created_at)}</td>
                    <td className="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">{a.products?.name || '—'}</td>
                    <td className="px-4 py-2 text-sm text-slate-500">{a.previous_qty}</td>
                    <td className="px-4 py-2 text-sm font-semibold text-slate-900 dark:text-white">{a.new_qty}</td>
                    <td className={`px-4 py-2 text-sm font-semibold ${a.delta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {a.delta >= 0 ? '+' : ''}{a.delta}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">{a.users?.name || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">{a.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Stock Modal */}
      <Modal isOpen={showReceive} onClose={() => setShowReceive(false)} title="Add Stock">
        <form onSubmit={handleReceive} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Product</label>
            <select
              value={receiveForm.productId}
              onChange={(e) => setReceiveForm((f) => ({ ...f, productId: e.target.value }))}
              required
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="">Select existing product…</option>
              {products.filter((p) => !p.is_service).map((p) => (
                <option key={p.id} value={p.id}>{p.name} (current stock: {p.stock_qty ?? 0})</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">Adding a brand-new product instead? Use "Add Product" — this is only for topping up something you already stock.</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Quantity to Add</label>
            <input
              type="number" min="0.01" step="any" value={receiveForm.qty}
              onChange={(e) => setReceiveForm((f) => ({ ...f, qty: e.target.value }))}
              required
              placeholder="e.g. 20"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
            {receiveProduct && Number(receiveForm.qty) > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {receiveProduct.stock_qty ?? 0} + {Number(receiveForm.qty)} = <b>{(receiveProduct.stock_qty ?? 0) + Number(receiveForm.qty)}</b> new stock
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Note (optional)</label>
            <input
              type="text" value={receiveForm.note}
              onChange={(e) => setReceiveForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="e.g. supplier delivery, invoice #1234"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <p className="text-xs text-slate-500">
            This adds to the current stock — it never overwrites it, and every addition is logged above with who did it and when.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={() => setShowReceive(false)}>Cancel</Button>
            <Button type="submit" disabled={receiving}>{receiving ? 'Adding…' : 'Add Stock'}</Button>
          </div>
        </form>
      </Modal>

      {/* Adjust Stock Modal — a direct correction (can go up or down),
          distinct from Add Stock (always additive, for deliveries). Safe
          against the same stale-snapshot problem the disabled Edit Product
          stock field had: adjust_stock locks the row and computes the
          delta against the real, current stock_qty at save time, not
          whatever this modal showed when it opened. */}
      <Modal isOpen={showAdjust} onClose={() => setShowAdjust(false)} title="Adjust Stock">
        <form onSubmit={handleAdjust} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Product</label>
            <select
              value={adjustForm.productId}
              onChange={(e) => {
                const p = products.find((pr) => pr.id === e.target.value)
                setAdjustForm((f) => ({ ...f, productId: e.target.value, newQty: p ? String(p.stock ?? p.stock_qty ?? 0) : '' }))
              }}
              required
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="">Select product…</option>
              {products.filter((p) => !p.is_service).map((p) => (
                <option key={p.id} value={p.id}>{p.name} (current stock: {p.stock_qty ?? 0})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Correct Quantity To</label>
            <input
              type="number" min="0" step="any" value={adjustForm.newQty}
              onChange={(e) => setAdjustForm((f) => ({ ...f, newQty: e.target.value }))}
              required
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
            {adjustProduct && adjustForm.newQty !== '' && !isNaN(Number(adjustForm.newQty)) && (
              <p className="mt-1 text-xs text-slate-500">
                {adjustProduct.stock_qty ?? 0} → <b>{Number(adjustForm.newQty)}</b>{' '}
                ({Number(adjustForm.newQty) - (adjustProduct.stock_qty ?? 0) >= 0 ? '+' : ''}{Number(adjustForm.newQty) - (adjustProduct.stock_qty ?? 0)})
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Reason (optional)</label>
            <input
              type="text" value={adjustForm.note}
              onChange={(e) => setAdjustForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="e.g. damaged, miscount, shrinkage"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <p className="text-xs text-slate-500">
            Sets stock to exactly this number — use this for corrections. Every adjustment is logged below with who made it and the reason.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={() => setShowAdjust(false)}>Cancel</Button>
            <Button type="submit" disabled={adjusting}>{adjusting ? 'Saving…' : 'Save Correction'}</Button>
          </div>
        </form>
      </Modal>

      {/* Recent branch-to-branch stock transfers */}
      {branches.length > 1 && transfers.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Recent Transfers</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                  {['Date', 'Product', 'From', 'To', 'Qty', 'By', 'Note'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(t.created_at)}</td>
                    <td className="px-4 py-2 text-sm text-slate-700 dark:text-slate-300">{t.products?.name || '—'}</td>
                    <td className="px-4 py-2 text-sm text-slate-500">{t.from_branch?.name || 'Unassigned'}</td>
                    <td className="px-4 py-2 text-sm text-slate-500">{t.to_branch?.name || '—'}</td>
                    <td className="px-4 py-2 text-sm font-semibold text-slate-900 dark:text-white">{t.qty}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{t.users?.name || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">{t.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transfer Stock Modal */}
      <Modal isOpen={showTransfer} onClose={() => setShowTransfer(false)} title="Transfer Stock Between Branches">
        <form onSubmit={handleTransfer} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Product</label>
            <select
              value={transferForm.productId}
              onChange={(e) => setTransferForm((f) => ({ ...f, productId: e.target.value, toBranchId: '' }))}
              required
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="">Select product…</option>
              {products.map((p) => {
                const homeBranch = branches.find((b) => b.id === p.branch_id)
                return <option key={p.id} value={p.id}>{p.name}{homeBranch ? ` — ${homeBranch.name}` : ''} (stock: {p.stock_qty ?? p.stock ?? 0})</option>
              })}
            </select>
          </div>
          {transferProduct && (
            <p className="text-xs text-slate-500">
              {transferProduct.stock_qty ?? transferProduct.stock ?? 0} in stock
              {transferProduct.branch_id ? ` at ${branches.find((b) => b.id === transferProduct.branch_id)?.name || 'its branch'}` : ' (not attached to a branch)'}.
            </p>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Destination Branch</label>
            <select
              value={transferForm.toBranchId}
              onChange={(e) => setTransferForm((f) => ({ ...f, toBranchId: e.target.value }))}
              required
              disabled={!transferForm.productId}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="">Select branch…</option>
              {transferDestBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Quantity</label>
            <input
              type="number" min="1" step="1" value={transferForm.qty}
              onChange={(e) => setTransferForm((f) => ({ ...f, qty: e.target.value }))}
              required
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Note (optional)</label>
            <input
              type="text" value={transferForm.note}
              onChange={(e) => setTransferForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="e.g. restocking after weekend rush"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <p className="text-xs text-slate-500">
            Moves stock immediately — if the destination branch doesn't already have this product, it's created there automatically.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={() => setShowTransfer(false)}>Cancel</Button>
            <Button type="submit" disabled={transferring}>{transferring ? 'Transferring…' : 'Transfer Stock'}</Button>
          </div>
        </form>
      </Modal>

      {/* Add / Edit Modal */}
      <Modal isOpen={showAdd} onClose={() => setShowAdd(false)} title={editTarget ? 'Edit Product' : 'Add Product'}>
        <form onSubmit={handleSave} className="space-y-4">
          {/* Product vs Service — a service (labour, consultations, wheel
              alignment, etc.) never restocks, so it has no quantity field
              and is never blocked by "insufficient stock" at checkout. */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">Type</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, isService: false }))}
                className={`rounded-xl border px-4 py-2.5 text-sm font-semibold ${!form.isService ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}
              >
                Product
              </button>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, isService: true }))}
                className={`rounded-xl border px-4 py-2.5 text-sm font-semibold ${form.isService ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}
              >
                Service
              </button>
            </div>
            {form.isService && (
              <p className="mt-1.5 text-xs text-slate-500">No stock quantity — services never run out.</p>
            )}
          </div>

          {/* Product image — mandatory unless overridden */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Product Image {!form.imageUnavailable && <span className="text-red-500">*</span>}
            </label>
            <div className="flex items-center gap-3">
              <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
                {imagePreview || form.imageUrl ? (
                  <img src={imagePreview || form.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImagePlus className="h-6 w-6 text-slate-400" />
                )}
              </div>
              <div className="flex-1">
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImagePick} className="hidden" id="product-image-input" />
                <label htmlFor="product-image-input" className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  <Upload className="h-3.5 w-3.5" /> Upload Photo
                </label>
                {(imagePreview || form.imageUrl) && (
                  <button
                    type="button"
                    onClick={() => { resetImagePicker(); setForm((f) => ({ ...f, imageUrl: '' })) }}
                    className="ml-2 inline-flex items-center gap-1 text-xs text-red-500 hover:underline"
                  >
                    <X className="h-3 w-3" /> Remove
                  </button>
                )}
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={form.imageUnavailable}
                    onChange={(e) => setForm((f) => ({ ...f, imageUnavailable: e.target.checked }))}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Product Image Not Available
                </label>
              </div>
            </div>
          </div>

          {[
            { label: 'Product Name *', field: 'name', type: 'text', required: true },
            { label: 'Brand', field: 'brand', type: 'text', required: false },
            { label: 'SKU', field: 'sku', type: 'text', required: false },
            { label: 'Barcode', field: 'barcode', type: 'text', required: false },
            { label: 'Selling Price (VAT-inclusive, leave blank to price later)', field: 'price', type: 'number', required: false, money: true },
            { label: 'Landing Price (what it cost you)', field: 'landingPrice', type: 'number', required: false, money: true },
            ...(form.isService ? [] : [
              {
                label: editTarget ? 'Stock Quantity' : 'Stock Quantity (leave blank to enter later)',
                field: 'stock', type: 'number', required: false,
                // Editing an existing product's stock number here used to
                // silently overwrite it with whatever was on screen when
                // this form opened -- if a sale or a stock receipt landed
                // on this product in the meantime, that real change got
                // reverted with no error or trace. Correcting stock now
                // only ever happens through Add Stock / Stock Take /
                // Transfer Stock, which apply a safe, locked adjustment
                // instead of an unconditional overwrite.
                disabled: !!editTarget,
                hint: editTarget ? 'Use Adjust Stock, Add Stock, Stock Take, or Transfer Stock to change this.' : undefined,
              },
              { label: 'Low Stock Alert At', field: 'lowStockThreshold', type: 'number', required: false },
            ]),
          ].map(f => (
            <div key={f.field}>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{f.label}</label>
              <input
                type={f.type}
                value={form[f.field]}
                onChange={e => setForm({ ...form, [f.field]: f.type === 'number' ? stripLeadingZero(e.target.value) : e.target.value })}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-800/60 dark:disabled:text-slate-500"
                required={f.required}
                min={f.type === 'number' ? '0' : undefined}
                step={f.money ? '0.0001' : undefined}
                disabled={f.disabled}
              />
              {f.hint && <p className="mt-1 text-xs text-slate-400">{f.hint}</p>}
            </div>
          ))}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Category</label>
            <select
              value={form.categoryId}
              onChange={e => setForm({ ...form, categoryId: e.target.value })}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="">No category</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="mt-1.5 flex gap-1.5">
              <input
                type="text"
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                placeholder="e.g. Tyres, Lubricants, Suspension Parts"
                className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
              <button
                type="button"
                onClick={addCategory}
                disabled={addingCategory || !newCategoryName.trim()}
                className="flex-shrink-0 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300"
              >
                + Add
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">VAT Treatment</label>
            <select
              value={form.vatTreatment}
              onChange={e => setForm({ ...form, vatTreatment: e.target.value })}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {VAT_TREATMENTS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {VAT_TREATMENTS.find(t => t.key === form.vatTreatment)?.hint}
            </p>
          </div>
          {isPharmacy && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Dispensing Class</label>
              <select
                value={form.dispensingClass}
                onChange={e => setForm({ ...form, dispensingClass: e.target.value })}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {DISPENSING_CLASSES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {DISPENSING_CLASSES.find(c => c.key === form.dispensingClass)?.hint}
              </p>
              {form.dispensingClass === 'controlled' && (
                <input
                  type="text"
                  value={form.controlledSchedule}
                  onChange={e => setForm({ ...form, controlledSchedule: e.target.value })}
                  placeholder="Schedule / class — e.g. Schedule II"
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              )}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Batch No.</label>
                  <input
                    type="text"
                    value={form.batchNo}
                    onChange={e => setForm({ ...form, batchNo: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Expiry Date</label>
                  <input
                    type="date"
                    value={form.expiryDate}
                    onChange={e => setForm({ ...form, expiryDate: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Storage Location</label>
                <input
                  type="text"
                  value={form.storageLocation}
                  onChange={e => setForm({ ...form, storageLocation: e.target.value })}
                  placeholder="e.g. Shelf A3, Cold Storage"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </div>
          )}
          {isBar && (
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
              <input
                type="checkbox"
                checked={form.ageRestricted}
                onChange={(e) => setForm({ ...form, ageRestricted: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="font-medium text-slate-700 dark:text-slate-300">Age-Restricted (18+)</span>
                <span className="block text-xs text-slate-500">Requires an ID check at checkout before this can be sold.</span>
              </span>
            </label>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Attributes</label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {ATTRIBUTE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => addAttributePreset(preset)}
                  className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  + {preset}
                </button>
              ))}
              <button
                type="button"
                onClick={addAttributePair}
                className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              >
                + Custom
              </button>
            </div>
            {form.attributePairs.length > 0 && (
              <div className="space-y-2">
                {form.attributePairs.map((pair, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      value={pair.key}
                      onChange={(e) => updateAttributePair(i, 'key', e.target.value)}
                      placeholder="Attribute (e.g. Weight)"
                      className="w-1/3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    />
                    <input
                      type="text"
                      value={pair.value}
                      onChange={(e) => updateAttributePair(i, 'value', e.target.value)}
                      placeholder="Value (e.g. 500g)"
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttributePair(i)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {isHardware && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Sold By</label>
              <select
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">Weight/length/volume units let the POS take a decimal quantity (e.g. 2.5kg) instead of whole units only.</p>
            </div>
          )}
          {isHardware && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Bulk Pricing</label>
                <button type="button" onClick={addPriceTier} className="text-xs font-semibold text-orange-600 hover:underline dark:text-orange-400">+ Add Tier</button>
              </div>
              <p className="mb-2 text-xs text-slate-500">
                Charge a lower price per unit once a customer buys enough — e.g. 10+ at $4.50 instead of the regular price. The highest tier a sale qualifies for applies automatically.
              </p>
              {form.priceTiers.length > 0 && (
                <div className="space-y-2">
                  {form.priceTiers.map((tier, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-xs text-slate-500">Qty ≥</span>
                      <input
                        type="number" min="1" step="1" value={tier.min_qty}
                        onChange={(e) => updatePriceTier(i, 'min_qty', stripLeadingZero(e.target.value))}
                        placeholder="10"
                        className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                      />
                      <span className="flex-shrink-0 text-xs text-slate-500">→ price</span>
                      <input
                        type="number" min="0" step="0.0001" value={tier.price}
                        onChange={(e) => updatePriceTier(i, 'price', stripLeadingZero(e.target.value))}
                        placeholder="4.50"
                        className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                      />
                      <button type="button" onClick={() => removePriceTier(i)} className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {branches.length > 1 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Branches</label>
              <p className="mb-1.5 text-xs text-slate-500">
                {form.branchIds.length === 0
                  ? 'Not attached to a branch — visible at every branch.'
                  : 'Only visible/sellable at the branches checked below.'}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {branches.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={form.branchIds.includes(b.id)}
                      onChange={() => toggleBranch(b.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <ExternalLink className="h-3.5 w-3.5" />
            <a href="http://scancode.co.zw" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Need barcodes? Visit scancode.co.zw</a>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !canSave}>
              {uploadingImage ? 'Uploading image…' : saving ? 'Saving…' : (editTarget ? 'Save Changes' : 'Add Product')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Mass Import Modal */}
      <Modal isOpen={showImport} onClose={() => setShowImport(false)} title="Mass Import Inventory">
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Add your whole inventory in one upload. Download the CSV template, fill it in, then upload it back.
            Prices are VAT-inclusive — enter the shelf price customers actually pay.
          </p>
          <Button variant="secondary" onClick={generateTemplate}><Download className="h-4 w-4" /> Download CSV Template</Button>
          {importProgress ? (
            <div className="rounded-xl border-2 border-dashed border-brand-300 p-8 text-center dark:border-brand-700">
              <RefreshCw className="mx-auto mb-2 h-8 w-8 animate-spin text-brand-500" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Importing {importProgress.done} of {importProgress.total}…
              </p>
              <div className="mx-auto mt-3 h-2 w-full max-w-xs overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className="h-full rounded-full bg-brand-600 transition-all"
                  style={{ width: `${Math.round((importProgress.done / importProgress.total) * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-xl border-2 border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
              <Upload className="mx-auto mb-2 h-8 w-8 text-slate-400" />
              <p className="text-sm text-slate-600 dark:text-slate-400">Drop your CSV file here or click to browse</p>
              <p className="mt-1 text-xs text-slate-400">Handles huge catalogs — thousands of products import in batches with live progress.</p>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={handleImport} disabled={saving} className="mt-3 text-sm" />
            </div>
          )}
          <p className="text-xs text-slate-500">
            Imported products are flagged "Image Not Available" — add photos individually afterwards from the product list.
          </p>
        </div>
      </Modal>
    </div>
  )
}
