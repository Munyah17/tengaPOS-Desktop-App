import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound, Wifi, WifiOff } from 'lucide-react'
import Button from '@/components/common/Button'
import { activateDesktopLicense, isDesktopLicenseApiConfigured } from '@/lib/desktopLicense'
import toast from 'react-hot-toast'

export default function DesktopLicensePage() {
  const navigate = useNavigate()
  const [activationCode, setActivationCode] = useState('')
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState('')
  const isOnline = navigator.onLine
  const apiConfigured = isDesktopLicenseApiConfigured()

  const submit = async (event) => {
    event.preventDefault()
    setActivating(true)
    setError('')
    try {
      await activateDesktopLicense(activationCode)
      toast.success('License confirmed for this computer')
      navigate('/setup', { replace: true })
    } catch (activationError) {
      const message = activationError.message || 'License activation failed'
      setError(message)
      toast.error(message)
    } finally {
      setActivating(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-brand-600/20 p-3 text-brand-300"><KeyRound className="h-6 w-6" /></div>
          <div>
            <h1 className="text-2xl font-bold">Activate tengaPOS Desktop</h1>
            <p className="text-sm text-slate-400">A valid online-confirmed license is required before setup.</p>
          </div>
        </div>

        <div className={`mb-5 flex gap-3 rounded-xl border p-4 text-sm ${isOnline ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/20 bg-amber-500/10 text-amber-100'}`}>
          {isOnline ? <Wifi className="mt-0.5 h-5 w-5 flex-shrink-0" /> : <WifiOff className="mt-0.5 h-5 w-5 flex-shrink-0" />}
          <p>{isOnline
            ? 'Internet appears available. Activation will contact the tengaPOS license service. If it cannot be reached, check network and firewall access.'
            : 'No internet connection detected. First-time activation needs internet; this computer cannot be set up until its license is confirmed.'}</p>
        </div>

        {!apiConfigured && (
          <p className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            License activation is not available in this build because the licensing service and verification key have not been configured. Contact the tengaPOS administrator for a licensed desktop build.
          </p>
        )}
        {error && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</p>}

        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium">Single-use license code
            <input
              autoFocus
              required
              maxLength={200}
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck="false"
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30"
              placeholder="Enter the code from your tengaPOS account"
            />
          </label>
          <Button type="submit" disabled={activating || !isOnline || !apiConfigured} className="w-full justify-center py-3">
            {activating ? 'Verifying license…' : 'Verify and activate this device'}
          </Button>
        </form>
        <p className="mt-5 text-xs leading-relaxed text-slate-500">
          Activation binds this one-time code to this computer. After successful activation, local POS use continues while offline. When internet returns, the app checks in with tengaPOS. Sales data is not included in license check-ins.
        </p>
      </section>
    </main>
  )
}
