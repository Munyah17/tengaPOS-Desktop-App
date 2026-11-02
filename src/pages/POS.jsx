import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Barcode, Plus, Minus, Trash2, ShoppingCart,
  CreditCard, Banknote, Smartphone, Receipt, X, Car, Store, Package as PackageIcon,
  RefreshCw, ExternalLink, Camera, Percent, DoorOpen, ShieldAlert, UserPlus,
} from 'lucide-react'
import Button from '@/components/common/Button'
import Modal from '@/components/common/Modal'
import ZimraReceipt from '@/components/common/ZimraReceipt'
import { useCartStore } from '@/stores/cartStore'
import { useThemeStore } from '@/stores/themeStore'
import { useAuthStore } from '@/stores/authStore'
import { useReceiptConfigStore } from '@/stores/receiptConfigStore'
import { PAYMENT_METHODS } from '@/utils/constants'
import { formatCurrency, formatUnitPrice, generateReceiptNumber, stripLeadingZero } from '@/utils/formatters'
import { FRACTIONAL_UNITS, unitStep } from '@/lib/units'
import { initiatePaynowCheckout } from '@/lib/paynow'
import { fetchProducts, saveCheckout, fetchStaff, completeJobCard, recordPrescriptionDispense, recordAgeVerification } from '@/lib/dataLayer'
import { authorizeDiscountOverride, fetchPrescriptions, logDrawerOpen, triggerSosAlert, findOrCreateCustomer, createVehicle } from '@/lib/db'
import { kickCashDrawer } from '@/lib/posPrinter'
import { isDemoRoute } from '@/lib/demoMode'
import { getOfflineProducts, queueOfflineSale } from '@/lib/offlineSync'
import { isNetworkError } from '@/lib/authRetry'
import { generateUUID } from '@/lib/uuid'
import { supabase } from '@/lib/supabase'
import { useFiscalStore } from '@/stores/fiscalStore'
import toast from 'react-hot-toast'

const restaurantCategories = [
  { id: 'all', name: 'All' },
  { id: 'mains', name: 'Mains' },
  { id: 'starters', name: 'Starters' },
  { id: 'drinks', name: 'Drinks' },
  { id: 'desserts', name: 'Desserts' },
]

