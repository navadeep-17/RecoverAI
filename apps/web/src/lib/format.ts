import type { CaseStatus, RiskType } from '../types/cases';
export const riskLabel = (risk: RiskType) => ({ PAYMENT_FAILURE: 'Payment failure', SUBSCRIPTION_FAILURE: 'Subscription failure', CHECKOUT_ABANDONMENT: 'Checkout abandonment', OVERDUE_RECEIVABLE: 'Overdue receivable' }[risk]);
export const statusLabel = (status: CaseStatus) => status.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
export function formatMoney(amount: string | null | undefined, currency = 'INR') { if (!amount) return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(0); return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount)); }
export const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
