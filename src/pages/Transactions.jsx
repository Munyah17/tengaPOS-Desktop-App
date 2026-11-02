import { motion } from 'framer-motion'
import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { withOfflineCache, seedFromOfflineCache } from '@/lib/offlineCache'
import { RefreshCw, X, Ban, CheckCircle, ShieldCheck, XCircle, Undo2, Wrench, Trash2, Loader2 } from 'lucide-react'
import ExportMenu from '@/components/common/ExportMenu'
import DateInput, { TimeField } from '@/components/common/DateInput'
import ValidateReturnModal from '@/components/common/ValidateReturnModal'
import { formatCurrency, formatDateTime, stripLeadingZero } from '@/utils/formatters'
import { combineDateAndTime } from '@/utils/dateRanges'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { useDayFilter } from '@/hooks/useDayFilter'
import {
  fetchTransactions, fetchVoids, requestVoid, approveVoid, validateVoid, rejectVoid,
  fetchReturns, requestReturn, approveReturn, validateReturn, rejectReturn, deleteOrder,
  clearVoidedTransactions,
} from '@/lib/dataLayer'
import { queueOfflineAction } from '@/lib/offlineSync'
import { isNetworkError } from '@/lib/authRetry'
import toast from 'react-hot-toast'

const VOID_BADGE = {
  requested: { label: 'Void: Pending', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' },
  approved:  { label: 'Void: Approved', bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  validated: { label: 'Voided', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  rejected:  { label: 'Void Rejected', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-500 dark:text-slate-400' },
}

const RETURN_BADGE = {
  requested: { label: 'Return: Pending', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' },
  approved:  { label: 'Return: Approved', bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  validated: { label: 'Refunded', bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  rejected:  { label: 'Return Rejected', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-500 dark:text-slate-400' },
}

function RequestVoidModal({ onClose, onSubmit }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-1 font-bold text-slate-900 dark:text-white">Request Void</h3>
        <p className="mb-3 text-xs text-slate-500">
          For a sale the customer refused, failed to pay, or couldn't complete. Requires Shop Manager/Supervisor approval and Vendor validation before stock is restored.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for voiding this sale…"
          rows={3}
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={async () => {
              if (!reason.trim()) { toast.error('A reason is required'); return }
              setBusy(true)
              await onSubmit(reason.trim())
              setBusy(false)
            }}
            disabled={busy}
            className="flex-1 rounded-xl bg-amber-600 py-2 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {busy ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RequestReturnModal({ maxAmount, onClose, onSubmit }) {
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState(maxAmount != null ? String(maxAmount) : '')
  const [busy, setBusy] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-1 font-bold text-slate-900 dark:text-white">Request Return / Refund</h3>
        <p className="mb-3 text-xs text-slate-500">
          For goods physically returned by the customer. Requires Shop Manager/Supervisor approval and Vendor validation before stock is restored and the refund is recorded.
        </p>
        <label className="mb-1 block text-xs font-semibold text-slate-500">Refund amount</label>
        <input
          type="number" min="0" step="0.01" max={maxAmount}
          value={amount}
          onChange={(e) => setAmount(stripLeadingZero(e.target.value))}
          className="mb-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <label className="mb-1 block text-xs font-semibold text-slate-500">Reason</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for the return…"
          rows={3}
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={async () => {
              if (!reason.trim()) { toast.error('A reason is required'); return }
              const amt = Number(amount)
              if (!amt || amt <= 0) { toast.error('Enter a valid refund amount'); return }
              setBusy(true)
              await onSubmit(reason.trim(), amt)
              setBusy(false)
            }}
            disabled={busy}
            className="flex-1 rounded-xl bg-purple-600 py-2 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-60"
          >
            {busy ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}

const exportColumns = [
  { header: 'Receipt #', key: 'id' },
  { header: 'Date', key: 'date' },
  { header: 'Cashier', key: 'cashier' },
  { header: 'Items', key: 'items' },
  { header: 'Subtotal', key: 'subtotal' },
  { header: 'Tax', key: 'tax' },
  { header: 'Total', key: 'total' },
  { header: 'Method', key: 'method' },
  { header: 'Branch', key: 'branch' },
]

export default function Transactions() {
  const isDesktop = window.tengaDesktop?.isDesktop === true
  const { tenant, role } = useAuthStore()
  const { posMode } = useThemeStore()
  const isWorkshop = posMode === 'workshop'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { dateFrom, dateTo, timeFrom, timeTo, setDateFrom, setDateTo, setTimeFrom, setTimeTo, resetToToday, isToday } = useDayFilter()
  const [clearingVoided, setClearingVoided] = useState(false)
  const [voidTarget, setVoidTarget] = useState(null) // order_id currently requesting a void
  const [returnTarget, setReturnTarget] = useState(null) // { orderId, maxAmount } currently requesting a return
  const [validatingReturnId, setValidatingReturnId] = useState(null) // return id awaiting the goods-condition confirmation
  const [deletingId, setDeletingId] = useState(null)

  const canApprove = !isDesktop && ['shop_manager', 'supervisor', 'vendor'].includes(role)
  const canValidate = !isDesktop && role === 'vendor'

  useEffect(() => {
    if (!tenant?.id) return
    seedFromOfflineCache(queryClient, ['transactions', tenant.id])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id])

  const transactionsQuery = useQuery({
    queryKey: ['transactions', tenant?.id],
    queryFn: withOfflineCache(['transactions', tenant?.id], async () => {
      const rows = await fetchTransactions(tenant.id)
      return rows.map(t => ({
        id: t.reference || t.id,
        orderId: t.order_id,
        date: t.created_at,
        cashier: t.users?.name || '—',
        items: t.orders?.order_items?.reduce((s, i) => s + i.qty, 0) ?? '—',
        lineItems: t.orders?.order_items || [],
        subtotal: t.orders?.subtotal ?? t.amount,
        tax: t.orders?.tax_amount ?? 0,
        total: parseFloat(t.amount),
        method: t.method,
        branch: t.branches?.name || '—',
      }))
    }),
    enabled: !!tenant?.id,
    staleTime: 30000,
  })
  const allTransactions = transactionsQuery.data || []
  const loading = transactionsQuery.isLoading
  const load = () => transactionsQuery.refetch()

  const voidsQuery = useQuery({
    queryKey: ['voids', tenant?.id],
    queryFn: () => fetchVoids(tenant.id),
    enabled: !!tenant?.id,
    staleTime: 15000,
  })
  const voidByOrder = useMemo(() => {
    const map = {}
    for (const v of voidsQuery.data || []) {
      // Keep the most recent void per order (created_at descending from the query)
      if (!map[v.order_id]) map[v.order_id] = v
    }
    return map
  }, [voidsQuery.data])

  const refreshVoids = () => queryClient.invalidateQueries({ queryKey: ['voids', tenant.id] })

  const submitVoidRequest = async (reason) => {
    try {
      await requestVoid(voidTarget, reason)
      toast.success('Void requested — awaiting approval')
      setVoidTarget(null)
      refreshVoids()
    } catch (err) {
      // Only the REQUEST step queues offline -- approve/validate stay
      // online-only, on purpose (a manager approving a reversal from a
      // queued, unattended replay is exactly the kind of loophole this
      // app's approval tiers exist to close, not something to automate).
      if (isNetworkError(err)) {
        await queueOfflineAction('void_request', { orderId: voidTarget, reason })
        toast('Offline — void request saved, will submit automatically', { icon: '📴' })
        setVoidTarget(null)
      } else {
        toast.error(err.message || 'Failed to request void')
      }
    }
  }

  const handleApprove = async (voidId) => {
    try {
      await approveVoid(voidId)
      toast.success('Void approved — awaiting Vendor validation')
      refreshVoids()
    } catch (err) {
      toast.error(err.message || 'Failed to approve void')
    }
  }

  const handleValidate = async (voidId) => {
    try {
      await validateVoid(voidId)
      toast.success('Void validated — stock restored')
      refreshVoids()
      transactionsQuery.refetch()
    } catch (err) {
      toast.error(err.message || 'Failed to validate void')
    }
  }

  const handleReject = async (voidId) => {
    try {
      await rejectVoid(voidId, 'Rejected')
      toast.success('Void rejected')
      refreshVoids()
    } catch (err) {
      toast.error(err.message || 'Failed to reject void')
    }
  }

  const returnsQuery = useQuery({
    queryKey: ['returns', tenant?.id],
    queryFn: () => fetchReturns(tenant.id),
    enabled: !!tenant?.id,
    staleTime: 15000,
  })
  const returnByOrder = useMemo(() => {
    const map = {}
    for (const r of returnsQuery.data || []) {
      if (!map[r.order_id]) map[r.order_id] = r
    }
    return map
  }, [returnsQuery.data])

  const refreshReturns = () => queryClient.invalidateQueries({ queryKey: ['returns', tenant.id] })

  const submitReturnRequest = async (reason, amount) => {
    try {
      await requestReturn(returnTarget.orderId, reason, amount)
      toast.success('Return requested — awaiting approval')
      setReturnTarget(null)
      refreshReturns()
    } catch (err) {
      if (isNetworkError(err)) {
        await queueOfflineAction('return_request', { orderId: returnTarget.orderId, reason, refundAmount: amount })
        toast('Offline — return request saved, will submit automatically', { icon: '📴' })
        setReturnTarget(null)
      } else {
        toast.error(err.message || 'Failed to request return')
      }
    }
  }

  const handleApproveReturn = async (returnId) => {
    try {
      await approveReturn(returnId)
      toast.success('Return approved — awaiting Vendor validation')
      refreshReturns()
    } catch (err) {
      toast.error(err.message || 'Failed to approve return')
    }
  }

  const handleValidateReturn = async (goodsCondition, notes) => {
    try {
      await validateReturn(validatingReturnId, goodsCondition, notes)
      setValidatingReturnId(null)
      toast.success(
        goodsCondition === 'sellable'
          ? 'Return validated — stock restored, refund recorded'
          : 'Return validated — refund recorded, stock left unchanged'
      )
      refreshReturns()
      transactionsQuery.refetch()
    } catch (err) {
      toast.error(err.message || 'Failed to validate return')
    }
  }

  const handleRejectReturn = async (returnId) => {
    try {
      await rejectReturn(returnId, 'Rejected')
      toast.success('Return rejected')
      refreshReturns()
    } catch (err) {
      toast.error(err.message || 'Failed to reject return')
    }
  }

  const handleDeleteTransaction = async (t) => {
    if (!t.orderId) { toast.error('Unavailable for this record'); return }
    if (!window.confirm(`Delete transaction ${t.id}? This can't be undone.`)) return
    setDeletingId(t.orderId)
    try {
      await deleteOrder(t.orderId)
      queryClient.setQueryData(['transactions', tenant?.id], (prev) => (prev || []).filter((x) => x.orderId !== t.orderId))
      toast.success('Transaction deleted')
    } catch (err) {
      toast.error(err.message || 'Failed to delete transaction')
    } finally {
      setDeletingId(null)
    }
  }

  const transactions = useMemo(() => {
    if (!dateFrom && !dateTo) return allTransactions
    return allTransactions.filter(t => {
      const d = new Date(t.date)
      if (dateFrom && d < combineDateAndTime(dateFrom, timeFrom, '00:00', 0)) return false
      if (dateTo && d > combineDateAndTime(dateTo, timeTo, '23:59', 59.999)) return false
      return true
    })
  }, [allTransactions, dateFrom, dateTo, timeFrom, timeTo])

  const dateFiltered = dateFrom || dateTo
  const transactionsTotal = useMemo(() => transactions.reduce((s, t) => s + t.total, 0), [transactions])

  // A void only actually reverses the sale once the Vendor gives final
  // validation (see validate_void) -- 'requested'/'approved' are still
  // pending, so only 'validated' counts as voided here.
  const isVoided = (t) => t.orderId && voidByOrder[t.orderId]?.status === 'validated'
  const voidedStats = useMemo(() => {
    const voided = transactions.filter(isVoided)
    return { count: voided.length, total: voided.reduce((s, t) => s + t.total, 0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, voidByOrder])

  const handleClearVoided = async () => {
    if (!window.confirm(`Archive ${voidedStats.count} voided transaction(s)? They'll be removed from this list but not deleted -- the void record itself (who requested/approved/validated it) is kept permanently.`)) return
    setClearingVoided(true)
    try {
      const count = await clearVoidedTransactions()
      toast.success(`${count} voided transaction(s) cleared`)
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to clear voided transactions')
    } finally {
      setClearingVoided(false)
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white">Transactions</h1>
          <p className="text-sm text-slate-500">Detailed transaction history</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <DateInput value={dateFrom} onChange={e => setDateFrom(e.target.value)} placeholder="From" className="w-36" />
            <TimeField value={timeFrom} onChange={e => setTimeFrom(e.target.value)} />
            <span className="text-xs text-slate-400">—</span>
            <DateInput value={dateTo} onChange={e => setDateTo(e.target.value)} placeholder="To" className="w-36" />
            <TimeField value={timeTo} onChange={e => setTimeTo(e.target.value)} />
            {!isToday && (
              <button onClick={resetToToday} title="Back to today" className="text-slate-400 hover:text-red-500">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <ExportMenu data={transactions} columns={exportColumns} title={`Transactions${dateFiltered ? ` (${dateFrom || '…'} to ${dateTo || '…'})` : ''}`} filename="tengapos_transactions" />
        </div>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        {isToday ? "Today's transactions" : 'Showing transactions for selected date range'}
        {' — '}{transactions.length} transaction{transactions.length !== 1 ? 's' : ''} · Total {formatCurrency(transactionsTotal)}
      </p>

      {voidedStats.count > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400">
            <Ban className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-red-700 dark:text-red-400">Voided Transactions{dateFiltered ? ' (selected range)' : ''}</p>
            <p className="text-lg font-extrabold text-red-800 dark:text-red-300">
              {voidedStats.count} · {formatCurrency(voidedStats.total)}
            </p>
          </div>
          {!isDesktop && role === 'vendor' && (
            <button
              onClick={handleClearVoided}
              disabled={clearingVoided}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-xl border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/40"
              title="Archive voided transactions out of this list (kept in the void record, not deleted)"
            >
              {clearingVoided ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Clear Voided
            </button>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                {['Receipt #', 'Date', 'Cashier', 'Items', 'Subtotal', 'Tax', 'Total', 'Payment', 'Branch', 'Void / Return', '', ...(isWorkshop ? [''] : [])].map((h, idx) => (
                  <th key={idx} className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={isWorkshop ? 12 : 11} className="py-16 text-center text-sm text-slate-400">
                    No transactions yet — complete a sale on the POS to see it here.
                  </td>
                </tr>
              ) : transactions.map((t) => (
                <motion.tr
                  key={t.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`border-b transition-colors ${
                    isVoided(t)
                      ? 'border-red-100 bg-red-50 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/20 dark:hover:bg-red-950/30'
                      : 'border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <td className="px-4 py-3 font-mono text-sm font-medium text-slate-900 dark:text-white">{t.id}</td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{formatDateTime(t.date)}</td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{t.cashier}</td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{t.items}</td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{formatCurrency(t.subtotal)}</td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{formatCurrency(t.tax)}</td>
                  <td className="px-4 py-3 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(t.total)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {t.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400">{t.branch}</td>
                  <td className="px-4 py-3">
                    {(() => {
                      const v = t.orderId ? voidByOrder[t.orderId] : null
                      const r = t.orderId ? returnByOrder[t.orderId] : null

                      if (!v && !r) {
                        if (isDesktop) return <span className="text-xs text-slate-400">—</span>
                        return (
                          <div className="flex gap-1">
                            <button
                              onClick={() => setVoidTarget(t.orderId)}
                              disabled={!t.orderId}
                              title={!t.orderId ? 'Unavailable for this record' : 'Request void'}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/30"
                            >
                              <Ban className="h-3.5 w-3.5" />
                              Void
                            </button>
                            <button
                              onClick={() => setReturnTarget({ orderId: t.orderId, maxAmount: t.total })}
                              disabled={!t.orderId}
                              title={!t.orderId ? 'Unavailable for this record' : 'Request return/refund'}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-purple-50 hover:text-purple-600 disabled:opacity-40 dark:hover:bg-purple-950/30"
                            >
                              <Undo2 className="h-3.5 w-3.5" />
                              Return
                            </button>
                          </div>
                        )
                      }

                      // Void takes the row if both somehow exist (shouldn't in practice)
                      const item = v || r
                      const isVoid = !!v
                      const badge = isVoid ? VOID_BADGE[item.status] : RETURN_BADGE[item.status]
                      const onApprove = isVoid ? handleApprove : handleApproveReturn
                      // A return's validate opens the goods-condition modal
                      // (validate_return now requires it) instead of firing
                      // straight away like a void's does.
                      const onValidate = isVoid ? handleValidate : () => setValidatingReturnId(item.id)
                      const onReject = isVoid ? handleReject : handleRejectReturn

                      return (
                        <div className="flex flex-col items-start gap-1">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.bg} ${badge.text}`}>
                            {badge.label}
                          </span>
                          <div className="flex gap-1">
                            {item.status === 'requested' && canApprove && (
                              <>
                                <button onClick={() => onApprove(item.id)} title="Approve" className="rounded p-1 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30">
                                  <CheckCircle className="h-3.5 w-3.5" />
                                </button>
                                <button onClick={() => onReject(item.id)} title="Reject" className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                            {item.status === 'approved' && canValidate && (
                              <>
                                <button onClick={() => onValidate(item.id)} title="Validate (restores stock)" className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30">
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                </button>
                                <button onClick={() => onReject(item.id)} title="Reject" className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    {!isDesktop && role === 'vendor' && (
                      <button
                        onClick={() => handleDeleteTransaction(t)}
                        disabled={deletingId === t.orderId}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50 dark:hover:bg-red-950/40"
                        title="Delete transaction"
                      >
                        {deletingId === t.orderId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    )}
                  </td>
                  {isWorkshop && (
                    <td className="px-4 py-3">
                      <button
                        onClick={() => navigate('/app/job-cards', { state: { fromTransaction: { items: t.lineItems, orderId: t.orderId } } })}
                        disabled={!t.lineItems.length}
                        title={!t.lineItems.length ? 'No items to carry over' : 'Create a job card from this sale'}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/30"
                      >
                        <Wrench className="h-3.5 w-3.5" />
                        Job Card
                      </button>
                    </td>
                  )}
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {voidTarget && (
        <RequestVoidModal onClose={() => setVoidTarget(null)} onSubmit={submitVoidRequest} />
      )}
      {returnTarget && (
        <RequestReturnModal
          maxAmount={returnTarget.maxAmount}
          onClose={() => setReturnTarget(null)}
          onSubmit={submitReturnRequest}
        />
      )}
      {validatingReturnId && (
        <ValidateReturnModal onClose={() => setValidatingReturnId(null)} onSubmit={handleValidateReturn} />
      )}
    </div>
  )
}
