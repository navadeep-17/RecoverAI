import { getJson } from './client';
import type { CaseDetailResponse, CaseStatus, RecoveryCase, RevenueRadarMetrics, RiskType } from '../types/cases';

export function listCases(filters: { status?: CaseStatus; riskType?: RiskType } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.riskType) params.set('riskType', filters.riskType);
  const query = params.toString();
  return getJson<{ cases: RecoveryCase[] }>(`/cases${query ? `?${query}` : ''}`);
}
export function getCase(caseId: string) { return getJson<CaseDetailResponse>(`/cases/${encodeURIComponent(caseId)}`); }
export function getRevenueRadarMetrics() { return getJson<RevenueRadarMetrics>('/cases/metrics'); }
