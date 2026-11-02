import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Store, ShieldCheck } from 'lucide-react'
import Button from '@/components/common/Button'
import { createLocalInstallation } from '@/lib/localAuth'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

export default function DesktopSetup() {
  const navigate = useNavigate()
  const signIn = useAuthStore((state) => state.signIn)
  const [form, setForm] = useState({ shopName: '', ownerName: '', username: '', password: '', confirmPassword: '' })
  const [saving, setSaving] = useState(false)

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (form.password.length < 10) return toast.error('Use a password with at least 10 characters')
    if (form.password !== form.confirmPassword) return toast.error('Passwords do not match')
    setSaving(true)
    try {
      await createLocalInstallation(form)
      await signIn(form.username, form.password)
      toast.success('This computer is set up for offline use')
      navigate('/app/pos', { replace: true })
    } catch (error) {
      toast.error(error.message || 'Could not set up this computer')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-white outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30'

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-brand-600/20 p-3 text-brand-300"><Store className="h-6 w-6" /></div>
          <div>
            <h1 className="text-2xl font-bold">Set up this computer</h1>
            <p className="text-sm text-slate-400">No internet connection is required.</p>
          </div>
        </div>
        <div className="mb-6 flex gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p>Shop data and sales will be saved on this computer. Add your products after setup and back up this computer regularly.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium">Shop name
            <input autoFocus required maxLength={100} value={form.shopName} onChange={update('shopName')} className={inputClass} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">Owner name
            <input required maxLength={100} value={form.ownerName} onChange={update('ownerName')} className={inputClass} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">Username
            <input required minLength={3} maxLength={40} autoCapitalize="none" autoCorrect="off" value={form.username} onChange={update('username')} className={inputClass} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">Password
            <input required type="password" minLength={10} autoComplete="new-password" value={form.password} onChange={update('password')} className={inputClass} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">Confirm password
            <input required type="password" minLength={10} autoComplete="new-password" value={form.confirmPassword} onChange={update('confirmPassword')} className={inputClass} />
          </label>
          <Button type="submit" disabled={saving} className="w-full justify-center py-3">
            {saving ? 'Setting up…' : 'Set up offline POS'}
          </Button>
        </form>
      </section>
    </main>
  )
}
