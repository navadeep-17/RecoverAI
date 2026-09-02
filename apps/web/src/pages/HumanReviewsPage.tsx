import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { approveReview, closeReview, getReview, listReviews, rejectReview, takeOverReview } from '../api/reviews';
import { ApiError } from '../api/client';
import { ErrorState, EmptyState, LoadingState } from '../components/ui/State';
import { formatDate, formatMoney, riskLabel } from '../lib/format';
import type { Review } from '../types/reviews';

export function HumanReviewsPage({ reviewId, navigate }: { reviewId?: string; navigate: (path: string) => void }) {
  const [status, setStatus] = useState('PENDING');
  const query = useQuery({ queryKey: ['reviews', status], queryFn: () => listReviews(status) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} retry={() => query.refetch()} />;
  if (reviewId) return <ReviewWorkspace reviewId={reviewId} navigate={navigate} />;
  return <div className="space-y-6"><div><p className="eyebrow">HUMAN REVIEW</p><h1 className="page-title">Policy-governed review inbox</h1><p className="page-copy">AI proposes. Deterministic policy requires human intervention only when needed.</p></div><label>Review status <select value={status} onChange={e => setStatus(e.target.value)} className="input">{['PENDING', 'APPROVED', 'REJECTED', 'TAKEN_OVER', 'CLOSED'].map(x => <option key={x}>{x}</option>)}</select></label>{query.data.reviews.length === 0 ? <EmptyState title="No pending human reviews" detail="Policy-routed work will appear here when operator intervention is required." /> : <div className="space-y-3">{query.data.reviews.map((review) => <button key={review.id} onClick={() => navigate(`/reviews/${review.id}`)} className="card block w-full text-left focus-visible:ring-2"><div className="flex justify-between gap-4"><div><p className="font-semibold">{review.caseId}</p><p className="text-sm text-slate-600">{review.case?.customer?.name || review.case?.customer?.email || 'Customer unavailable'} · {riskLabel(review.case?.riskType || 'PAYMENT_FAILURE')}</p><p className="mt-2 text-sm">{review.reasonForReview}</p></div><div className="text-right text-sm"><b>{review.status}</b><p>{formatMoney(review.case?.amountAtRisk, review.case?.currency)}</p><p className="text-slate-500">{formatDate(review.createdAt)}</p></div></div></button>)}</div>}</div>;
}

function ReviewWorkspace({ reviewId, navigate }: { reviewId: string; navigate: (path: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['review', reviewId], queryFn: () => getReview(reviewId) });
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: (x: 'approve' | 'reject' | 'takeover' | 'close-only' | 'close-stop') => x === 'approve' ? approveReview(reviewId, notes) : x === 'reject' ? rejectReview(reviewId, reason, notes) : x === 'takeover' ? takeOverReview(reviewId, notes) : closeReview(reviewId, reason, x === 'close-stop', notes), onSuccess: () => { for (const k of [['reviews'], ['review', reviewId], ['cases'], ['case', q.data?.review.caseId], ['revenue-radar-metrics']] as const) void qc.invalidateQueries({ queryKey: k }); } });
  if (q.isPending) return <LoadingState />;
  if (q.isError) return <ErrorState message={q.error.message} retry={() => q.refetch()} />;
  const r: Review = q.data.review;
  const proposedAction = r.planVersion?.proposedActionType || r.action?.actionType || 'Not available';
  const confidence = r.planVersion?.confidence;
  const currentPolicy = r.revalidatedPolicyDecision || r.action?.policyRationale || 'Not available';
  let error = m.error?.message;
  if (m.error instanceof ApiError) {
    const data = m.error.data as any;
    if (m.error.status === 409) error = String(data?.error).includes('Stale') ? 'Proposal is stale. Refresh the case before taking action.' : 'This review was already resolved or changed by another operator.';
    else if (m.error.status === 422) error = data?.requiresReview ? 'Fresh policy still requires human review.' : 'Approval was blocked by fresh policy revalidation.';
    else if (m.error.status === 403) error = 'Reviewer permission error.';
  }
  return <div className="space-y-5"><button onClick={() => navigate('/reviews')}>Back to inbox</button><section className="card"><p className="eyebrow">HUMAN APPROVAL REQUIRED BY POLICY</p><h1 className="page-title">Review {r.id}</h1><p>AI proposed this action. Deterministic policy required human review. Approval authorizes this exact proposal only. Fresh policy and case-state checks run before execution.</p><button onClick={() => navigate(`/recoveries/${r.caseId}`)}>View full case</button></section><section className="card"><p className="eyebrow">WHY REVIEW IS REQUIRED</p><h2 className="font-semibold text-slate-950">Case and proposal</h2><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Fact label="Amount at risk" value={formatMoney(r.case?.amountAtRisk, r.case?.currency)} /><Fact label="Risk type" value={riskLabel(r.case?.riskType || 'PAYMENT_FAILURE')} /><Fact label="Proposed action" value={proposedAction.replaceAll('_', ' ')} /><Fact label="AI confidence" value={confidence === undefined ? 'Not available' : `${Math.round(confidence * 100)}%`} /><Fact label="Reason review required" value={r.reasonForReview || 'Not available'} /><Fact label="Customer consent" value={consentLabel(r.case?.customer?.contactConsent)} /><Fact label="Customer opt-out" value={r.case?.customer?.optedOut ? 'Yes' : 'No'} /><Fact label="Current policy state" value={currentPolicy} /></div><div className="mt-5 rounded-md bg-slate-50 p-4 text-sm text-slate-700"><p className="font-semibold text-slate-950">Approval safety</p><ul className="mt-2 list-disc space-y-1 pl-5"><li>Approval authorizes this exact proposal only.</li><li>Fresh policy is revalidated before execution.</li><li>Human approval cannot override a hard DENY.</li></ul></div><div className="mt-5"><p className="text-sm font-medium text-slate-800">Policy/review rationale</p><p className="mt-1 text-sm text-slate-600">{r.action?.policyRationale || 'No separate persisted policy rationale.'}</p><p className="mt-4 text-sm font-medium text-slate-800">Persisted proposal parameters</p><pre className="mt-1 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(r.planVersion?.proposedActionParams || r.action?.actionParams || {}, null, 2)}</pre></div></section><section className="card"><label>Notes<textarea className="input w-full" value={notes} onChange={e => setNotes(e.target.value)} /></label><label>Reason<textarea className="input w-full" value={reason} onChange={e => setReason(e.target.value)} /></label><div className="mt-3 flex flex-wrap gap-2"><button disabled={m.isPending} onClick={() => m.mutate('approve')}>Approve exact proposal</button><button disabled={m.isPending || !reason.trim()} onClick={() => m.mutate('reject')}>Reject</button><button disabled={m.isPending} onClick={() => m.mutate('takeover')}>Take over</button><button disabled={m.isPending || !reason.trim()} onClick={() => m.mutate('close-only')}>Close review only</button><button disabled={m.isPending || !reason.trim()} onClick={() => m.mutate('close-stop')}>Close and stop recovery</button></div><p>Recovery may resume only if no other active human gate remains. Autonomous recovery is paused for this human gate after takeover.</p>{m.isError && <p role="alert">{error}</p>}</section></div>;
}

function consentLabel(value: boolean | null | undefined) { return value === true ? 'Granted' : value === false ? 'Denied' : 'Unknown'; }
function Fact({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 font-semibold text-slate-950">{value}</p></div>; }
