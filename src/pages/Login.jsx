import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Eye, EyeOff, LogIn, ArrowLeft, Mail } from 'lucide-react'
import posIcon from '@/assets/pos-icon.png'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'

export default function Login() {
  const isDesktop = window.tengaDesktop?.isDesktop === true
  const [email, setEmail] = useState('')
  const [usernameEmail, setUsernameEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [resetMode, setResetMode] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const navigate = useNavigate()
  const { signIn, clearAuth } = useAuthStore()

  const handleResetPassword = async (e) => {
    e.preventDefault()
    if (!resetEmail.trim()) { toast.error('Enter your email address'); return }
    setResetLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
        redirectTo: `${window.location.origin}/login`,
      })
      if (error) throw error
      setResetSent(true)
    } catch (err) {
      toast.error(err.message || 'Failed to send reset email')
    } finally {
      setResetLoading(false)
    }
  }

  const isUsernameMode = !isDesktop && email.trim() && !email.includes('@')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email || !password) { toast.error('Please enter your email/username and password'); return }
    if (isUsernameMode && !usernameEmail) { toast.error('Enter the email address linked to that username'); return }
    setLoading(true)
    try {
      const userType = await signIn(email, password, isUsernameMode ? usernameEmail : undefined)
      // This page signs in client businesses only — platform staff have
      // their own portals and are dropped straight back out here.
      if (userType === 'app_owner') {
        await clearAuth()
        throw new Error('This sign-in is for client businesses. Staff must use their designated portal.')
      }
      toast.success('Welcome back!')
      const store = useAuthStore.getState()
      const status = store.tenantStatus
      navigate(isDesktop ? '/app/pos' : status === 'pending' || status === 'suspended' ? '/pending' : '/app/dashboard')
    } catch (err) {
      toast.error(err.message || 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-x-hidden overflow-y-auto bg-gradient-to-br from-slate-950 via-slate-900 to-[#040c1a] px-4 py-12"
      style={{ minHeight: '100dvh' }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(rgba(59,130,246,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
      <div className="absolute left-1/2 top-1/3 h-[400px] w-[400px] -translate-x-1/2 rounded-full bg-brand-600/10 blur-[128px]" />

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="relative w-full max-w-md"
      >
        <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-xl">
          {/* Back to home */}
          {!isDesktop && (
            <Link
              to="/"
              className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to home
            </Link>
          )}

          {/* Logo */}
          <div className="mb-8 text-center">
            <img src={posIcon} alt="tengaPOS" className="mx-auto mb-4 h-14 w-auto" />
            <h1 className="text-2xl font-extrabold text-white">{resetMode ? 'Reset Password' : 'Welcome back'}</h1>
            <p className="mt-1 text-sm text-slate-400">{resetMode ? 'Enter your email to receive a reset link' : 'Sign in to your tengaPOS account'}</p>
          </div>

          {/* Password Reset Form */}
          {resetMode ? (
            resetSent ? (
              <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-5 text-center">
                <Mail className="mx-auto mb-3 h-8 w-8 text-green-400" />
                <p className="font-semibold text-white">Check your inbox</p>
                <p className="mt-1 text-sm text-slate-400">A password reset link was sent to <strong className="text-white">{resetEmail}</strong></p>
                <button onClick={() => { setResetMode(false); setResetSent(false) }} className="mt-4 text-sm text-brand-400 hover:text-brand-300">
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300">Email address</label>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="you@example.com"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={resetLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                >
                  {resetLoading ? 'Sending…' : 'Send Reset Link'}
                </button>
                <button type="button" onClick={() => setResetMode(false)} className="w-full text-center text-sm text-slate-400 hover:text-white">
                  Back to sign in
                </button>
              </form>
            )
          ) : (

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">{isDesktop ? 'Username' : 'Email or Username'}</label>
              <input
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder={isDesktop ? 'username' : 'you@example.com or username'}
              />
            </div>

            {/* Usernames are only unique within a business now, so a bare
                username can't identify a single account by itself — the
                linked email confirms exactly which one. */}
            {isUsernameMode && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-300">Email linked to this username</label>
                <input
                  type="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={usernameEmail}
                  onChange={(e) => setUsernameEmail(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="you@example.com"
                />
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {!isDesktop && <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input type="checkbox" className="rounded border-slate-600" />
                Remember me
              </label>
              <button type="button" onClick={() => { setResetMode(true); setResetEmail(email) }} className="text-sm text-brand-400 hover:text-brand-300">
                Forgot password?
              </button>
            </div>}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" />
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
          )} {/* end !resetMode */}

          {!isDesktop && <p className="mt-6 text-center text-sm text-slate-400">
            {"Don't have an account? "}
            <Link to="/register" className="font-medium text-brand-400 hover:text-brand-300">
              Get started
            </Link>
          </p>}
        </div>
      </motion.div>
    </div>
  )
}
