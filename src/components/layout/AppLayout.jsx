import { useState, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Gamepad2 } from 'lucide-react'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import BottomNav from './BottomNav'
import { useAuthStore, ROLE_LABELS } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { useReceiptConfigStore } from '@/stores/receiptConfigStore'
import { useFiscalStore } from '@/stores/fiscalStore'
import { startBackgroundSync } from '@/lib/offlineSync'
import { fetchEffectiveReceiptConfig } from '@/lib/db'
import { loadWithOfflineCache } from '@/lib/offlineCache'
import { applyWhitelabelTheme, clearWhitelabelTheme } from '@/lib/whitelabelTheme'
import { supabase } from '@/lib/supabase'
import { isDemoRoute } from '@/lib/demoMode'
import { switchDemoRole, exitDemoMode, firstAllowedDemoPath } from '@/lib/demoAuth'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import toast from 'react-hot-toast'

const DEMO_SWITCHABLE_ROLES = ['vendor', 'shop_manager', 'supervisor', 'cashier', 'shop_assistant']

export default function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const { tenant, branch, role } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inDemo = isDemoRoute()

  const handleDemoRoleChange = (e) => {
    const nextRole = e.target.value
    switchDemoRole(nextRole)
    navigate(firstAllowedDemoPath(nextRole), { replace: true })
  }

  const handleExitDemo = () => {
    exitDemoMode()
    navigate('/', { replace: true })
  }

  // "View as Tenant" (AdminTenants.jsx) stashes the admin's own session here
  // before switching to the tenant's -- this banner is the only way back.
  const impersonatingTenant = sessionStorage.getItem('tengapos_impersonating_tenant')
  const exitImpersonation = () => {
    const saved = sessionStorage.getItem('tengapos_admin_return_session')
    sessionStorage.removeItem('tengapos_admin_return_session')
    sessionStorage.removeItem('tengapos_impersonating_tenant')
    // Clearing this is what actually matters -- supabase.js re-evaluates
    // it on the fresh load below and switches this tab back to the main
    // storage key, which was never touched while impersonating (see
    // supabase.js), so the admin's session is simply still sitting there.
    // The handoff below is a defensive top-up in case that session's
    // access token needs a refresh this tab isn't around to trigger --
    // NOT applied via setSession() here, same reasoning as viewAsTenant().
    sessionStorage.removeItem('tengapos_impersonation_mode')
    if (saved) sessionStorage.setItem('tengapos_session_handoff', saved)
    // This tab was opened via window.open() from the admin panel in the
    // normal case (see viewAsTenant()) -- closing it just returns focus to
    // that still-open, untouched Super Admin tab, no navigation needed.
    // window.close() silently no-ops on a tab the browser doesn't consider
    // script-opened (e.g. the popup-blocked fallback path, or a page
    // refresh while impersonating); execution reaching the line after it
    // means that happened, so fall back to navigating there instead.
    window.close()
    window.location.href = '/admin/super/tenants'
  }

  // Real, persisted receipt branding — loaded here (not just when Settings
  // happens to be visited) so every role gets correctly-branded receipts,
  // not just whoever last opened the Fiscalisation/Receipts Config page.
  // Wrapped in the shared IndexedDB offline cache so an offline relaunch or
  // a failed fetch keeps printing the tenant's real details instead of
  // silently reverting to demo placeholders.
  useEffect(() => {
    if (!tenant?.id) return
    const scopeKey = `${tenant.id}:${branch?.id || ''}`
    if (window.tengaDesktop?.isDesktop) {
      useReceiptConfigStore.getState().loadFromDB({ store_name: tenant.name }, scopeKey)
      return
    }
    const loadReceiptConfig = () => loadWithOfflineCache(
      ['effectiveReceiptConfig', tenant.id, branch?.id],
      () => fetchEffectiveReceiptConfig(tenant.id, branch?.id || null),
      { onData: (row) => useReceiptConfigStore.getState().loadFromDB(row, scopeKey) },
    )
    loadReceiptConfig()
    window.addEventListener('tengapos:force-refresh', loadReceiptConfig)
    return () => window.removeEventListener('tengapos:force-refresh', loadReceiptConfig)
  }, [tenant?.id, branch?.id])

  // Fiscal config too — previously only loaded when a Vendor opened the
  // Settings/Fiscalisation pages, so cashier sessions printed receipts with
  // an empty fiscal store (no branch branding fallback, no FDMS submission).
  // Same cache key the Fiscalisation page uses, so they share one copy.
  useEffect(() => {
    if (!tenant?.id || window.tengaDesktop?.isDesktop) return
    const loadFiscalConfig = () => loadWithOfflineCache(
      ['fiscalConfig', tenant.id],
      () => supabase.from('tenant_fiscal_configs')
        .select('*')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
        .then(({ data, error }) => { if (error) throw error; return data }),
      { onData: (data) => { if (data) useFiscalStore.getState().loadFromDB(data) } },
    )
    loadFiscalConfig()
    window.addEventListener('tengapos:force-refresh', loadFiscalConfig)
    return () => window.removeEventListener('tengapos:force-refresh', loadFiscalConfig)
  }, [tenant?.id])

  // White-label: re-skin the whole portal (brand colour palette, favicon,
  // page title) for tenants with the white-label add-on. Cleared on
  // logout/unmount so the login screen and admin portal stay tengaPOS.
  useEffect(() => {
    applyWhitelabelTheme(tenant?.whitelabel)
    return () => clearWhitelabelTheme()
  }, [tenant?.whitelabel])

  // The active POS mode is the tenant's own assignment, not a free local
  // toggle — previously posMode lived only in localStorage, so any user
  // could flip into "Restaurant" on a plain retail tenant. Whenever the
  // tenant record loads or changes (including live, via the realtime
  // listener below), snap the local mode back in line: keep it if it's
  // still one of the tenant's enabled_modes, otherwise fall back to the
  // tenant's assigned default (pos_mode).
  useEffect(() => {
    if (!tenant?.id) return
    const enabled = tenant.enabled_modes?.length ? tenant.enabled_modes : [tenant.pos_mode || 'retail']
    const current = useThemeStore.getState().posMode
    if (!enabled.includes(current)) {
      useThemeStore.getState().setPosMode(tenant.pos_mode || enabled[0])
    }
  }, [tenant?.id, tenant?.pos_mode, tenant?.enabled_modes])

  // Lock body scroll when mobile sidebar is open
  useEffect(() => {
    document.body.style.overflow = mobileSidebarOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileSidebarOpen])

  // Cloud-based but offline-first: cache products for offline POS use and
  // replay any sales queued while the connection was down. Previously a
  // successful background sync only showed a toast -- every already-open
  // page (Orders, Inventory, Dashboard...) stayed on its stale pre-sync
  // data until the user manually hit "Refresh Online Updates" or reloaded,
  // which read as "offline actions take forever to show up" even though
  // the sync itself had already completed. Now it does the same
  // (non-reloading) refresh RefreshOnlineButton does: fire the shared
  // force-refresh event and invalidate every mounted React Query query.
  useEffect(() => {
    if (!tenant?.id || isDemoRoute() || window.tengaDesktop?.isDesktop) return
    return startBackgroundSync(tenant.id, {
      onSynced: ({ synced }) => {
        toast.success(`Synced ${synced} offline sale${synced !== 1 ? 's' : ''}`)
        window.dispatchEvent(new CustomEvent('tengapos:force-refresh'))
        queryClient.invalidateQueries()
      },
      // A permanent failure (e.g. no longer enough stock by the time an
      // offline sale replayed) will never resolve itself by retrying again
      // — surface it instead of leaving it silently stuck. The TopBar's
      // pending-sync badge is where they review/retry/discard it.
      onFailed: ({ permanentlyFailed }) => {
        toast.error(
          `${permanentlyFailed} offline sale${permanentlyFailed !== 1 ? 's' : ''} couldn't sync — check the sync icon in the top bar`,
          { duration: 8000 },
        )
      },
    })
  }, [tenant?.id, queryClient])

  // Quietly reconfirm the offline-cached session against the server on the
  // same rhythm as data sync — immediately once online, then every 5
  // minutes. Locks the account only on a genuine identity mismatch; a
  // network hiccup here does nothing (see validateSession).
  useEffect(() => {
    if (isDemoRoute() || window.tengaDesktop?.isDesktop) return
    const tick = () => useAuthStore.getState().validateSession()
    tick()
    const interval = setInterval(tick, 5 * 60 * 1000)
    window.addEventListener('online', tick)
    return () => {
      clearInterval(interval)
      window.removeEventListener('online', tick)
    }
  }, [])

  // A plan approval or trial extension can happen while the tenant already
  // has this tab open (Super Admin approving them, or a payment webhook
  // firing) — without this, the trial banner and gated features would stay
  // stuck on stale data until the user manually logs out and back in.
  useEffect(() => {
    if (!tenant?.id || isDemoRoute() || window.tengaDesktop?.isDesktop) return
    const channel = supabase
      .channel(`tenant-live-${tenant.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'tenants',
        filter: `id=eq.${tenant.id}`,
      }, (payload) => {
        useAuthStore.getState().updateTenant(payload.new)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tenant?.id])

  // Reported live: a client adding/editing inventory on one device could
  // take a long time to show up on another (e.g. a cashier's POS screen
  // left open all shift). staleTime alone doesn't fix this -- React Query
  // only re-checks stale data on specific triggers (refocus, remount,
  // explicit invalidation), never on a plain background timer, so a POS
  // tab that just stays open and focused could go the whole shift without
  // ever re-checking. This pushes the invalidation instead of waiting for
  // one of those triggers to eventually happen: any insert/update/delete
  // on this tenant's products refreshes every open tab within moments,
  // on every device, same pattern as the tenant-live channel above.
  useEffect(() => {
    if (!tenant?.id || isDemoRoute() || window.tengaDesktop?.isDesktop) return
    const channel = supabase
      .channel(`products-live-${tenant.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'products',
        filter: `tenant_id=eq.${tenant.id}`,
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['products', tenant.id] })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tenant?.id, queryClient])

  return (
    // Some mobile browsers (esp. ones with a persistent, non-retracting
    // top search/address bar) draw that bar as an overlay on top of page
    // content instead of shrinking the reported viewport for it -- 100dvh/
    // 100vh then measure taller than what's actually visible, and the
    // header ends up rendered partly behind the browser's own chrome with
    // no way to reach it (reported: only fixable by zooming/rotating/
    // reopening until the browser recalculates). overflow-y-auto here
    // (was overflow-hidden) means that failure mode is now just "scroll up
    // a little" instead of "stuck" -- on a device where the height is
    // already correct, there's nothing to scroll and nothing changes.
    // safe-area-inset-top is a second, standards-based line of defense for
    // browsers that report their own chrome overlap properly.
    <div
      className="flex h-screen max-h-screen overflow-y-auto bg-slate-50 dark:bg-slate-950"
      style={{ height: '100dvh', paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      <Sidebar open={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {inDemo && (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm text-white">
            <span className="flex items-center gap-1.5 font-semibold">
              <Gamepad2 className="h-4 w-4" />
              Live Demo — sample data only, nothing here is saved
            </span>
            <div className="flex items-center gap-2">
              <select
                value={role}
                onChange={handleDemoRoleChange}
                className="rounded-lg border-none bg-white/20 px-2 py-1 text-xs font-bold text-white [&>option]:text-slate-900"
              >
                {DEMO_SWITCHABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <a href="/register" className="rounded-lg bg-white/20 px-3 py-1 text-xs font-bold hover:bg-white/30">
                Sign Up
              </a>
              <button onClick={handleExitDemo} className="rounded-lg bg-white/15 px-3 py-1 text-xs font-bold hover:bg-white/25">
                Exit Demo
              </button>
            </div>
          </div>
        )}
        {impersonatingTenant && (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 bg-indigo-600 px-4 py-2 text-sm text-white">
            <span>
              Viewing as <b>{impersonatingTenant}</b> — actions here are real and affect their account.
            </span>
            <button
              onClick={exitImpersonation}
              className="rounded-lg bg-white/15 px-3 py-1 text-xs font-bold hover:bg-white/25"
            >
              Exit to Super Admin
            </button>
          </div>
        )}
        <TopBar onMenuClick={() => setMobileSidebarOpen(true)} />
        {/* pb-16 clears the fixed BottomNav below (mobile/tablet only --
            BottomNav itself is lg:hidden, so this is a no-op on desktop). */}
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-16 lg:pb-0">
          {/* Keyed by path so a crash on one page doesn't take the sidebar/topbar
              down with it, and navigating away recovers cleanly instead of
              staying stuck on the fallback screen. */}
          <ErrorBoundary key={location.pathname} fullPage={false}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
