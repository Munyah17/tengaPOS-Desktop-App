import * as realDb from '@/lib/db'
import * as demoDb from '@/lib/demoDb'
import * as localDb from '@/lib/localDb'
import { isDemoRoute } from '@/lib/demoMode'

// Single indirection point the 7 core-flow pages (Dashboard, POS, Inventory,
// Orders, Transactions, Reports, Staff) import from instead of '@/lib/db'
// directly. Everywhere else in the app is untouched -- only these pages are
// reachable from /demo, so this is the only place that needs to branch.
//
// Checked per-call (not cached at module-eval time): the same page module
// stays mounted across a client login -> logout -> /demo visit in one tab
// (SPA, no reload), so a stale "is this demo" flag captured once at import
// time would leak real writes into demo state or vice versa.
export { isDemoRoute }

function pick(name) {
  return (...args) => {
    if (isDemoRoute()) return demoDb[name](...args)
    if (window.tengaDesktop?.isDesktop) {
      const localOperation = localDb[name]
      if (localOperation) return localOperation(...args)
      return Promise.reject(new Error(`${name} is not available in standalone offline mode`))
    }
    return realDb[name](...args)
  }
}

export const fetchProducts = pick('fetchProducts')
export const insertProduct = pick('insertProduct')
export const bulkInsertProducts = pick('bulkInsertProducts')
export const updateProduct = pick('updateProduct')
export const deleteProduct = pick('deleteProduct')
export const uploadProductImage = pick('uploadProductImage')
export const fetchCategories = pick('fetchCategories')
export const createCategory = pick('createCategory')
export const sendReceiptViaWhatsApp = pick('sendReceiptViaWhatsApp')
export const saveCheckout = pick('saveCheckout')
export const fetchOrders = pick('fetchOrders')
export const deleteOrder = pick('deleteOrder')
export const fetchTransactions = pick('fetchTransactions')
export const fetchTransactionsInRange = pick('fetchTransactionsInRange')
export const clearVoidedTransactions = pick('clearVoidedTransactions')
export const fetchVoids = pick('fetchVoids')
export const requestVoid = pick('requestVoid')
export const approveVoid = pick('approveVoid')
export const validateVoid = pick('validateVoid')
export const rejectVoid = pick('rejectVoid')
export const fetchReturns = pick('fetchReturns')
export const requestReturn = pick('requestReturn')
export const approveReturn = pick('approveReturn')
export const validateReturn = pick('validateReturn')
export const rejectReturn = pick('rejectReturn')
export const fetchStaff = pick('fetchStaff')
export const updateStaffStatus = pick('updateStaffStatus')
export const updateStaffUsername = pick('updateStaffUsername')
export const updateStaffEmployeeNo = pick('updateStaffEmployeeNo')
export const updateStaffName = pick('updateStaffName')
export const updateStaffJobTitle = pick('updateStaffJobTitle')
export const fetchUserBranches = pick('fetchUserBranches')
export const assignUserBranch = pick('assignUserBranch')
export const unassignUserBranch = pick('unassignUserBranch')
export const fetchProductBranches = pick('fetchProductBranches')
export const assignProductBranch = pick('assignProductBranch')
export const unassignProductBranch = pick('unassignProductBranch')
export const fetchBranches = pick('fetchBranches')
export const fetchStockTransfers = pick('fetchStockTransfers')
export const transferStock = pick('transferStock')
export const fetchStockReceipts = pick('fetchStockReceipts')
export const receiveStock = pick('receiveStock')
export const adjustStock = pick('adjustStock')
export const fetchStockAdjustments = pick('fetchStockAdjustments')
export const fetchJobCards = pick('fetchJobCards')
export const completeJobCard = pick('completeJobCard')
export const recordPrescriptionDispense = pick('recordPrescriptionDispense')
export const recordAgeVerification = pick('recordAgeVerification')
export const fetchVendorRequests = pick('fetchVendorRequests')
export const fetchDashboardMetrics = pick('fetchDashboardMetrics')
export const fetchMyDashboardMetrics = pick('fetchMyDashboardMetrics')
export const fetchReportMetrics = pick('fetchReportMetrics')
export const fetchVendorNudges = pick('fetchVendorNudges')
