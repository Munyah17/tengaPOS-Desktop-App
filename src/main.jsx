import './polyfills.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import toast from 'react-hot-toast'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary.jsx'
import { hardReload } from './lib/hardReload.js'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// Chrome (and other Chromium browsers) silently change a FOCUSED
// type="number" input's value by one `step` when the mouse wheel scrolls
// over it — no click, no keypress, just scrolling the page while the
// wheel happens to be hovering a focused price/quantity field. Reported
// live as exactly this: $2.00 -> $1.99, 344 -> 343 (each off by exactly
// one step) with the person certain they never touched those fields.
// Blurring the moment a wheel event reaches a focused number input stops
// the browser from ever applying that delta — one global handler instead
// of wiring an onWheel guard into every individual number input across
// the app (dozens of them, more added over time).
document.addEventListener('wheel', () => {
  const el = document.activeElement
  if (el?.tagName === 'INPUT' && el.type === 'number') el.blur()
}, { passive: true })

// The service worker updates itself in the background (registerType:
// 'autoUpdate'), but that alone never tells an already-open tab to
// actually use the new version — someone could sit on a stale build
// indefinitely, silently missing new features, with nothing visibly
// "broken" to tip them off. This surfaces it explicitly and lets them
// choose when to reload, rather than forcing it mid-transaction.
//
// The browser itself only re-checks the service worker script for changes
// on a fresh navigation/reload — a POS terminal or workshop tablet that's
// been left open (tab never closed) for days never triggers that check at
// all, so it silently keeps running whatever build it loaded on first open,
// forever, with no visible sign anything's wrong. onRegisteredSW below adds
// an explicit periodic check so a long-lived tab still discovers new
// deploys instead of only ever checking once at initial load.
const SW_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

// Reported live: this toast was showing up on effectively every page open,
// "even when there are no updates" — costing real work time. workbox-
// window's onNeedRefresh can re-fire for the same still-waiting worker on
// more than one of the periodic checks below, not just once per genuine
// new deploy — nothing here previously stopped it from showing again and
// again for what is, from the person's side, the exact same update they
// already saw. This cooldown means it can surface at most once per
// window, no matter how many update checks happen inside it.
const SW_TOAST_COOLDOWN_MS = 15 * 60 * 1000
const SW_TOAST_LAST_SHOWN_KEY = 'tengapos_sw_toast_last_shown'

if (!window.tengaDesktop?.isDesktop) {
  registerSW({
    immediate: true,
    onRegisteredSW(swUrl, registration) {
      if (!registration) return
      setInterval(() => { registration.update().catch(() => {}) }, SW_UPDATE_CHECK_INTERVAL_MS)
    },
    onNeedRefresh() {
      try {
        const last = Number(localStorage.getItem(SW_TOAST_LAST_SHOWN_KEY) || 0)
        if (Date.now() - last < SW_TOAST_COOLDOWN_MS) return
        localStorage.setItem(SW_TOAST_LAST_SHOWN_KEY, String(Date.now()))
      } catch { /* localStorage unavailable — fall through and show it anyway */ }
      toast(
        (t) => (
          <span className="flex items-center gap-3">
            <span>A new version is available</span>
            <button
              onClick={() => { toast.dismiss(t.id); hardReload() }}
              className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-brand-700"
            >
              Refresh
            </button>
          </span>
        ),
        { duration: 20000, id: 'sw-update-available' },
      )
    },
  })
}
