import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '@/lib/supabase'
import { isStaleJwtError, refreshSessionOnce } from '@/lib/authRetry'
import { isDemoRoute, setDemoActive, DEMO_ROLE_SESSION_KEY } from '@/lib/demoMode'
import { authenticateLocalUser, getLocalInstallation } from '@/lib/localAuth'

const isDesktopApp = () => typeof window !== 'undefined' && window.tengaDesktop?.isDesktop === true

// On a weak/slow connection, signInWithPassword could otherwise hang for a
// very long time with no feedback (the browser's own fetch timeout, if any,
// is much longer than a cashier will wait). Fail fast with a clear message
// instead so the login form can show "try again" rather than a dead spinner.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

export const ROLE_COLORS = {
  vendor: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  shop_manager: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  supervisor: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  cashier: { bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-700 dark:text-teal-400' },
  shop_assistant: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-700 dark:text-slate-300' },
  tech_support: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
  super_admin: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  admin: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400' },
  associate: { bg: 'bg-cyan-100 dark:bg-cyan-900/30', text: 'text-cyan-700 dark:text-cyan-400' },
}

export const ROLE_LABELS = {
  vendor: 'Vendor',
  shop_manager: 'Shop Manager',
  supervisor: 'Supervisor',
  cashier: 'Cashier',
  shop_assistant: 'Shop Assistant',
  tech_support: 'Tech Support',
  super_admin: 'Super Admin',
  admin: 'Admin',
  associate: 'Associate',
}

export const NAV_PERMISSIONS = {
  super_admin: ['dashboard', 'pos', 'inventory', 'orders', 'kitchen', 'job_cards', 'vehicle_registry', 'mechanics', 'quotations', 'production', 'equipment_rental', 'prescriptions', 'doctors', 'insurers', 'controlled_substances', 'appointments', 'eye_prescriptions', 'age_verifications', 'transactions', 'security', 'discount_reviews', 'reports', 'insights', 'staff', 'tasks', 'branches', 'fiscalisation', 'payments', 'settings'],
  admin: ['dashboard', 'pos', 'inventory', 'orders', 'job_cards', 'vehicle_registry', 'mechanics', 'quotations', 'production', 'equipment_rental', 'prescriptions', 'doctors', 'insurers', 'controlled_substances', 'appointments', 'eye_prescriptions', 'age_verifications', 'transactions', 'security', 'discount_reviews', 'reports', 'insights', 'staff', 'tasks', 'branches', 'fiscalisation', 'payments', 'settings'],
  associate: ['dashboard', 'reports', 'branches'],
  vendor: ['dashboard', 'requests', 'pos', 'inventory', 'stock_take', 'reorder', 'orders', 'kitchen', 'job_cards', 'vehicle_registry', 'mechanics', 'quotations', 'production', 'equipment_rental', 'prescriptions', 'doctors', 'insurers', 'controlled_substances', 'appointments', 'eye_prescriptions', 'age_verifications', 'transactions', 'refund_audit', 'cash_up', 'security', 'discount_reviews', 'reports', 'insights', 'staff', 'tasks', 'branches', 'fiscalisation', 'payments', 'hr', 'invoicing', 'customers', 'statements', 'accounting', 'settings'],
  // Shop managers run day-to-day operations for their own branch — payment
  // gateway management and ZIMRA fiscal device registration stay Vendor-only.
  shop_manager: ['dashboard', 'pos', 'inventory', 'stock_take', 'reorder', 'orders', 'kitchen', 'job_cards', 'vehicle_registry', 'mechanics', 'quotations', 'production', 'equipment_rental', 'prescriptions', 'doctors', 'insurers', 'controlled_substances', 'appointments', 'eye_prescriptions', 'age_verifications', 'transactions', 'refund_audit', 'cash_up', 'security', 'discount_reviews', 'reports', 'insights', 'staff', 'tasks', 'branches', 'hr', 'invoicing', 'customers', 'statements', 'accounting', 'settings'],
  supervisor: ['dashboard', 'pos', 'inventory', 'stock_take', 'reorder', 'orders', 'job_cards', 'vehicle_registry', 'mechanics', 'quotations', 'production', 'equipment_rental', 'prescriptions', 'doctors', 'insurers', 'controlled_substances', 'appointments', 'eye_prescriptions', 'age_verifications', 'transactions', 'refund_audit', 'cash_up', 'security', 'discount_reviews', 'reports', 'tasks', 'invoicing', 'customers', 'statements', 'accounting'],
  // Dispensing happens at the till, so cashier/shop_assistant need the log
  // too — same reasoning as prescription_dispenses' RLS policy. Stock Take
  // counting and Cash-Up are both deliberately open to them too (see
  // 1786120000_stock_take.sql / 1786130000_cash_up.sql) -- real
  // stock-takes are usually counted by whoever's on the floor, and a
  // shared till needs whoever's working it to be able to open/close one.
  // 'dashboard' is appended (not first) so it doesn't change their default
  // landing page on login, which stays POS -- it maps to MyDashboard (see
  // App.jsx's DashboardGate), an account-scoped summary, not the full
  // tenant Dashboard the rest of NAV_PERMISSIONS' 'dashboard' entries get.
  cashier: ['pos', 'orders', 'job_cards', 'equipment_rental', 'prescriptions', 'appointments', 'eye_prescriptions', 'age_verifications', 'tasks', 'stock_take', 'cash_up', 'dashboard'],
  shop_assistant: ['pos', 'prescriptions', 'appointments', 'eye_prescriptions', 'age_verifications', 'tasks', 'stock_take', 'cash_up', 'dashboard'],
  tech_support: ['dashboard', 'reports', 'insights', 'orders', 'transactions'],
}

async function loadProfile() {
  // Single round trip via RPC instead of up to 3 sequential queries
  // (app_users check, then users+tenants join, then a separate branches
  // lookup) — meaningful latency savings on a slow connection, since this
  // runs on every login and every app boot.
  const { data, error } = await supabase.rpc('get_my_profile')
  if (error) throw error
  if (!data) throw new Error('Profile not found')
  return data
}

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      session: null,
      profile: null,
      tenant: null,
      role: null,
      branch: null,
      userType: null,
      tenantStatus: null,
      desktopSetupComplete: false,
      isAuthenticated: false,
      isLoading: true,

      initAuth: async () => {
        if (isDesktopApp()) {
          set({ isLoading: true })
          try {
            const installation = await getLocalInstallation()
            set({
              user: null,
              session: null,
              profile: null,
              tenant: installation?.shop || null,
              role: null,
              branch: installation?.branch || null,
              userType: null,
              tenantStatus: installation ? 'active' : null,
              desktopSetupComplete: !!installation,
              isAuthenticated: false,
              isLoading: false,
            })
          } catch {
            set({ desktopSetupComplete: false, isAuthenticated: false, isLoading: false })
          }
          return
        }
        // A page refresh while inside the demo sandbox would otherwise
        // fall straight through to the real-session check below, find
        // nothing, and bounce the visitor to /login -- this restores the
        // sandbox from a tab-scoped (not persisted) flag instead. Dynamic
        // import avoids a static circular dependency (demoAuth.js imports
        // useAuthStore from this same file).
        const { restoreDemoModeIfAny } = await import('@/lib/demoAuth')
        if (restoreDemoModeIfAny()) return
        // /demo populates this same store with sandbox data via setState
        // (see demoMode.js) so the real pages it reuses don't need a forked
        // auth system -- but that means this store now sometimes holds a
        // fake session with no real Supabase counterpart. Checking a real
        // session here while on /demo would find none and, worse, would
        // never actually clear the demo tenant/user/role fields it can't
        // account for (only isAuthenticated), leaving stale demo identity
        // sitting in the persisted store. Simplest correct fix: this store
        // is never the source of truth for a real session while on /demo,
        // so just don't touch it here.
        if (isDemoRoute()) { set({ isLoading: false }); return }
        set({ isLoading: true })
        try {
          // One-time handoff from entering/exiting "View as Tenant"
          // (AdminTenants.jsx / AppLayout.jsx) -- this tab's supabase
          // client was just (re)created against a fresh storage key (see
          // supabase.js) that has no session in it yet. Adopting it here,
          // before getSession() below, guarantees this tab picks up the
          // right identity on its very first read with no race against
          // that call. Consumed once so a later refresh in this tab relies
          // on the now-persisted session instead of replaying stale tokens.
          const handoff = sessionStorage.getItem('tengapos_session_handoff')
          if (handoff) {
            sessionStorage.removeItem('tengapos_session_handoff')
            try {
              const tokens = JSON.parse(handoff)
              await supabase.auth.setSession(tokens)
            } catch { /* malformed/expired handoff -- fall through to a normal getSession() */ }
          }
          // getSession() reads the persisted Supabase session locally — this
          // succeeds offline as long as a prior login stored one.
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.user) {
            try {
              // A slow (not fully offline) connection shouldn't hang the
              // whole app boot indefinitely — fall through to the cached-
              // profile branch below just like an outright failure would.
              const profileData = await withTimeout(loadProfile(), 10000, 'timeout')
              if (profileData.is_locked) {
                await supabase.auth.signOut()
                set({ isLoading: false, isAuthenticated: false })
                return
              }
              set({
                user: session.user,
                session,
                profile: profileData,
                tenant: profileData.tenants || null,
                role: profileData.role,
                branch: profileData.branch || null,
                userType: profileData.userType,
                tenantStatus: profileData.tenantStatus || null,
                isAuthenticated: true,
                isLoading: false,
              })
            } catch {
              // loadProfile() needs the network — if that's what's missing
              // (not the session itself), keep the user logged in on the
              // last-known persisted profile instead of signing them out.
              // A valid session is still a valid session offline.
              // BUT: don't trust persisted is_locked state (it's server-side
              // mutable, changes without warning). Just use cached profile
              // data for name/email/role, ignore the lock flag.
              const cached = get()
              if (cached.profile) {
                // Have a cached profile and a valid session — authenticate,
                // even if the profile refresh timed out. Network hiccups
                // shouldn't prevent offline access.
                // Pass the valid session through, ignore cached lock state.
                set({
                  user: session.user,
                  session,
                  isAuthenticated: true,
                  isLoading: false,
                })
              } else {
                set({ isLoading: false, isAuthenticated: false })
              }
            }
          } else {
            set({ isLoading: false, isAuthenticated: false })
          }
        } catch {
          set({ isLoading: false, isAuthenticated: false })
        }
      },

      // Accepts either an email, or a username + its account's email
      // together — usernames are only unique within a tenant now, so a
      // bare username alone can no longer identify a single account
      // (Login.jsx collects the email alongside it whenever the typed
      // identifier isn't already email-shaped).
      signIn: async (identifier, password, usernameEmail) => {
        if (isDesktopApp()) {
          set({ isLoading: true })
          try {
            const local = await authenticateLocalUser(identifier, password)
            set({
              user: local.user,
              session: null,
              profile: local.profile,
              tenant: local.tenant,
              role: local.role,
              branch: local.branch,
              userType: local.userType,
              tenantStatus: local.tenantStatus,
              desktopSetupComplete: true,
              isAuthenticated: true,
              isLoading: false,
            })
            return local.userType
          } catch (error) {
            set({ isLoading: false })
            throw error
          }
        }
        // A real credential login always ends any demo session -- otherwise
        // a visitor who tried /demo earlier in this tab and then logs in
        // for real would have their genuine session silently skipped by
        // the persist/initAuth demo guards below (see demoMode.js), or
        // worse, have this same tab's next refresh restore the sandbox
        // instead of their real session (see the sessionStorage key
        // initAuth checks first).
        setDemoActive(false)
        sessionStorage.removeItem(DEMO_ROLE_SESSION_KEY)
        set({ isLoading: true })

        try {
          let email = identifier
          if (!identifier.includes('@')) {
            if (!usernameEmail) {
              set({ isLoading: false })
              throw new Error('Enter the email address linked to that username')
            }
            const { data: resolvedEmail, error: resolveErr } = await withTimeout(
              supabase.rpc('resolve_login_email', { p_username: identifier, p_email: usernameEmail }),
              15000,
              'Slow or no connection — check your network and try again',
            )
            if (resolveErr || !resolvedEmail) {
              set({ isLoading: false })
              // Same generic message a wrong password gets — never reveal
              // whether it was the username/email pairing or the password
              // that was wrong.
              throw new Error('Invalid email/username or password')
            }
            email = resolvedEmail
          }

          const { data, error } = await withTimeout(
            supabase.auth.signInWithPassword({ email, password }),
            15000,
            'Slow or no connection — check your network and try again',
          )

          if (error) {
            set({ isLoading: false })
            throw error
          }

          const profileData = await withTimeout(
            loadProfile(),
            15000,
            'Slow or no connection — check your network and try again',
          )

          if (profileData.is_locked) {
            await supabase.auth.signOut()
            set({ isLoading: false })
            throw new Error(`Account locked${profileData.locked_reason ? `: ${profileData.locked_reason}` : ''}. Contact your Super Admin to unlock it.`)
          }

          set({
            user: data.user,
            session: data.session,
            profile: profileData,
            tenant: profileData.tenants || null,
            role: profileData.role,
            branch: profileData.branch || null,
            userType: profileData.userType,
            tenantStatus: profileData.tenantStatus || null,
            isAuthenticated: true,
            isLoading: false,
          })
          
          return profileData.userType
        } catch (err) {
          // Offline fallback: if this is the same person who was already
          // logged in on this device, getSession() still has their token
          // locally and we already have their profile persisted from last
          // time — use that instead of re-fetching (which needs the network
          // that just failed). This only re-uses an existing valid session;
          // it never accepts a password without checking it when online.
          // The username->email resolution above needs the network too, so
          // if we're offline it never ran — match the cached profile by
          // either identifier, not just the (possibly still-unresolved) email.
          const cached = get()
          const matchesCachedIdentity = (p) => p?.email === identifier || (p?.username && p.username === identifier)
          if (matchesCachedIdentity(cached.profile) && cached.profile?.is_locked) {
            // Must escape the inner try/catch below undiluted — it exists
            // to swallow network errors and fall through to the original
            // message, but a lock is a real, user-facing reason to stop.
            set({ isLoading: false })
            throw new Error(`Account locked${cached.profile.locked_reason ? `: ${cached.profile.locked_reason}` : ''}. Contact your Super Admin to unlock it.`)
          }

          try {
            const { data: { session } } = await supabase.auth.getSession()
            if (session?.user && matchesCachedIdentity(cached.profile) && cached.profile?.email === session.user.email) {
              set({
                user: session.user,
                session,
                profile: cached.profile,
                tenant: cached.tenant,
                role: cached.role,
                branch: cached.branch,
                userType: cached.userType,
                tenantStatus: cached.tenantStatus,
                isAuthenticated: true,
                isLoading: false,
              })
              return cached.userType
            }
          } catch (cacheErr) {
            // Cache fallback failed, continue to throw original error
          }

          set({ isLoading: false })
          throw err
        }
      },

      signUp: async (email, password, name, businessName, businessType, phone, detail = {}) => {
        setDemoActive(false)
        sessionStorage.removeItem(DEMO_ROLE_SESSION_KEY)
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              name, business_name: businessName, business_type: businessType || 'retail', phone,
              whatsapp_number: detail.whatsappNumber || null,
              industry: detail.industry || null,
              location: detail.location || null,
              requested_branches: detail.requestedBranches || null,
              team_size_range: detail.teamSizeRange || null,
              requested_plan_pref: detail.requestedPlanPref || null,
              work_address: detail.workAddress || null,
              work_contact: detail.workContact || null,
              special_requirements: detail.specialRequirements || null,
            },
          },
        })
        if (error) throw error

        // If email confirmation is disabled Supabase returns a session immediately.
        // Load the profile (the DB trigger will have already created tenant/user/branch)
        // and set full auth state so ProtectedRoute doesn't bounce the user.
        if (data.session && data.user) {
          try {
            const profileData = await loadProfile()
            set({
              user: data.user,
              session: data.session,
              profile: profileData,
              tenant: profileData.tenants || null,
              role: profileData.role,
              branch: profileData.branch || null,
              userType: profileData.userType,
              tenantStatus: profileData.tenantStatus || 'pending',
              isAuthenticated: true,
              isLoading: false,
            })
          } catch {
            // Profile may not be ready yet in edge cases; user can sign in normally
          }
        }

        return data
      },

      clearAuth: async () => {
        if (isDesktopApp()) {
          set({
            user: null,
            session: null,
            profile: null,
            role: null,
            isAuthenticated: false,
            isLoading: false,
          })
          return
        }
        // scope: 'local' only ever clears THIS tab/device's own copy of
        // the session -- never revokes the underlying refresh token
        // server-side. validateSession() below is the main caller of this
        // on an identity mismatch, and in that exact situation there's no
        // way to be sure the currently-loaded session even belongs to the
        // account this tab thinks it's signed into -- the default 'global'
        // scope would revoke whatever session actually IS loaded, which
        // could be a completely different, legitimately active one.
        await supabase.auth.signOut({ scope: 'local' })
        set({
          user: null,
          session: null,
          profile: null,
          tenant: null,
          role: null,
          branch: null,
          userType: null,
          tenantStatus: null,
          isAuthenticated: false,
          isLoading: false,
        })
      },

      // The other half of offline-first auth: a cashier can keep working on
      // a cached session while offline, but the moment connectivity returns
      // this quietly confirms the server still agrees with what the device
      // trusted locally. It only locks on a genuine mismatch (the session
      // token now resolves to a different identity) — never for a plain
      // network failure, and never for email/profile changes (those are
      // routine admin actions with their own handling).
      validateSession: async () => {
        if (isDesktopApp()) return
        if (!navigator.onLine) return
        const cached = get()
        if (!cached.isAuthenticated || !cached.user) return

        try {
          let { data: { user: serverUser }, error: authErr } = await supabase.auth.getUser()
          // A token signed under a since-rotated key fails verification
          // here every single time (it isn't expired, so autoRefreshToken
          // never replaces it on its own) -- this state was previously
          // indistinguishable from "couldn't reach the server", so it was
          // silently left alone forever: cached auth state still says
          // logged in, but every real API call using that same broken
          // token keeps failing (reported live as products/inventory
          // silently not loading). One refresh attempt is enough to
          // recover if that's genuinely what happened; a real network
          // failure just fails the refresh too and still falls through to
          // "inconclusive" below, exactly as before.
          if (authErr && isStaleJwtError(authErr.message) && await refreshSessionOnce(supabase)) {
            ;({ data: { user: serverUser }, error: authErr } = await supabase.auth.getUser())
          }
          if (authErr || !serverUser) return // couldn't reach/validate — inconclusive, not a mismatch

          if (serverUser.id !== cached.user.id) {
            // Session token resolves to a different user than what's cached.
            // This can happen legitimately (logged out and back in on same device),
            // but to be safe, just sign out. Don't lock — locking is only for
            // actual account security issues, not for session confusion.
            await get().clearAuth()
            return
          }

          // Session token is valid and consistent. Attempt to refresh profile,
          // but don't fail the whole check if it times out — just skip the
          // refresh. Network hiccups mid-validation should not lock anyone out.
          try {
            const freshProfile = await withTimeout(loadProfile(), 5000, 'timeout')
            if (freshProfile?.is_locked) {
              // Already locked (by this check on another device, or by an
              // admin) — just sign out locally, no need to lock again.
              await get().clearAuth()
              return
            }
            // Quietly refresh the profile if it loaded successfully
            if (freshProfile) set({ profile: freshProfile })
          } catch {
            // Profile refresh failed (network, timeout) — that's fine,
            // session is still valid. Keep working offline.
          }
        } catch {
          // Network/timeout mid-check — inconclusive, try again next cycle
        }
      },

      setAuth: ({ user, session, profile, tenant, role, branch }) =>
        set({ user, session, profile, tenant, role, branch, isAuthenticated: !!user, isLoading: false }),

      // Merges a partial tenant row (e.g. from a realtime UPDATE payload) into
      // the current tenant in place — so plan approvals, trial extensions, or
      // status changes made elsewhere (Super Admin, payment webhook) reach an
      // already-open session without waiting for the user to log out/in.
      updateTenant: (partialTenant) =>
        set((state) => ({ tenant: state.tenant ? { ...state.tenant, ...partialTenant } : state.tenant })),

      setLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: 'tengapos-auth',
      // While on /demo this same store briefly holds sandbox data (fake
      // tenant/user/role, no real session) -- never let that reach the
      // persisted key a real login/logout normally owns. Returning {} here
      // simply skips the write; whatever a real session last persisted
      // stays exactly as it was for the next real page load.
      partialize: (state) => (isDemoRoute() ? {} : {
        ...(isDesktopApp() ? {} : {
        user: state.user,
        profile: state.profile,
        tenant: state.tenant,
        role: state.role,
        branch: state.branch,
        userType: state.userType,
        isAuthenticated: state.isAuthenticated,
        tenantStatus: state.tenantStatus,
        }),
      }),
    }
  )
)
