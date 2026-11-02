import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutDashboard, ShoppingCart, Package, ClipboardList, BarChart3,
  Settings, Users, ChefHat, ListTodo, LogOut, ChevronLeft, ChevronRight, ChevronDown,
  Store, Receipt, Cpu, X, Sparkles, CreditCard, BriefcaseBusiness, FileText, Inbox, Calculator,
  Wrench, Car, HardHat, FileSignature, Factory, Pill, ShieldCheck, FileBarChart, Landmark, Hammer,
  ClipboardCheck, Wallet, ShieldAlert, PackagePlus, Stethoscope, Building2, CalendarClock, Glasses,
  DoorOpen, Percent,
} from 'lucide-react'
import { useState } from 'react'
import { useThemeStore } from '@/stores/themeStore'
import { useAuthStore, ROLE_COLORS, ROLE_LABELS, NAV_PERMISSIONS } from '@/stores/authStore'
import posIcon from '@/assets/pos-icon.png'

const ALL_NAV_ITEMS = [
  { key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', path: '/app/dashboard' },
  { key: 'requests', icon: Inbox, label: 'Requests', path: '/app/requests' },
  { key: 'pos', icon: ShoppingCart, label: 'POS', path: '/app/pos' },
  { key: 'inventory', icon: Package, label: 'Inventory', path: '/app/inventory' },
  { key: 'stock_take', icon: ClipboardCheck, label: 'Stock Take', path: '/app/stock-take' },
  { key: 'reorder', icon: PackagePlus, label: 'Reorder Suggestions', path: '/app/reorder' },
  { key: 'cash_up', icon: Wallet, label: 'Cash-Up', path: '/app/cash-up' },
  { key: 'orders', icon: ClipboardList, label: 'Orders', path: '/app/orders' },
  { key: 'kitchen', icon: ChefHat, label: 'Kitchen', path: '/app/kitchen', restaurantOnly: true },
  { key: 'job_cards', icon: Wrench, label: 'Job Cards', path: '/app/job-cards', workshopOnly: true },
  { key: 'vehicle_registry', icon: Car, label: 'Vehicle Registry', path: '/app/vehicle-registry', workshopOnly: true },
  { key: 'mechanics', icon: HardHat, label: 'Mechanics', path: '/app/mechanics', workshopOnly: true },
  { key: 'quotations', icon: FileSignature, label: 'Quotations', path: '/app/quotations', workshopOnly: true },
  // Core POS feature, not part of the paid Accounting & ERP add-on — the
  // advanced payment-tracking layer within this same page is what's
  // add-on-gated (see accountingErpActive in Invoicing.jsx).
  { key: 'invoicing', icon: FileText, label: 'Invoicing', path: '/app/invoicing' },
  { key: 'production', icon: Factory, label: 'Production', path: '/app/production', manufacturingOnly: true },
  { key: 'equipment_rental', icon: Hammer, label: 'Equipment Rental', path: '/app/equipment-rental', hardwareOnly: true },
  { key: 'prescriptions', icon: Pill, label: 'Prescriptions', path: '/app/prescriptions', pharmacyOnly: true },
  { key: 'doctors', icon: Stethoscope, label: 'Doctors', path: '/app/doctors', pharmacyOnly: true },
  { key: 'insurers', icon: Building2, label: 'Insurers', path: '/app/insurers', pharmacyOnly: true },
  { key: 'controlled_substances', icon: ShieldAlert, label: 'Controlled Substances', path: '/app/controlled-substances', pharmacyOnly: true },
  { key: 'appointments', icon: CalendarClock, label: 'Appointments', path: '/app/appointments', pharmacyOnly: true },
  { key: 'eye_prescriptions', icon: Glasses, label: 'Optometry', path: '/app/optometry', pharmacyOnly: true },
  { key: 'age_verifications', icon: ShieldCheck, label: 'Age Verifications', path: '/app/age-verifications', barOnly: true },
  { key: 'transactions', icon: Receipt, label: 'Transactions', path: '/app/transactions' },
  { key: 'refund_audit', icon: ShieldAlert, label: 'Refund Auditing', path: '/app/refund-audit' },
  { key: 'security', icon: DoorOpen, label: 'Security', path: '/app/security' },
  { key: 'discount_reviews', icon: Percent, label: 'Discount Reviews', path: '/app/discount-reviews' },
  { key: 'reports', icon: BarChart3, label: 'Reports', path: '/app/reports' },
  { key: 'insights', icon: Sparkles, label: 'AI Insights', path: '/app/insights', addonFeature: 'ai_insights', addonTitle: 'AI Insights is an optional add-on — request it in Settings' },
  { key: 'staff', icon: Users, label: 'Staff Management', path: '/app/staff' },
  { key: 'tasks', icon: ListTodo, label: 'Tasks', path: '/app/tasks' },
  { key: 'branches', icon: Store, label: 'Branches', path: '/app/branches' },
  { key: 'fiscalisation', icon: Cpu, label: 'Fiscalisation', path: '/app/fiscalisation', addonFeature: 'fiscalisation', addonTitle: 'ZIMRA Fiscalisation is an optional add-on — request it in Settings' },
  { key: 'payments', icon: CreditCard, label: 'Payments', path: '/app/payments' },
  {
    key: 'accounting_erp', icon: Calculator, label: 'Accounting & ERP',
    addonFeature: 'accounting_erp', addonTitle: 'Accounting & ERP is an optional add-on — request it in Settings',
    children: [
      { key: 'hr', icon: BriefcaseBusiness, label: 'HR & Payroll', path: '/app/hr' },
      { key: 'customers', icon: Users, label: 'Customers', path: '/app/customers' },
      { key: 'statements', icon: FileBarChart, label: 'Statements', path: '/app/statements' },
      { key: 'accounting', icon: Landmark, label: 'Accounting', path: '/app/accounting' },
    ],
  },
  { key: 'settings', icon: Settings, label: 'Settings', path: '/app/settings' },
]

export default function Sidebar({ open = false, onClose }) {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState([])
  const { posMode } = useThemeStore()
  const { clearAuth, role, profile, tenant } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  const isRestaurant = posMode === 'restaurant'
  const isWorkshop = posMode === 'workshop'
  const isManufacturing = posMode === 'manufacturing'
  const isPharmacy = posMode === 'pharmacy'
  const isBar = posMode === 'bar'
  const isHardware = posMode === 'hardware'

  const allowedKeys = window.tengaDesktop?.isDesktop
    ? ['pos', 'inventory', 'transactions']
    : NAV_PERMISSIONS[role] || NAV_PERMISSIONS.vendor
  const visibleItems = ALL_NAV_ITEMS.map((item) => {
    if (!item.children) return item
    const children = item.children.filter((c) => allowedKeys.includes(c.key))
    return children.length ? { ...item, children } : null
  }).filter((item) => {
    if (!item) return false
    if (item.children) return true
    if (!allowedKeys.includes(item.key)) return false
    if (item.restaurantOnly && !isRestaurant) return false
    if (item.workshopOnly && !isWorkshop) return false
    if (item.manufacturingOnly && !isManufacturing) return false
    if (item.pharmacyOnly && !isPharmacy) return false
    if (item.barOnly && !isBar) return false
    if (item.hardwareOnly && !isHardware) return false
    return true
  })

  const isGroupOpen = (item) => expandedGroups.includes(item.key)
    || item.children?.some((c) => location.pathname === c.path)
  const toggleGroup = (key) => setExpandedGroups((prev) =>
    prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])

  const colors = ROLE_COLORS[role] || ROLE_COLORS.vendor
  const roleLabel = ROLE_LABELS[role] || role
  const displayName = profile?.name || 'User'
  const initial = displayName[0]?.toUpperCase() || 'U'

  // White-label: the tenant's own logo/name replaces tengaPOS branding
  const whitelabel = tenant?.whitelabel?.enabled ? tenant.whitelabel : null

  const handleSignOut = async () => {
    await clearAuth()
    navigate('/')
  }

  const handleNavClick = () => {
    if (onClose) onClose()
  }

  return (
    <>
      {/* Mobile backdrop — clicks close the sidebar */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={onClose}
          />
        )}
      </AnimatePresence>

      {/* Sidebar panel */}
      <aside
        className={[
          // Mobile: fixed overlay that slides in/out
          'fixed top-0 left-0 h-full z-50',
          // Desktop: static in-flow
          'lg:static lg:h-screen lg:z-auto',
          // Width
          collapsed ? 'w-[72px]' : 'w-64',
          // Structure
          'flex flex-col flex-shrink-0',
          'border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950',
          // Mobile slide transition
          'transition-all duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        ].join(' ')}
      >
        {/* Header: logo + close/collapse */}
        <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-slate-200 px-3 dark:border-slate-800">
          <AnimatePresence mode="wait">
            {!collapsed && (
              <motion.div
                key="logo"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {whitelabel?.logo_url ? (
                  <img
                    src={whitelabel.logo_url}
                    alt={whitelabel.brand_name || 'Logo'}
                    className="h-8 w-auto max-w-[160px] object-contain"
                  />
                ) : whitelabel?.brand_name ? (
                  <span className="truncate text-lg font-extrabold text-brand-700 dark:text-brand-400">
                    {whitelabel.brand_name}
                  </span>
                ) : (
                  <img src={posIcon} alt="tengaPOS" className="h-8 w-auto" />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Mobile close button */}
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Desktop collapse button */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="ml-auto hidden rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 lg:block"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* User profile */}
        <div className={`flex-shrink-0 border-b border-slate-200 p-3 dark:border-slate-800 ${collapsed ? 'items-center' : ''}`}>
          <div className={`flex ${collapsed ? 'justify-center' : 'items-center gap-3'}`}>
            <div
              className={`flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white ${
                collapsed ? 'h-8 w-8 text-xs' : 'h-9 w-9 text-sm'
              } bg-gradient-to-br ${
                isRestaurant ? 'from-green-500 to-green-700' : 'from-brand-500 to-brand-700'
              }`}
            >
              {initial}
            </div>
            <AnimatePresence mode="wait">
              {!collapsed && (
                <motion.div
                  key="profile"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  className="overflow-hidden"
                >
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {displayName}
                  </div>
                  <span
                    className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${colors.bg} ${colors.text}`}
                  >
                    {roleLabel}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <div className="space-y-0.5">
            {visibleItems.map((item) => {
              const isActive = location.pathname === item.path
              const locked = item.addonFeature && tenant?.features?.[item.addonFeature] !== true

              // Paid add-ons (Fiscalisation, AI Insights, Accounting & ERP): greyed out until unlocked
              if (locked) {
                return (
                  <NavLink
                    key={item.key}
                    to="/app/settings"
                    onClick={handleNavClick}
                    title={item.addonTitle}
                    className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-400 opacity-60 hover:bg-slate-100 dark:text-slate-600 dark:hover:bg-slate-800"
                  >
                    <item.icon className="h-5 w-5 flex-shrink-0 text-slate-300 dark:text-slate-700" />
                    {!collapsed && (
                      <span className="flex items-center gap-1.5 truncate">
                        {item.label}
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-500">ADD-ON</span>
                      </span>
                    )}
                  </NavLink>
                )
              }

              // Collapsible group (unlocked) — a parent that expands to reveal
              // its own pages underneath, instead of being a link itself.
              if (item.children) {
                const open = isGroupOpen(item)
                return (
                  <div key={item.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.key)}
                      className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition-all hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      title={collapsed ? item.label : undefined}
                    >
                      <item.icon className="h-5 w-5 flex-shrink-0 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 truncate text-left">{item.label}</span>
                          <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                        </>
                      )}
                    </button>
                    {!collapsed && open && (
                      <div className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-200 pl-3 dark:border-slate-800">
                        {item.children.map((child) => {
                          const childActive = location.pathname === child.path
                          return (
                            <NavLink
                              key={child.path}
                              to={child.path}
                              onClick={handleNavClick}
                              className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all ${
                                childActive
                                  ? isRestaurant
                                    ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400'
                                    : 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400'
                                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                              }`}
                            >
                              <child.icon
                                className={`h-4 w-4 flex-shrink-0 ${
                                  childActive
                                    ? isRestaurant
                                      ? 'text-green-600 dark:text-green-400'
                                      : 'text-brand-600 dark:text-brand-400'
                                    : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300'
                                }`}
                              />
                              <span className="truncate">{child.label}</span>
                            </NavLink>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              }

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={handleNavClick}
                  className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                    isActive
                      ? isRestaurant
                        ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400'
                        : 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-400'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                  }`}
                  title={collapsed ? item.label : undefined}
                >
                  <item.icon
                    className={`h-5 w-5 flex-shrink-0 ${
                      isActive
                        ? isRestaurant
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-brand-600 dark:text-brand-400'
                        : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300'
                    }`}
                  />
                  <AnimatePresence mode="wait">
                    {!collapsed && (
                      <motion.span
                        key="label"
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        className="truncate"
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </NavLink>
              )
            })}
          </div>
        </nav>

        {/* Sign out */}
        <div className="flex-shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
            title={collapsed ? 'Sign Out' : undefined}
          >
            <LogOut className="h-5 w-5 flex-shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
