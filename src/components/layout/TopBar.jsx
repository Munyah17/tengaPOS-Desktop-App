import { Bell, Wifi, WifiOff, ShieldAlert, Menu, User, Settings, LogOut, ChevronDown, CheckCheck, BellOff, ShoppingBag, UtensilsCrossed, Wrench, Hammer, Factory, Pill, AlertTriangle, CloudUpload } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import ThemeToggle from '@/components/common/ThemeToggle'
import RefreshOnlineButton from '@/components/common/RefreshOnlineButton'
import { useThemeStore } from '@/stores/themeStore'
import { useAuthStore, ROLE_COLORS, ROLE_LABELS, NAV_PERMISSIONS } from '@/stores/authStore'
import { useFiscalStore } from '@/stores/fiscalStore'
import { useTenantNotifications } from '@/hooks/useTenantNotifications'
import { pendingSyncCount, failedSyncCount } from '@/lib/offlineSync'
import { isDemoRoute } from '@/lib/demoMode'
import { exitDemoMode } from '@/lib/demoAuth'
import SyncQueueManager from './SyncQueueManager'

// Retail/Restaurant/Workshop/Hardware/Manufacturing/Pharmacy — same modes as
// Sidebar.jsx and AdminTenants.jsx's Business Modes control. A tenant only
// ever sees the modes Super Admin actually enabled for it (tenant.enabled_modes).
const MODE_META = {
  retail: { label: 'Retail', icon: ShoppingBag, activeClass: 'bg-brand-600 text-white', gradient: 'from-brand-500 to-brand-700' },
  restaurant: { label: 'Restaurant', icon: UtensilsCrossed, activeClass: 'bg-green-600 text-white', gradient: 'from-green-500 to-green-700' },
  workshop: { label: 'Workshop', icon: Wrench, activeClass: 'bg-gradient-to-r from-red-600 to-amber-500 text-white', gradient: 'from-red-600 to-amber-500' },
  hardware: { label: 'Hardware', icon: Hammer, activeClass: 'bg-orange-600 text-white', gradient: 'from-orange-500 to-orange-700' },
  manufacturing: { label: 'Manufacturing', icon: Factory, activeClass: 'bg-indigo-600 text-white', gradient: 'from-indigo-500 to-indigo-700' },
  pharmacy: { label: 'Pharmacy', icon: Pill, activeClass: 'bg-teal-600 text-white', gradient: 'from-teal-500 to-teal-700' },
}

function useClickOutside(ref, handler) {
  useEffect(() => {
    const listener = (e) => { if (ref.current && !ref.current.contains(e.target)) handler() }
    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)
    return () => { document.removeEventListener('mousedown', listener); document.removeEventListener('touchstart', listener) }
  }, [ref, handler])
}

