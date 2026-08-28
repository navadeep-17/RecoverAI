export const RiskType = {
  PAYMENT_FAILURE: 'PAYMENT_FAILURE',
  SUBSCRIPTION_FAILURE: 'SUBSCRIPTION_FAILURE',
  CHECKOUT_ABANDONMENT: 'CHECKOUT_ABANDONMENT',
  OVERDUE_RECEIVABLE: 'OVERDUE_RECEIVABLE',
} as const;
export type RiskType = (typeof RiskType)[keyof typeof RiskType];

export const RecoveryFamily = {
  PAYMENT_SUBSCRIPTION: 'PAYMENT_SUBSCRIPTION',
  CHECKOUT: 'CHECKOUT',
  RECEIVABLES: 'RECEIVABLES',
} as const;
export type RecoveryFamily = (typeof RecoveryFamily)[keyof typeof RecoveryFamily];

export const CaseStatus = {
  OPEN: 'OPEN',
  WAITING: 'WAITING',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  RECOVERED: 'RECOVERED',
  STOPPED: 'STOPPED',
  EXHAUSTED: 'EXHAUSTED',
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export const PolicyDecision = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REVIEW: 'REVIEW',
} as const;
export type PolicyDecision = (typeof PolicyDecision)[keyof typeof PolicyDecision];

export const RecoveryActionType = {
  RETRY_PAYMENT: 'RETRY_PAYMENT',
  REQUEST_PAYMENT_UPDATE: 'REQUEST_PAYMENT_UPDATE',
  CREATE_OR_SEND_PAYMENT_LINK: 'CREATE_OR_SEND_PAYMENT_LINK',
  SEND_CHECKOUT_RECOVERY: 'SEND_CHECKOUT_RECOVERY',
  SEND_RECEIVABLE_REMINDER: 'SEND_RECEIVABLE_REMINDER',
  RECORD_PROMISE_TO_PAY: 'RECORD_PROMISE_TO_PAY',
  SCHEDULE_FOLLOWUP: 'SCHEDULE_FOLLOWUP',
  ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN',
  STOP_RECOVERY: 'STOP_RECOVERY',
} as const;
export type RecoveryActionType = (typeof RecoveryActionType)[keyof typeof RecoveryActionType];

export const ActionExecutionStatus = {
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type ActionExecutionStatus =
  (typeof ActionExecutionStatus)[keyof typeof ActionExecutionStatus];

export const MerchantEventSource = {
  RAZORPAY: 'RAZORPAY',
  MERCHANT: 'MERCHANT',
  SIMULATOR: 'SIMULATOR',
  TIMER: 'TIMER',
} as const;
export type MerchantEventSource =
  (typeof MerchantEventSource)[keyof typeof MerchantEventSource];

export const NormalizedEventType = {
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_METHOD_UPDATED: 'PAYMENT_METHOD_UPDATED',
  SUBSCRIPTION_RENEWAL_FAILED: 'SUBSCRIPTION_RENEWAL_FAILED',
  CHECKOUT_STARTED: 'CHECKOUT_STARTED',
  CHECKOUT_COMPLETED: 'CHECKOUT_COMPLETED',
  INVOICE_CREATED: 'INVOICE_CREATED',
  INVOICE_PAID: 'INVOICE_PAID',
  CUSTOMER_MESSAGE: 'CUSTOMER_MESSAGE',
  CUSTOMER_RESPONSE: 'CUSTOMER_RESPONSE',
  PROMISE_TO_PAY: 'PROMISE_TO_PAY',
  PROMISE_TO_PAY_BROKEN: 'PROMISE_TO_PAY_BROKEN',
  RECOVERY_TIMER_FIRED: 'RECOVERY_TIMER_FIRED',
  RECOVERY_TIMEOUT: 'RECOVERY_TIMEOUT',
} as const;
export type NormalizedEventType =
  (typeof NormalizedEventType)[keyof typeof NormalizedEventType];

export const AuditActorType = {
  SYSTEM: 'SYSTEM',
  AGENT: 'AGENT',
  POLICY: 'POLICY',
  HUMAN: 'HUMAN',
  PROVIDER: 'PROVIDER',
} as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

export const EventSource = MerchantEventSource;
export type EventSource = MerchantEventSource;