// Cart quantity: always a real input, not a click-to-reveal span. The
// previous version only became editable after tapping the number, with the
// only hint being a hover title tooltip -- invisible on the touchscreen
// tablets this app actually runs on, so bulk-quantity users (manufacturing
// especially) never discovered it and were stuck clicking +/- one at a
// time. Own local draft state per row so N cart rows can each be typed
// into independently without fighting a single shared field.
function CartQtyField({ item, onCommit }) {
  const [draft, setDraft] = useState(String(item.quantity))
  const [focused, setFocused] = useState(false)
  const isFractional = FRACTIONAL_UNITS.includes(item.unit)

  useEffect(() => {
    if (!focused) setDraft(String(item.quantity))
  }, [item.quantity, focused])

  const commit = () => {
    setFocused(false)
    const n = isFractional ? parseFloat(draft) : parseInt(draft, 10)
    if (Number.isFinite(n) && n > 0) {
      const applied = onCommit(n)
      // updateQuantity silently caps at available stock -- surface it, or a
      // bulk quantity that gets quietly truncated reads as "typing didn't work."
      if (applied != null && applied !== n) toast.error(`Only ${applied} in stock — quantity capped`)
    } else {
      setDraft(String(item.quantity))
    }
  }

  return (
    <input
      type="number"
      min={unitStep(item.unit)}
      step={isFractional ? '0.01' : '1'}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(stripLeadingZero(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      className="w-14 rounded-lg border border-slate-300 bg-white px-1 py-0.5 text-center text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
    />
  )
}

export default function POS() {
  const isDesktop = window.tengaDesktop?.isDesktop === true
  const { posMode } = useThemeStore()
  const { tenant, user, branch, role } = useAuthStore()
  const receiptConfig = useReceiptConfigStore()
  const isRestaurant = posMode === 'restaurant'
  // VAT only actually applies when it's both activated as a plan feature
  // (tenant.features.vat -- a Super Admin-approved add-on) AND not switched
  // off by the tenant themselves. tenant.vat_enabled alone isn't enough --
  // it defaults truthy even for tenants who never activated VAT at all, so
  // gating on it alone would silently charge VAT despite the feature never
  // being turned on.
  const vatActive = tenant?.features?.vat === true && tenant?.vat_enabled !== false
  const cart = useCartStore()
  const fiscal = useFiscalStore()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [showReceipt, setShowReceipt] = useState(false)
  const [receiptData, setReceiptData] = useState(null)
  const [paynowLoading, setPaynowLoading] = useState(false)
  const [showMobileCart, setShowMobileCart] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [checkingOut, setCheckingOut] = useState(false)
  const [amountTendered, setAmountTendered] = useState('')
  const [staffList, setStaffList] = useState([])
  const [showSalesperson, setShowSalesperson] = useState(false)
  const [salespersonMode, setSalespersonMode] = useState('staff') // 'staff' | 'manual'
  const [salespersonStaffId, setSalespersonStaffId] = useState('')
  const [salespersonManualName, setSalespersonManualName] = useState('')
  const [salespersonManualEmpNo, setSalespersonManualEmpNo] = useState('')
  // Customer Details capture (features.customer_details add-on -- currently
  // Siyaya Fit only). Optional, collapsible like Salesperson: closed it
  // costs one line, opened it asks for who the sale is for so the vendor
  // can actually contact them again afterwards. jobDone is deliberately a
  // single short line -- the receipt has no room for a paragraph.
  const customerDetailsEnabled = tenant?.features?.customer_details === true
  const [showCustomer, setShowCustomer] = useState(false)
  const [customerForm, setCustomerForm] = useState({
    name: '', phone: '', email: '', vehicle: '', regNumber: '',
    accountType: 'individual', companyName: '', jobDone: '',
  })
  // Pharmacy Mode: prescription/controlled-substance capture. Data-driven
  // (checks each cart line's own dispensing_class) rather than gated on
  // posMode === 'pharmacy' -- a non-pharmacy tenant could still stock a
  // handful of scheduled items, and the compliance record should never be
  // skippable just because the tenant's overall mode is something else.
  const [showPrescriptionModal, setShowPrescriptionModal] = useState(false)
  const [prescriptionForm, setPrescriptionForm] = useState({ customerName: '', prescriberName: '', prescriberLicenseNo: '' })
  // Optional: pick a prescription already filed in the Prescriptions page
  // instead of retyping the prescriber every time -- pre-fills the free-text
  // fields above from the doctor record when one is selected, but never
  // required (skip it and the existing free-text-only flow works unchanged).
  // Skipped entirely on /demo, same as the discount-auth modal, since
  // there's no real filed-prescription data to pick from there.
  const [filedPrescriptions, setFiledPrescriptions] = useState([])
  const [linkedPrescription, setLinkedPrescription] = useState(null)
  useEffect(() => {
    if (!showPrescriptionModal || isDemoRoute() || isDesktop || !tenant?.id) return
    fetchPrescriptions(tenant.id).then((rows) => setFiledPrescriptions(rows.filter((p) => p.status === 'active'))).catch(() => {})
  }, [showPrescriptionModal, tenant?.id, isDesktop])
  // Bar/Liquor Store Mode: same data-driven pattern as pharmacyItems above.
  const [showAgeVerifyModal, setShowAgeVerifyModal] = useState(false)
  const [ageVerifyForm, setAgeVerifyForm] = useState({ verified: false, idType: '', idLast4: '' })
  // Discount >10% needs a manager's own login to authorize (process_checkout
  // enforces this server-side regardless -- this is just the UI for it).
  // Skipped entirely in the /demo sandbox, where there's no real manager
  // account to log into and nothing at stake either way.
  const [showDiscountAuthModal, setShowDiscountAuthModal] = useState(false)
  const [discountAuthForm, setDiscountAuthForm] = useState({ email: '', password: '' })
  const [authorizingDiscount, setAuthorizingDiscount] = useState(false)
  // No-Sale — opening the drawer outside a completed sale (making change,
  // a till float adjustment) used to leave zero trace. Never blocked on
  // review (a cashier can't queue behind a manager mid-shift just to make
  // change), but every open is logged with a reason and queued for one —
  // see Security.jsx / 1786300000_drawer_events_and_sos.sql.
  const [showNoSaleModal, setShowNoSaleModal] = useState(false)
  const [noSaleReason, setNoSaleReason] = useState('change')
  const [noSaleNote, setNoSaleNote] = useState('')
  const [loggingNoSale, setLoggingNoSale] = useState(false)
  const videoRef = useRef(null)
  const scanStreamRef = useRef(null)
  const fmt = (n) => formatCurrency(n, tenant?.currency)
  // Per-unit price display only -- a product genuinely priced in
  // fractions of a cent ("$1 for 8" = $0.1250 each) should show as what
  // it is, not silently round to $0.13. Line/order totals stay on fmt().
  const fmtUnit = (n) => formatUnitPrice(n, tenant?.currency)

  const queryClient = useQueryClient()
  // Cached (staleTime) instead of a hard fetch-on-every-mount — a cashier
  // bouncing between POS and another tab isn't re-downloading the whole
  // catalogue every time on a slow connection.
  const productsQuery = useQuery({
    queryKey: ['products', tenant?.id],
    queryFn: async () => {
      try {
        return await fetchProducts(tenant.id)
      } catch {
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
  const liveProducts = productsQuery.data || []
  const productsLoading = productsQuery.isLoading

  useEffect(() => {
    if (productsQuery.isError) toast.error('Failed to load products')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsQuery.isError])

  // VAT config comes from the tenant's own settings (inclusive pricing)
  useEffect(() => {
    if (tenant) cart.setVatConfig(vatActive, tenant.vat_rate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatActive, tenant?.vat_rate])

  // Staff available to pick as Salesperson — scoped to this branch when one
  // is set, otherwise every staff member on the tenant.
  useEffect(() => {
    if (!tenant?.id) return
    fetchStaff(tenant.id)
      .then((rows) => setStaffList(branch?.id ? rows.filter((r) => r.branch_id === branch.id) : rows))
      .catch(() => {})
  }, [tenant?.id, branch?.id])

  // ─── Camera barcode scanning (phone/tablet camera via BarcodeDetector) ───
  const stopScanner = () => {
    scanStreamRef.current?.getTracks().forEach((t) => t.stop())
    scanStreamRef.current = null
    setShowScanner(false)
  }

  const handleBarcodeFound = (code) => {
    const product = products.find((p) => p.barcode && p.barcode === code)
    if (product) {
      cart.addItem(product)
      toast.success(`${product.name} added`)
      stopScanner()
    } else {
      setSearch(code)
      toast(`No product with barcode ${code}`, { icon: '🔍' })
      stopScanner()
    }
  }

  const startScanner = async () => {
    if (!('BarcodeDetector' in window)) {
      toast.error('Camera scanning needs Chrome/Edge on Android or desktop. USB/Bluetooth scanners work in the search box.')
      return
    }
    setShowScanner(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      scanStreamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      const detector = new window.BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
      })
      const tick = async () => {
        if (!scanStreamRef.current || !videoRef.current) return
        try {
          const codes = await detector.detect(videoRef.current)
          if (codes.length > 0) {
            handleBarcodeFound(codes[0].rawValue)
            return
          }
        } catch { /* frame not ready */ }
        if (scanStreamRef.current) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } catch (err) {
      stopScanner()
      toast.error(err.name === 'NotAllowedError'
        ? 'Camera permission denied — allow camera access to scan'
        : 'Could not open the camera')
    }
  }

  // Hardware scanners type the barcode + Enter into the search box
  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter' && search.trim()) {
      const product = products.find((p) => p.barcode && p.barcode === search.trim())
      if (product) {
        cart.addItem(product)
        setSearch('')
        toast.success(`${product.name} added`)
      }
    }
  }

  const products = liveProducts
  const categories = isRestaurant ? restaurantCategories : [{ id: 'all', name: 'All' }]

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        (p.name || '').toLowerCase().includes(search.toLowerCase()) ||
        (p.sku || '').toLowerCase().includes(search.toLowerCase()) ||
        (p.barcode || '').includes(search)
      const matchCategory = category === 'all' || p.category === category
      return matchSearch && matchCategory
    })
  }, [products, search, category])

  const pharmacyItems = useMemo(
    () => cart.items.filter((i) => i.dispensing_class === 'prescription' || i.dispensing_class === 'controlled'),
    [cart.items]
  )
  const barItems = useMemo(
    () => cart.items.filter((i) => i.age_restricted === true),
    [cart.items]
  )

  // Mobile-money methods run through Paynow's hosted checkout, never manually
  const PAYNOW_METHODS = ['ecocash', 'innbucks', 'omari', 'onemoney', 'zipit']
  const availablePaymentMethods = isDesktop
    ? PAYMENT_METHODS.filter((method) => ['cash', 'pos_terminal'].includes(method.id))
    : PAYMENT_METHODS.slice(0, 6)
  const tenderedAmount = parseFloat(amountTendered) || 0
  const changeDue = Math.max(0, tenderedAmount - cart.getGrandTotal())
  const cashShortfall = cart.paymentMethod === 'cash' && amountTendered !== '' && tenderedAmount < cart.getGrandTotal()

  // Resolved only if the cashier actually opened the Salesperson section and
  // it has a name either way (picked from staff, or typed in). Left blank
  // otherwise so the receipt stays silent about it — no "Salesperson: —" line.
  const selectedSalesperson = staffList.find((s) => s.id === salespersonStaffId)
  const salespersonName = !showSalesperson ? ''
    : salespersonMode === 'staff' ? (selectedSalesperson?.name || '')
    : salespersonManualName.trim()
  const salespersonEmployeeNo = !showSalesperson ? ''
    : salespersonMode === 'staff' ? (selectedSalesperson?.employee_no || '')
    : salespersonManualEmpNo.trim()

  const resetSalesperson = () => {
    setShowSalesperson(false)
    setSalespersonMode('staff')
    setSalespersonStaffId('')
    setSalespersonManualName('')
    setSalespersonManualEmpNo('')
  }

  const resetCustomer = () => {
    setShowCustomer(false)
    setCustomerForm({
      name: '', phone: '', email: '', vehicle: '', regNumber: '',
      accountType: 'individual', companyName: '', jobDone: '',
    })
  }

  // Only ever a real object when the section is open AND something was
  // actually typed -- an opened-but-empty form must not print a bare
  // "Customer:" line or store an empty JSON blob on the order.
  const customerDetails = (() => {
    if (!showCustomer) return null
    const f = customerForm
    const details = {
      name: f.name.trim() || null,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      vehicle: f.vehicle.trim() || null,
      regNumber: f.regNumber.trim() || null,
      accountType: f.accountType,
      companyName: f.accountType === 'company' ? f.companyName.trim() || null : null,
      jobDone: f.jobDone.trim() || null,
    }
    // accountType alone doesn't count -- only actual typed data makes this
    // a real customer, otherwise an opened-then-untouched form prints a
    // meaningless "Individual" line on every receipt.
    return ['name', 'phone', 'email', 'vehicle', 'regNumber', 'companyName', 'jobDone'].some((k) => details[k])
      ? details
      : null
  })()

  // Gate on the prescriber/ID capture before actually charging anything —
  // never take payment for a prescription/controlled or age-restricted
  // item without the compliance details already in hand.
  const handleCheckoutClick = () => {
    if (pharmacyItems.length > 0 && !prescriptionForm.prescriberName.trim()) {
      setShowPrescriptionModal(true)
      return
    }
    if (barItems.length > 0 && !ageVerifyForm.verified) {
      setShowAgeVerifyModal(true)
      return
    }
    // Discount changes clear cart.discountAuthId (see cartStore.js), so a
    // stale authorization from an earlier, different discount can never
    // silently cover this one -- if it's set, it's for this exact sale.
    // A vendor is already the top of the discount-approval chain (they're
    // who a shop_manager/supervisor's own authorization ultimately answers
    // to, and they can self-authorize up to 100% anyway) -- making them log
    // into their own account a second time mid-checkout to approve their
    // own discount is pure friction with no actual control behind it.
    // process_checkout enforces this same exemption server-side.
    if (!isDesktop && !isDemoRoute() && role !== 'vendor' && cart.getEffectiveDiscountPct() > 10 && !cart.discountAuthId) {
      setShowDiscountAuthModal(true)
      return
    }
    handleCheckout()
  }

  const handleAuthorizeDiscount = async () => {
    if (!discountAuthForm.email.trim() || !discountAuthForm.password) {
      toast.error('Manager email and password are required')
      return
    }
    setAuthorizingDiscount(true)
    try {
      const result = await authorizeDiscountOverride(
        tenant.id, branch?.id || null, user?.id || null,
        discountAuthForm.email.trim(), discountAuthForm.password,
        Math.min(100, Math.ceil(cart.getEffectiveDiscountPct()))
      )
      cart.setDiscountAuthId(result.id)
      setShowDiscountAuthModal(false)
      setDiscountAuthForm({ email: '', password: '' })
      toast.success('Discount authorized')
      handleCheckoutClick()
    } catch (err) {
      toast.error(err.message || 'Could not authorize this discount')
    } finally {
      setAuthorizingDiscount(false)
    }
  }

  const handleNoSale = async () => {
    if (!tenant?.id) { toast.error('Not signed in yet — wait a moment and try again'); return }
    setLoggingNoSale(true)
    try {
      await logDrawerOpen(tenant.id, branch?.id || null, noSaleReason, noSaleNote.trim() || null)
      // Best-effort -- not every till has a drawer wired up, and that's a
      // completely normal setup, not an error. The log entry above is
      // what actually matters for accountability either way.
      kickCashDrawer(receiptConfig.printerConnection, receiptConfig.comPort).catch(() => {})
      toast.success('Drawer opened — logged for review')
      setShowNoSaleModal(false)
      setNoSaleNote('')
      setNoSaleReason('change')
    } catch (err) {
      toast.error(err.message || 'Failed to open drawer')
    } finally {
      setLoggingNoSale(false)
    }
  }

  // Silent by design (see 1786300000_drawer_events_and_sos.sql / the
  // sos-alert function's own comment) -- no loading state, no toast, no
  // visible change on screen at all, so it's safe to press during an
  // active threat without it being noticed. navigator.vibrate is the one
  // acknowledgment: felt only by whoever's holding the device.
  const handleSos = () => {
    if (!tenant?.id) return
    triggerSosAlert(branch?.id || null).catch(() => { /* best-effort, never surfaced */ })
    try { navigator.vibrate?.(200) } catch { /* not supported on this device -- fine */ }
  }

  const handleCheckout = async () => {
    if (cart.items.length === 0) {
      toast.error('Cart is empty')
      return
    }
    if (PAYNOW_METHODS.includes(cart.paymentMethod)) {
      // Redirect to Paynow — it completes the payment, our return page polls for 30s
      return handlePaynowCheckout()
    }
    if (!tenant?.id) {
      // Previously this silently fell through: no order saved, nothing
      // queued offline, yet the receipt still showed and "Transaction
      // completed!" still toasted — a session/auth-store race looked
      // identical to a real sale with nothing to show for it afterwards.
      toast.error('Not signed in yet — wait a moment and try again')
      return
    }
    // Give the button a paint frame before the network work (INP fix)
    setCheckingOut(true)
    await new Promise((r) => setTimeout(r, 30))
    const subtotal = cart.getSubtotal()
    const tax = cart.getTax()
    const total = cart.getGrandTotal()

    let receiptNumber = generateReceiptNumber(tenant?.name, cart.items[0]?.name)
    // The real dedup key (see saveCheckout/process_checkout) -- generated
    // once, up front, and reused on every retry (live retry via the
    // offline queue, or a background sync replay) so a retried sale is
    // recognized as the same sale server-side instead of being processed
    // — and stock-decremented — a second time. receiptNumber alone isn't
    // safe for this (too few possible values, can collide with an
    // unrelated sale), which is exactly why clientRef exists.
    const clientRef = generateUUID()
    let completedOrderId = null

    let fdmsQrUrl = null

    if (tenant?.id) {
      const checkoutPayload = {
        tenantId: tenant.id,
        branchId: branch?.id || null,
        userId: user?.id || null,
        cartItems: cart.items,
        paymentMethod: cart.paymentMethod,
        subtotal,
        tax,
        total,
        posMode,
        orderType: isRestaurant ? (cart.orderType || 'counter') : 'sale',
        receiptNo: receiptNumber,
        clientRef,
        salespersonName: salespersonName || null,
        salespersonEmployeeNo: salespersonEmployeeNo || null,
        discountAuthId: cart.discountAuthId || null,
        customerDetails,
      }

      // navigator.onLine is only a hint, not ground truth — it's well known
      // to report "offline" on some WiFi/VPN/firewall setups even when the
      // connection actually works, which previously sent every sale straight
      // to the offline queue (never recorded, stock never decremented) on
      // affected networks. The real network attempt is the only reliable
      // signal, so it always runs first; only an actual failure falls back
      // to queueing.
      try {
        const result = await saveCheckout(checkoutPayload)
        receiptNumber = result.receiptNo
        completedOrderId = result.order?.id || null
        // We already know exactly what was decremented — patch the cache
        // locally instead of firing a whole new products query for data
        // we can compute ourselves.
        queryClient.setQueryData(['products', tenant.id], (old) =>
          (old || []).map((p) => {
            const line = cart.items.find((i) => i.id === p.id)
            return line ? { ...p, stock: Math.max(0, (p.stock ?? 0) - line.quantity) } : p
          })
        )
        if (window.tengaDesktop?.isDesktop) {
          queryClient.invalidateQueries({ queryKey: ['transactions', tenant.id] })
          queryClient.invalidateQueries({ queryKey: ['orders', tenant.id] })
        }
        // Cash sale, drawer needs to open -- best-effort, same reasoning
        // as the No-Sale kick: plenty of tills have no drawer wired up at
        // all, and that's completely normal, not something to surface as
        // an error on an otherwise-successful sale.
        if (cart.paymentMethod === 'cash') {
          kickCashDrawer(receiptConfig.printerConnection, receiptConfig.comPort).catch(() => {})
        }
      } catch (err) {
        const msg = err.message || 'unknown'
        if (msg.includes('Insufficient stock') || msg.includes('Stock check failed')) {
          // Hard stop — never sell what isn't in stock
          toast.error(msg)
          setCheckingOut(false)
          // Stock actually IS stale here (that's why the sale failed) —
          // this one genuinely needs a fresh read, not an optimistic patch.
          queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
          return
        }
        if (!isNetworkError(err)) {
          // A real server-side rejection (auth, validation, a bad request) —
          // never silently queue this as if it were a dropped connection.
          // Queuing it would just retry the exact same bad request forever
          // and hide the actual problem behind a misleading "offline" toast.
          toast.error(msg)
          setCheckingOut(false)
          return
        }
        // Genuine connectivity failure — queue it rather than lose the sale.
        await queueOfflineSale(checkoutPayload)
        toast('Connection issue — sale saved, will sync automatically', { icon: '📴' })
      }

      // Submit to ZIMRA FDMS if fiscal day is open
      if (!isDesktop && fiscal.isEnabled && fiscal.isRegistered && fiscal.fiscalDayStatus === 'open') {
        try {
          const { data: fdmsData, error: fdmsErr } = await supabase.functions.invoke(
            'zimra-submit-receipt',
            {
              body: {
                tenant_id: tenant.id,
                receipt: {
                  receiptNumber,
                  items: cart.items.map((i) => ({ name: i.name, price: i.price, quantity: i.quantity })),
                  subtotal,
                  tax,
                  total,
                  paymentMethod: cart.paymentMethod,
                  date: new Date().toISOString(),
                  vatRate: cart.vatEnabled ? cart.vatRate : 0,
                  currency: tenant?.currency || 'USD',
                },
              },
            },
          )
          if (!fdmsErr && fdmsData && !fdmsData.error) {
            fiscal.incrementReceiptNo()
            if (fdmsData.fdmsHash) fiscal.setLastReceiptHash(fdmsData.fdmsHash)
            fdmsQrUrl = fdmsData.receiptQrUrl || null
            if (fdmsData.warning) {
              toast(`Fiscalised locally — ZIMRA unreachable: ${fdmsData.warning}`, { duration: 5000 })
            }
          }
        } catch {
          // Non-blocking — the sale is already saved; fiscal failure is not fatal
        }
      }
    }

    // Customer retention (Siyaya Fit's whole reason for this feature):
    // the captured name/phone/email feed the customers table so a real
    // contact list builds up over time, matched by phone then name --
    // repeat customers deepen one record instead of duplicating. Purely
    // best-effort like the compliance logs below: the sale itself already
    // succeeded, so a failure here is never a checkout error.
    if (!isDesktop && customerDetails?.name && tenant?.id) {
      findOrCreateCustomer(tenant.id, {
        name: customerDetails.name,
        phone: customerDetails.phone,
        email: customerDetails.email,
      }).then((customerId) => {
        if (customerId && (customerDetails.vehicle || customerDetails.regNumber)) {
          return createVehicle(tenant.id, customerId, {
            make: customerDetails.vehicle,
            regNumber: customerDetails.regNumber,
          }).catch(() => {})
        }
      }).catch(() => {})
    }

    // Job card -> POS checkout loop: this sale came from "Complete & Issue
    // Receipt" on a job card (JobCards.jsx), so stamp that job card
    // completed and link it to the order that was just created.
    if (!isDesktop && cart.sourceJobCardId && completedOrderId) {
      // Payment is already taken at this point -- a failure here must never
      // look like nothing happened. Previously swallowed silently, which
      // was indistinguishable from success: the sale completed but the job
      // card just never showed up as done, with no error anywhere to explain
      // why.
      completeJobCard(cart.sourceJobCardId, completedOrderId).catch((err) => {
        toast.error(`Payment taken, but couldn't mark the job card complete: ${err.message || 'unknown error'} — mark it manually.`, { duration: 8000 })
      })
    }

    // Pharmacy Mode compliance log — one row per prescription/controlled
    // line item, same prescriber/customer details captured once for the
    // whole basket. Best-effort like the fiscal submission above: the sale
    // itself already succeeded, so a logging failure here shouldn't look
    // like the transaction failed, but it also shouldn't be silent —
    // missing a controlled-substance compliance record is a real problem
    // someone needs to know about and fix (e.g. re-enter it manually).
    if (!isDesktop && pharmacyItems.length > 0 && completedOrderId) {
      for (const item of pharmacyItems) {
        recordPrescriptionDispense(tenant.id, {
          branchId: branch?.id || null,
          orderId: completedOrderId,
          productId: item.id,
          qty: item.quantity,
          customerId: linkedPrescription?.customer_id || null,
          customerName: prescriptionForm.customerName.trim() || null,
          prescriberName: prescriptionForm.prescriberName.trim(),
          prescriberLicenseNo: prescriptionForm.prescriberLicenseNo.trim() || null,
          dispensingClass: item.dispensing_class,
          controlledSchedule: item.controlled_schedule || null,
          userId: user?.id || null,
          prescriptionId: linkedPrescription?.id || null,
        }).catch((err) => {
          toast.error(`Sale completed, but couldn't log the dispensing record for ${item.name}: ${err.message || 'unknown error'} — record it manually.`, { duration: 8000 })
        })
      }
      setPrescriptionForm({ customerName: '', prescriberName: '', prescriberLicenseNo: '' })
      setLinkedPrescription(null)
    }

    // Bar/Liquor Store Mode compliance log — same best-effort, never-silent
    // treatment as the prescription log above.
    if (!isDesktop && barItems.length > 0 && completedOrderId) {
      for (const item of barItems) {
        recordAgeVerification(tenant.id, {
          branchId: branch?.id || null,
          orderId: completedOrderId,
          productId: item.id,
          qty: item.quantity,
          idType: ageVerifyForm.idType.trim() || null,
          idLast4: ageVerifyForm.idLast4.trim() || null,
          userId: user?.id || null,
        }).catch((err) => {
          toast.error(`Sale completed, but couldn't log the age verification for ${item.name}: ${err.message || 'unknown error'} — record it manually.`, { duration: 8000 })
        })
      }
      setAgeVerifyForm({ verified: false, idType: '', idLast4: '' })
    }

    const grossTotal = cart.items.reduce((s, i) => s + i.price * i.quantity, 0)
    const receipt = {
      receiptNumber,
      items: cart.items,
      subtotal,
      tax,
      total,
      discountAmount: Math.max(0, grossTotal - total),
      paymentMethod: cart.paymentMethod,
      date: new Date().toISOString(),
      cashier: useAuthStore.getState().profile?.name || 'Cashier',
      fdmsQrUrl,
      vatEnabled: cart.vatEnabled,
      vatRate: cart.vatRate,
      currency: tenant?.currency,
      amountTendered: cart.paymentMethod === 'cash' && tenderedAmount > 0 ? tenderedAmount : null,
      changeDue: cart.paymentMethod === 'cash' && tenderedAmount > 0 ? changeDue : null,
      salespersonName: salespersonName || null,
      salespersonEmployeeNo: salespersonEmployeeNo || null,
      customerDetails,
    }
    setReceiptData(receipt)
    setShowReceipt(true)
    setShowMobileCart(false)
    cart.clearCart()
    // The VAT toggle above only overrides the current sale -- snap it back
    // to the tenant's own default for the next one, so turning it off for
    // one exempt item can't quietly carry over and under-charge VAT later.
    if (tenant) cart.setVatConfig(vatActive, tenant.vat_rate)
    setAmountTendered('')
    resetSalesperson()
    resetCustomer()
    setCheckingOut(false)
    toast.success(isRestaurant ? 'Order sent to kitchen!' : 'Transaction completed!')
  }

  const handlePaynowCheckout = async () => {
    if (isDesktop) {
      toast.error('Online payment is unavailable in standalone desktop mode')
      return
    }
    if (cart.items.length === 0) { toast.error('Cart is empty'); return }
    if (!tenant?.id) { toast.error('Not authenticated'); return }

    setPaynowLoading(true)
    try {
      const { browserUrl } = await initiatePaynowCheckout({
        tenantId: tenant.id,
        amount:   cart.getGrandTotal(),
        items:    cart.items,
      })
      // Clear cart before leaving the POS — the return page handles success/failure
      cart.clearCart()
      if (tenant) cart.setVatConfig(vatActive, tenant.vat_rate)
      window.location.href = browserUrl
    } catch (err) {
      toast.error(err.message || 'Failed to initiate Paynow checkout')
      setPaynowLoading(false)
    }
  }

  const accent = isRestaurant ? 'restaurant' : 'brand'

  return (
    <div className="relative flex h-[calc(100vh-4rem)] flex-col md:flex-row">
      {/* Product Area — full screen on mobile, flex-1 on desktop */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Search + Filters */}
        <div className="border-b border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search by name, SKU, or barcode..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
              {/* Suggestive search — matching products drop down as you type */}
              {searchFocused && search.trim().length > 0 && filtered.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
                  {filtered.slice(0, 8).map((p) => (
                    <button
                      key={p.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { cart.addItem(p); setSearch(''); toast.success(`${p.name} added`) }}
                      className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                    >
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800">
                        {p.image
                          ? <img src={p.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          : <PackageIcon className="h-4 w-4 text-slate-400" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">{p.name}</p>
                        <p className="text-xs text-slate-500">{p.sku} · {p.stock} in stock</p>
                      </div>
                      <span className="flex-shrink-0 text-sm font-bold text-slate-900 dark:text-white">{fmtUnit(p.price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={startScanner}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              <Camera className="h-4 w-4" />
              Scan
            </button>
            {!isDemoRoute() && !isDesktop && (
              <button
                onClick={() => setShowNoSaleModal(true)}
                title="Open the drawer without a sale (making change, till float) — logged for review"
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <DoorOpen className="h-4 w-4" />
                <span className="hidden sm:inline">No Sale</span>
              </button>
            )}
            {/* SOS — deliberately unobtrusive, not a big red alarm button:
                a duress alert only works if pressing it doesn't visibly
                announce itself either. See handleSos's own comment. */}
            {!isDemoRoute() && !isDesktop && (
              <button
                onClick={handleSos}
                title="Silent alert"
                aria-label="Silent alert"
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500"
              >
                <ShieldAlert className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Category pills */}
          <div className="mt-3 flex gap-2 overflow-x-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setCategory(cat.id)}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  category === cat.id
                    ? isRestaurant
                      ? 'bg-restaurant-600 text-white'
                      : 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        {/* Product Grid */}
        <div className="flex-1 overflow-auto p-4 pb-20">
          {products.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <PackageIcon className="mb-3 h-14 w-14 text-slate-300 dark:text-slate-700" />
              <p className="text-sm font-semibold text-slate-600 dark:text-slate-400">No products yet</p>
              <p className="mt-1 text-xs text-slate-400">Go to Inventory to add your products, then they'll appear here</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {filtered.map((product) => (
              <motion.button
                key={product.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => cart.addItem(product)}
                className="group rounded-xl border border-slate-200 bg-white p-3 text-left transition-shadow hover:shadow-lg dark:border-slate-800 dark:bg-slate-900"
              >
                <div className={`mb-2 flex h-36 items-center justify-center rounded-lg ${
                  isRestaurant ? 'bg-restaurant-50 dark:bg-restaurant-950' : 'bg-brand-50 dark:bg-brand-950'
                }`}>
                  {product.image ? (
                    <img
                      src={product.image}
                      alt={product.name}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full rounded-lg object-cover"
                    />
                  ) : (
                    <Package className={`h-12 w-12 ${
                      isRestaurant ? 'text-restaurant-300' : 'text-brand-300'
                    }`} />
                  )}
                </div>
                <h4 className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                  {product.name}
                </h4>
                {product.brand && (
                  <p className="truncate text-xs text-slate-400">{product.brand}</p>
                )}
                <div className="mt-1 flex items-center justify-between">
                  <span className={`text-lg font-extrabold ${
                    isRestaurant ? 'text-restaurant-600 dark:text-restaurant-400' : 'text-brand-600 dark:text-brand-400'
                  }`}>
                    {fmtUnit(product.price)}
                  </span>
                  <span className="text-xs text-slate-500">{product.stock} in stock</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">SKU: {product.sku}</div>
              </motion.button>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile floating cart button — hidden on desktop */}
      <button
        onClick={() => setShowMobileCart(true)}
        className={`fixed bottom-6 right-6 z-40 flex items-center gap-2.5 rounded-full px-5 py-3.5 text-sm font-bold text-white shadow-2xl transition-transform active:scale-95 md:hidden ${
          isRestaurant ? 'bg-restaurant-600' : 'bg-brand-600'
        }`}
      >
        <ShoppingCart className="h-5 w-5" />
        {cart.items.length > 0
          ? <span>{cart.items.length} item{cart.items.length !== 1 ? 's' : ''} · {fmt(cart.getGrandTotal())}</span>
          : <span>{isRestaurant ? 'Order' : 'Cart'}</span>}
        {cart.items.length > 0 && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-xs font-extrabold">
            {cart.items.length}
          </span>
        )}
      </button>

      {/* Cart Panel — full-screen overlay on mobile, fixed sidebar on desktop.
          Width is a clamp (proportional, not a rigid px value) so it doesn't
          eat a disproportionate share of the screen on POS terminals whose
          viewport sits right at the mobile/desktop breakpoint boundary, or
          when zoomed — it scales with the available width instead of
          staying fixed while the product grid squeezes down around it. */}
      <div className={`
        flex flex-col bg-white dark:bg-slate-950
        border-slate-200 dark:border-slate-800
        md:w-[clamp(280px,28vw,384px)] md:flex-shrink-0 md:border-l
        ${showMobileCart
          ? 'fixed inset-0 z-50 md:relative md:inset-auto md:z-auto'
          : 'hidden md:flex'}
      `}>
        {/* Cart Header */}
        <div className="flex flex-col gap-0 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 p-4 pb-2">
            <ShoppingCart className={`h-5 w-5 ${isRestaurant ? 'text-restaurant-600' : 'text-brand-600'}`} />
            <h2 className="font-bold text-slate-900 dark:text-white">
              {isRestaurant ? 'Order' : 'Cart'}
            </h2>
            <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              {cart.items.length} items
            </span>
            {/* Close button — mobile only */}
            <button
              onClick={() => setShowMobileCart(false)}
              className="ml-2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* Drive-through / Counter toggle — restaurant only */}
          {isRestaurant && (
            <div className="flex gap-0 overflow-hidden rounded-xl mx-4 mb-3 border border-slate-200 dark:border-slate-700">
              <button
                onClick={() => cart.setOrderType('counter')}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-bold transition-colors ${
                  cart.orderType !== 'drive_through'
                    ? 'bg-restaurant-600 text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <Store className="h-3.5 w-3.5" />
                Counter
              </button>
              <button
                onClick={() => cart.setOrderType('drive_through')}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-bold transition-colors ${
                  cart.orderType === 'drive_through'
                    ? 'bg-yellow-500 text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <Car className="h-3.5 w-3.5" />
                Drive-Through
              </button>
            </div>
          )}
        </div>

        {/* Cart Items — min-h keeps at least a product or two visible even
            when the footer below (payment methods, totals, buttons) is at
            its tallest; overflow-auto scrolls the rest. */}
        <div className="min-h-[120px] flex-1 overflow-auto p-4">
          <AnimatePresence>
            {cart.items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <ShoppingCart className="mb-3 h-12 w-12 text-slate-300 dark:text-slate-700" />
                <p className="text-sm text-slate-500">
                  {isRestaurant ? 'No items in order' : 'Cart is empty'}
                </p>
                <p className="mt-1 text-xs text-slate-400">Tap a product to add it</p>
              </div>
            ) : (
              <div className="space-y-3">
                {cart.items.map((item) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
                          {item.name}
                        </h4>
                        <p className="text-xs text-slate-500">{fmtUnit(item.price)} each</p>
                      </div>
                      <button
                        onClick={() => cart.removeItem(item.id)}
                        className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => cart.updateQuantity(item.id, Math.round((item.quantity - unitStep(item.unit)) * 1000) / 1000)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <div className="flex items-center gap-1">
                          <CartQtyField item={item} onCommit={(n) => cart.updateQuantity(item.id, n)} />
                          {FRACTIONAL_UNITS.includes(item.unit) && (
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{item.unit}</span>
                          )}
                        </div>
                        <button
                          onClick={() => cart.updateQuantity(item.id, Math.round((item.quantity + unitStep(item.unit)) * 1000) / 1000)}
                          className={`flex h-7 w-7 items-center justify-center rounded-lg text-white ${
                            isRestaurant ? 'bg-restaurant-600 hover:bg-restaurant-700' : 'bg-brand-600 hover:bg-brand-700'
                          }`}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                      <span className="text-sm font-bold text-slate-900 dark:text-white">
                        {fmt(item.price * item.quantity)}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* Payment Method + Totals + Checkout — one compact block (was two
            separately-padded sections) so the cart items area above keeps
            as much of the sidebar's height as possible. */}
        <div className="max-h-[52%] flex-shrink-0 overflow-y-auto border-t border-slate-200 p-3 dark:border-slate-800">
          {/* Customer Details — optional, goes on the receipt and feeds the
              customers table (retention: the vendor can contact customers
              again afterwards). Gated tenant-wide by the
              features.customer_details add-on -- the whole section (button
              included) must not render for tenants without it, same rule
              as Salesperson below. Job done stays a single short line --
              an 80mm receipt has no room for a paragraph. */}
          {customerDetailsEnabled && (!showCustomer ? (
            <button
              onClick={() => setShowCustomer(true)}
              className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-brand-600 dark:hover:text-brand-400"
            >
              <UserPlus className="h-3.5 w-3.5" /> Add Customer Details
            </button>
          ) : (
            <div className="mb-2 rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-slate-500">Customer</span>
                <button onClick={resetCustomer} className="text-xs font-semibold text-red-500 hover:underline">
                  Remove
                </button>
              </div>
              <div className="mt-1.5 space-y-1.5">
                <input
                  type="text"
                  value={customerForm.name}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Customer name"
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="tel"
                    value={customerForm.phone}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="Phone"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                  <input
                    type="email"
                    value={customerForm.email}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="Email"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    value={customerForm.vehicle}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, vehicle: e.target.value }))}
                    placeholder="Car (e.g. Honda Fit)"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                  <input
                    type="text"
                    value={customerForm.regNumber}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, regNumber: e.target.value }))}
                    placeholder="Reg no."
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setCustomerForm((f) => ({ ...f, accountType: 'individual' }))}
                    className={`flex-1 rounded-lg border py-1 text-xs font-medium ${customerForm.accountType === 'individual' ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400'}`}
                  >
                    Individual
                  </button>
                  <button
                    onClick={() => setCustomerForm((f) => ({ ...f, accountType: 'company' }))}
                    className={`flex-1 rounded-lg border py-1 text-xs font-medium ${customerForm.accountType === 'company' ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400'}`}
                  >
                    Company
                  </button>
                </div>
                {customerForm.accountType === 'company' && (
                  <input
                    type="text"
                    value={customerForm.companyName}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, companyName: e.target.value }))}
                    placeholder="Company name"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                )}
                <input
                  type="text"
                  value={customerForm.jobDone}
                  onChange={(e) => setCustomerForm((f) => ({ ...f, jobDone: e.target.value }))}
                  placeholder="Job done (short, e.g. 4x tyre fit)"
                  maxLength={60}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </div>
          ))}

          <h4 className="mb-1.5 text-xs font-semibold uppercase text-slate-500">Payment Method</h4>
          <div className="grid grid-cols-3 gap-1.5">
            {availablePaymentMethods.map((method) => (
              <button
                key={method.id}
                onClick={() => cart.setPaymentMethod(method.id)}
                className={`rounded-lg border py-1.5 text-center text-xs font-medium transition-colors ${
                  cart.paymentMethod === method.id
                    ? isRestaurant
                      ? 'border-restaurant-500 bg-restaurant-50 text-restaurant-700 dark:bg-restaurant-950 dark:text-restaurant-400'
                      : 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                {method.label}
              </button>
            ))}
          </div>

          {/* Cash tendered / change — optional; only relevant for cash sales */}
          {cart.paymentMethod === 'cash' && (
            <div className="mt-2 rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold uppercase text-slate-500">Amount Tendered</label>
                {amountTendered !== '' && (
                  <button
                    onClick={() => setAmountTendered('')}
                    className="text-xs font-semibold text-red-500 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amountTendered}
                onChange={(e) => setAmountTendered(e.target.value)}
                placeholder={fmt(cart.getGrandTotal())}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-right text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
              {amountTendered !== '' && (
                <div className="mt-1.5 flex justify-between text-sm">
                  <span className="text-slate-500">{cashShortfall ? 'Short by' : 'Change'}</span>
                  <span className={`font-bold ${cashShortfall ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                    {cashShortfall ? fmt(cart.getGrandTotal() - tenderedAmount) : fmt(changeDue)}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="mb-1.5 mt-3 flex items-center gap-2">
            <Percent className="h-4 w-4 flex-shrink-0 text-slate-400" />
            <span className="text-sm text-slate-500">Discount</span>
            <select
              value={cart.discountType}
              onChange={(e) => cart.setDiscountType(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              <option value="percent">%</option>
              <option value="fixed">{tenant?.currency || '$'}</option>
            </select>
            <input
              type="number"
              min="0"
              step="0.01"
              max={cart.discountType === 'percent' ? 100 : undefined}
              value={cart.discount || ''}
              onChange={(e) => {
                const raw = Math.max(0, Number(e.target.value) || 0)
                cart.setDiscount(cart.discountType === 'percent' ? Math.min(100, raw) : raw)
              }}
              placeholder="0"
              className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            />
            {cart.discount > 0 && (
              <button
                onClick={() => cart.setDiscount(0)}
                className="ml-auto text-xs font-semibold text-red-500 hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          {!isDemoRoute() && role !== 'vendor' && cart.getEffectiveDiscountPct() > 10 && (
            <p className="mb-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              {cart.discountAuthId
                ? 'Discount authorized by manager.'
                : `Needs manager authorization (over 10% off) — you'll be asked at checkout.`}
            </p>
          )}

          {/* Salesperson — optional, distinct from the cashier. Silent on
              the receipt entirely unless one is actually picked/typed. Gated
              tenant-wide by Settings > General > "Salesperson at Checkout"
              (default off) -- when the tenant hasn't turned it on, this
              entire section (button included) must not render at all, not
              just be disabled, so it never appears as clutter for tenants
              who never asked for it. */}
          {tenant?.salesperson_capture_enabled && (!showSalesperson ? (
            <button
              onClick={() => setShowSalesperson(true)}
              className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-brand-600 dark:hover:text-brand-400"
            >
              + Add Salesperson
            </button>
          ) : (
            <div className="mt-2 rounded-xl border border-slate-200 p-2.5 dark:border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-slate-500">Salesperson</span>
                <button onClick={resetSalesperson} className="text-xs font-semibold text-red-500 hover:underline">
                  Remove
                </button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={() => setSalespersonMode('staff')}
                  className={`flex-1 rounded-lg border py-1 text-xs font-medium ${salespersonMode === 'staff' ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400'}`}
                >
                  Select Staff
                </button>
                <button
                  onClick={() => setSalespersonMode('manual')}
                  className={`flex-1 rounded-lg border py-1 text-xs font-medium ${salespersonMode === 'manual' ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400'}`}
                >
                  Type Manually
                </button>
              </div>
              {salespersonMode === 'staff' ? (
                <select
                  value={salespersonStaffId}
                  onChange={(e) => setSalespersonStaffId(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option value="">Select staff…</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.employee_no ? ` (${s.employee_no})` : ''}</option>
                  ))}
                </select>
              ) : (
                <div className="mt-1.5 space-y-1.5">
                  <input
                    type="text"
                    value={salespersonManualName}
                    onChange={(e) => setSalespersonManualName(e.target.value)}
                    placeholder="Salesperson name"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                  <input
                    type="text"
                    value={salespersonManualEmpNo}
                    onChange={(e) => setSalespersonManualEmpNo(e.target.value)}
                    placeholder="Employee number (optional)"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
              )}
            </div>
          ))}

          <div className="mt-3 space-y-1">
            {cart.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">
                  Discount ({cart.discountType === 'percent' ? `${cart.discount}%` : fmt(cart.discount)})
                </span>
                <span className="font-medium text-red-500">
                  -{fmt(cart.items.reduce((s, i) => s + i.price * i.quantity * (1 - (i.itemDiscount || 0) / 100), 0) - cart.getTotal())}
                </span>
              </div>
            )}
            {/* VAT is a tenant-wide default, but not every sale should
                necessarily carry it (e.g. a zero-rated or exempt walk-in
                item) -- this only changes the current sale, not the
                tenant's own setting. Only shown at all if VAT is both
                activated as a plan feature (tenant.features.vat -- a
                Super Admin-approved add-on, see AdminVatRequests.jsx) AND
                not switched off by the tenant themselves in General
                settings (tenant.vat_enabled). A tenant that never
                activated VAT at all shouldn't see any trace of it here,
                regardless of what vat_enabled happens to default to. */}
            {vatActive && (
              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-1.5 text-slate-500">
                  <input
                    type="checkbox"
                    checked={cart.vatEnabled}
                    onChange={(e) => cart.setVatConfig(e.target.checked, cart.vatRate)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Charge VAT on this sale
                </label>
              </div>
            )}
            {cart.vatEnabled ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Net (ex VAT)</span>
                  <span className="font-medium text-slate-900 dark:text-white">
                    {fmt(cart.getSubtotal())}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">VAT {cart.vatRate}% (included)</span>
                  <span className="font-medium text-slate-900 dark:text-white">
                    {fmt(cart.getTax())}
                  </span>
                </div>
              </>
            ) : null}
            <div className="flex justify-between border-t border-slate-200 pt-1.5 dark:border-slate-700">
              <span className="text-base font-bold text-slate-900 dark:text-white">Total</span>
              <span className={`text-xl font-extrabold ${
                isRestaurant ? 'text-restaurant-600 dark:text-restaurant-400' : 'text-brand-600 dark:text-brand-400'
              }`}>
                {fmt(cart.getGrandTotal())}
              </span>
            </div>
          </div>
          <Button
            variant={isRestaurant ? 'restaurant' : 'primary'}
            size="lg"
            className="mt-3 w-full"
            onClick={handleCheckoutClick}
            disabled={cart.items.length === 0 || checkingOut || cashShortfall || !tenant?.id}
          >
            {checkingOut ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
            {checkingOut
              ? 'Processing…'
              : PAYNOW_METHODS.includes(cart.paymentMethod)
                ? 'Continue to Paynow'
                : isRestaurant ? 'Place Order' : 'Complete Sale'}
          </Button>

          {/* Paynow hosted checkout — redirects to Paynow, returns to /payment/return */}
          {!isDesktop && <button
            onClick={handlePaynowCheckout}
            disabled={cart.items.length === 0 || paynowLoading}
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-[#f7941d] bg-white py-2.5 text-sm font-bold text-[#f7941d] transition-colors hover:bg-[#f7941d] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-900 dark:hover:bg-[#f7941d] dark:hover:text-white"
          >
            {paynowLoading
              ? <RefreshCw className="h-4 w-4 animate-spin" />
              : <ExternalLink className="h-4 w-4" />}
            {paynowLoading ? 'Opening Paynow…' : 'Pay with Paynow'}
          </button>}
          {!isDesktop && <p className="mt-1 text-center text-[10px] text-slate-400">
            EcoCash · OneMoney · InnBucks · Omari and more
          </p>}
        </div>
      </div>

      {/* Pharmacy Mode — capture prescriber/customer details before charging
          for a prescription/controlled item. One capture covers every
          qualifying line in the basket. */}
      {showPrescriptionModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Prescription Details Required</h3>
            <p className="mt-1 text-sm text-slate-500">
              This sale includes {pharmacyItems.length === 1 ? pharmacyItems[0].name : `${pharmacyItems.length} controlled/prescription items`} — capture the prescriber before completing the sale.
            </p>
            <div className="mt-4 space-y-3">
              {!isDemoRoute() && filedPrescriptions.length > 0 && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Link Filed Prescription (optional)</label>
                  <select
                    value={linkedPrescription?.id || ''}
                    onChange={(e) => {
                      const p = filedPrescriptions.find((x) => x.id === e.target.value)
                      setLinkedPrescription(p || null)
                      if (p) {
                        setPrescriptionForm({
                          customerName: p.customers?.name || p.patient_name || '',
                          prescriberName: p.doctors?.name ? `Dr. ${p.doctors.name}` : (p.doctor_name || ''),
                          prescriberLicenseNo: p.doctors?.license_no || '',
                        })
                      }
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  >
                    <option value="">— Type prescriber details below —</option>
                    {filedPrescriptions.map((p) => (
                      <option key={p.id} value={p.id}>{p.customers?.name || p.patient_name || 'Unnamed'} — {p.doctors?.name ? `Dr. ${p.doctors.name}` : (p.doctor_name || 'no doctor on file')}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Prescriber Name *</label>
                <input
                  autoFocus
                  value={prescriptionForm.prescriberName}
                  onChange={(e) => setPrescriptionForm((f) => ({ ...f, prescriberName: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Prescriber License No.</label>
                <input
                  value={prescriptionForm.prescriberLicenseNo}
                  onChange={(e) => setPrescriptionForm((f) => ({ ...f, prescriberLicenseNo: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Customer Name</label>
                <input
                  value={prescriptionForm.customerName}
                  onChange={(e) => setPrescriptionForm((f) => ({ ...f, customerName: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setShowPrescriptionModal(false); setLinkedPrescription(null) }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!prescriptionForm.prescriberName.trim()) { toast.error('Prescriber name is required'); return }
                  setShowPrescriptionModal(false)
                  // Re-check rather than jumping straight to handleCheckout --
                  // the basket might also have an age-restricted item still
                  // needing its own gate.
                  handleCheckoutClick()
                }}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Continue to Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bar/Liquor Store Mode — ID/age verification before charging for a
          restricted item. */}
      {showAgeVerifyModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Age Verification Required</h3>
            <p className="mt-1 text-sm text-slate-500">
              This sale includes {barItems.length === 1 ? barItems[0].name : `${barItems.length} age-restricted items`} — confirm ID has been checked before completing the sale.
            </p>
            <div className="mt-4 space-y-3">
              <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
                <input
                  type="checkbox"
                  checked={ageVerifyForm.verified}
                  onChange={(e) => setAgeVerifyForm((f) => ({ ...f, verified: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium text-slate-700 dark:text-slate-300">I have checked the customer's ID and confirmed they are of legal age.</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">ID Type</label>
                  <input
                    value={ageVerifyForm.idType}
                    onChange={(e) => setAgeVerifyForm((f) => ({ ...f, idType: e.target.value }))}
                    placeholder="e.g. National ID, Passport"
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">ID Last 4 Digits</label>
                  <input
                    value={ageVerifyForm.idLast4}
                    onChange={(e) => setAgeVerifyForm((f) => ({ ...f, idLast4: e.target.value.slice(0, 4) }))}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowAgeVerifyModal(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!ageVerifyForm.verified) { toast.error('Confirm the ID check before continuing'); return }
                  setShowAgeVerifyModal(false)
                  handleCheckout()
                }}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Continue to Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discount >10% — a manager/supervisor/vendor must authorize with
          their own login before checkout can proceed. process_checkout
          enforces this server-side regardless of anything client-side. */}
      {showDiscountAuthModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Manager Authorization Required</h3>
            <p className="mt-1 text-sm text-slate-500">
              This sale has a {Math.ceil(cart.getEffectiveDiscountPct())}% discount — a shop manager, supervisor or
              the vendor needs to sign in to authorize it.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Manager Email</label>
                <input
                  autoFocus
                  type="email"
                  autoComplete="off"
                  value={discountAuthForm.email}
                  onChange={(e) => setDiscountAuthForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Manager Password</label>
                <input
                  type="password"
                  autoComplete="off"
                  value={discountAuthForm.password}
                  onChange={(e) => setDiscountAuthForm((f) => ({ ...f, password: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAuthorizeDiscount() }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setShowDiscountAuthModal(false); setDiscountAuthForm({ email: '', password: '' }) }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={handleAuthorizeDiscount}
                disabled={authorizingDiscount}
                className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {authorizingDiscount ? 'Authorizing…' : 'Authorize & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No-Sale — opening the drawer outside a completed sale. Never
          blocked on manager approval (see Security.jsx's own comment on
          why), just a required reason and a log entry queued for review. */}
      {showNoSaleModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Open Drawer — No Sale</h3>
            <p className="mt-1 text-sm text-slate-500">This is logged and reviewed by a manager — a reason is required.</p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Reason</label>
                <select
                  autoFocus
                  value={noSaleReason}
                  onChange={(e) => setNoSaleReason(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option value="change">Making change</option>
                  <option value="till_float">Till float adjustment</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Note (optional)</label>
                <textarea
                  value={noSaleNote}
                  onChange={(e) => setNoSaleNote(e.target.value)}
                  rows={2}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setShowNoSaleModal(false); setNoSaleNote(''); setNoSaleReason('change') }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={handleNoSale}
                disabled={loggingNoSale}
                className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                <DoorOpen className="h-4 w-4" /> {loggingNoSale ? 'Opening…' : 'Open Drawer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Modal — ZIMRA Receipt48 format */}
      {showReceipt && receiptData && (
        <ZimraReceipt
          receipt={receiptData}
          onClose={() => setShowReceipt(false)}
        />
      )}

      {/* Camera barcode scanner */}
      {showScanner && (
        <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/90 p-4">
          <div className="w-full max-w-md">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm font-semibold text-white">
                <Barcode className="h-4 w-4" /> Point the camera at a barcode or QR code
              </p>
              <button onClick={stopScanner} className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20">
                <X className="h-5 w-5" />
              </button>
            </div>
            <video
              ref={videoRef}
              playsInline
              muted
              className="aspect-[4/3] w-full rounded-2xl border-2 border-white/30 object-cover"
            />
            <p className="mt-3 text-center text-xs text-slate-400">
              Works with phone and tablet cameras. USB/Bluetooth scanners can type straight into the search box.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function Package(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" x2="12" y1="22.08" y2="12" />
    </svg>
  )
}