export default function TopBar({ onMenuClick }) {
  const { posMode, setPosMode } = useThemeStore()
  const { profile, role, clearAuth, tenant } = useAuthStore()
  const { fiscalDayStatus, isEnabled: fiscalEnabled } = useFiscalStore()
  const navigate = useNavigate()
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [bellOpen, setBellOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [showFiscalWarning, setShowFiscalWarning] = useState(false)
  const [pendingSync, setPendingSync] = useState(0)
  const [failedSync, setFailedSync] = useState(0)
  const [showSyncManager, setShowSyncManager] = useState(false)
  const bellRef = useRef(null)
  const avatarRef = useRef(null)

  const { notifications, markAllRead } = useTenantNotifications({ tenantId: tenant?.id, posMode, role, userId: profile?.id })
  const canSeeSettings = (NAV_PERMISSIONS[role] || NAV_PERMISSIONS.vendor).includes('settings')

  const isRestaurant = posMode === 'restaurant'
  const enabledModes = tenant?.enabled_modes?.length ? tenant.enabled_modes : [tenant?.pos_mode || 'retail']
  const activeMeta = MODE_META[posMode] || MODE_META.retail
  const isReadOnly = role === 'tech_support'
  const displayName = profile?.name || 'User'
  const initial = displayName[0]?.toUpperCase() || 'U'
  const roleLabel = ROLE_LABELS[role] || role
  const colors = ROLE_COLORS[role] || ROLE_COLORS.vendor
  const unreadCount = notifications.filter((n) => n.unread).length

  useClickOutside(bellRef, () => setBellOpen(false))
  useClickOutside(avatarRef, () => setAvatarOpen(false))

  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // Surfaces how many offline sales/inventory edits are still waiting to
  // sync, so people aren't left guessing whether their work actually saved.
  useEffect(() => {
    const tick = () => {
      pendingSyncCount().then(setPendingSync).catch(() => {})
      failedSyncCount().then(setFailedSync).catch(() => {})
    }
    tick()
    const interval = setInterval(tick, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleSignOut = async () => {
    setAvatarOpen(false)
    // Warn if fiscal day is open
    if (fiscalEnabled && fiscalDayStatus === 'open') {
      setShowFiscalWarning(true)
      return
    }
    if (isDemoRoute()) exitDemoMode()
    else await clearAuth()
    navigate('/')
  }

  const confirmSignOut = async () => {
    setShowFiscalWarning(false)
    if (isDemoRoute()) exitDemoMode()
    else await clearAuth()
    navigate('/')
  }

  return (
    <>
    <header className="relative flex h-14 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
      {/* Hamburger — mobile only */}
      <button
        onClick={onMenuClick}
        className="mr-3 rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Spacer keeps right-side items right-aligned — the header has no search box.
          Product search lives on the POS and Inventory pages where it's actually needed. */}
      <div className="flex-1" />

      {/* Right — its own scroll container so on a narrow/mid-size tablet
          (enough width to clear the `lg:hidden` hamburger breakpoint, not
          enough for every badge below to fit) items are swipeable rather
          than silently clipped off-screen and unreachable (body has
          overflow-x:hidden globally, so unconstrained overflow here would
          otherwise just disappear — including the avatar/sign-out menu).
          These badges used to switch on at `md:` (768px) -- squarely
          inside a 6-8" tablet's own portrait width, so a device that
          class of screen was always the one stacking every badge at once
          with the least room to show them in. Reported live as the
          header overflowing/getting clipped specifically on tablets.
          Non-essential ones now wait for `lg:` (1024px, real desktop
          width) instead; the two actionable alerts (pending/failed sync)
          stay reachable earlier since they're money/data-safety signals,
          not just decoration. */}
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {/* Read-only badge */}
        {isReadOnly && (
          <div className="hidden flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-400 lg:flex">
            <ShieldAlert className="h-3.5 w-3.5" />
            Read-only
          </div>
        )}

        {/* Online status -- previously lg:-only, so a phone/small-tablet
            user (most cashiers) had no way to even see their connection
            state, let alone tell whether "offline mode not working" meant
            they were actually offline at all. Icon always shows now; only
            the text label collapses on the smallest screens. */}
        <div className={`flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${isOnline ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400'}`}>
          {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{isOnline ? 'Online' : 'Offline'}</span>
        </div>

        {/* Pending offline sync count — reassurance that queued work hasn't been lost.
            Clickable: opens the same manager as the failed-items badge below. */}
        {!window.tengaDesktop?.isDesktop && pendingSync > 0 && (
          <button
            onClick={() => setShowSyncManager(true)}
            title={`${pendingSync} item${pendingSync !== 1 ? 's' : ''} saved offline, waiting to sync — click to view`}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
          >
            <CloudUpload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{pendingSync} pending</span>
          </button>
        )}

        {/* Permanently-failed offline items — retrying can't fix these on its
            own (e.g. no longer enough stock), so they need a person to look
            at them here rather than being silently stuck forever. */}
        {!window.tengaDesktop?.isDesktop && failedSync > 0 && (
          <button
            onClick={() => setShowSyncManager(true)}
            title={`${failedSync} item${failedSync !== 1 ? 's' : ''} couldn't sync — click to review`}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{failedSync} failed</span>
          </button>
        )}

        {!window.tengaDesktop?.isDesktop && <div className="flex-shrink-0"><RefreshOnlineButton /></div>}

        {/* POS mode toggle — hidden below lg (also reachable via the avatar
            dropdown's own mode switcher, which is now the tablet/mobile
            way to switch), and only shown at all when Super Admin has
            enabled more than one mode for this tenant */}
        {enabledModes.length > 1 && (
          <div className="hidden flex-shrink-0 items-center overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 lg:flex">
            {enabledModes.map((m) => {
              const meta = MODE_META[m] || MODE_META.retail
              return (
                <button
                  key={m}
                  onClick={() => setPosMode(m)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${posMode === m ? meta.activeClass : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                  {meta.label}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex-shrink-0"><ThemeToggle /></div>
      </div>

      {/* Bell + Avatar are pinned outside the scroll container above, not
          inside it. Setting overflow-x also forces the browser to clip
          overflow-y (a CSS rule: overflow-x and overflow-y can't be
          "visible" vs. non-visible on the same axis pair) -- so anything
          absolutely-positioned inside that scrolling row that extends
          below it, like these two dropdowns, was getting clipped right at
          the header's edge instead of floating over the page. Reported
          live as the avatar menu appearing to render behind the header
          bar rather than sliding over it. Keeping them as their own,
          non-scrolling flex items sidesteps the clipping entirely. */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {/* Bell dropdown */}
        <div ref={bellRef} className="relative flex-shrink-0">
          <button
            onClick={() => { setBellOpen((o) => !o); setAvatarOpen(false) }}
            className="relative rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>

          {bellOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                <span className="text-sm font-bold text-slate-900 dark:text-white">Notifications</span>
                <button onClick={markAllRead} className="flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400">
                  <CheckCheck className="h-3.5 w-3.5" />
                  Mark all read
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-slate-400">
                    <BellOff className="h-8 w-8 opacity-30" />
                    <span className="text-sm">No notifications</span>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div key={n.id} className={`flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 ${n.unread ? 'bg-brand-50/50 dark:bg-brand-950/20' : ''}`}>
                      {n.unread && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-500" />}
                      {!n.unread && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-transparent" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-800 dark:text-slate-200">{n.text}</p>
                        <p className="mt-0.5 text-xs text-slate-400">{n.time}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <Link
                to="/app/notifications"
                onClick={() => setBellOpen(false)}
                className="block border-t border-slate-100 px-4 py-2.5 text-center text-xs font-semibold text-brand-600 hover:bg-slate-50 dark:border-slate-800 dark:text-brand-400 dark:hover:bg-slate-800"
              >
                See all
              </Link>
            </div>
          )}
        </div>

        {/* Avatar dropdown */}
        <div ref={avatarRef} className="relative flex-shrink-0">
          <button
            onClick={() => { setAvatarOpen((o) => !o); setBellOpen(false) }}
            className="flex items-center gap-2 rounded-xl p-1.5 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${activeMeta.gradient} text-sm font-bold text-white`}>
              {initial}
            </div>
            <div className="hidden flex-col text-left sm:flex">
              <span className="text-sm font-semibold leading-tight text-slate-900 dark:text-white">{displayName}</span>
              <span className={`text-xs font-medium ${colors.text}`}>{roleLabel}</span>
            </div>
            <ChevronDown className={`hidden h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform sm:block ${avatarOpen ? 'rotate-180' : ''}`} />
          </button>

          {avatarOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
              {/* Header */}
              <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                <p className="text-sm font-bold text-slate-900 dark:text-white">{displayName}</p>
                <p className={`text-xs font-medium ${colors.text}`}>{roleLabel}</p>
              </div>

              {/* Mode switcher — only shown when this tenant has more than
                  one mode enabled; primary way to switch on mobile */}
              {enabledModes.length > 1 && (
                <div className="border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
                  <p className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">POS Mode</p>
                  <div className={`grid gap-1 ${enabledModes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {enabledModes.map((m) => {
                      const meta = MODE_META[m] || MODE_META.retail
                      const Icon = meta.icon
                      return (
                        <button
                          key={m}
                          onClick={() => { setPosMode(m); setAvatarOpen(false) }}
                          className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
                            posMode === m
                              ? meta.activeClass
                              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {meta.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Links */}
              <div className="py-1">
                {canSeeSettings && (
                  <>
                    <button
                      onClick={() => { setAvatarOpen(false); navigate('/app/settings') }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <User className="h-4 w-4 text-slate-400" />
                      Profile
                    </button>
                    <button
                      onClick={() => { setAvatarOpen(false); navigate('/app/settings') }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Settings className="h-4 w-4 text-slate-400" />
                      Settings
                    </button>
                  </>
                )}
              </div>
              <div className="border-t border-slate-100 py-1 dark:border-slate-800">
                <button
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>

    {/* Fiscal day open warning modal */}
    {showFiscalWarning && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-xl bg-amber-100 p-2 dark:bg-amber-900/40">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white">Fiscal Day Still Open</h3>
              <p className="text-xs text-slate-500">Close the fiscal day before signing out</p>
            </div>
          </div>
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
            Your ZIMRA fiscal day is still open. You should close it before signing out to ensure your fiscal records are complete. You can close it in <strong>Fiscalisation</strong>.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowFiscalWarning(false); navigate('/app/fiscalisation') }}
              className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
            >
              Go to Fiscalisation
            </button>
            <button
              onClick={confirmSignOut}
              className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Sign Out Anyway
            </button>
          </div>
        </div>
      </div>
    )}

    {!window.tengaDesktop?.isDesktop && (
      <SyncQueueManager
        isOpen={showSyncManager}
        onClose={() => setShowSyncManager(false)}
        onChanged={() => {
          pendingSyncCount().then(setPendingSync).catch(() => {})
          failedSyncCount().then(setFailedSync).catch(() => {})
        }}
      />
    )}
    </>
  )
}
