import { getJson, requestJson } from './client';
import type { Review } from '../types/reviews';
export const listReviews = (status?: string) => getJson<{ reviews: Review[] }>(`/reviews${status ? `?status=${status}` : ''}`);
export const getReview = (id: string) => getJson<{ review: Review }>(`/reviews/${encodeURIComponent(id)}`);
export const approveReview = (id: string, notes?: string) => requestJson<unknown>('POST', `/reviews/${id}/approve`, { notes });
export const rejectReview = (id: string, reason: string, notes?: string) => requestJson<unknown>('POST', `/reviews/${id}/reject`, { reason, notes });
export const takeOverReview = (id: string, notes?: string) => requestJson<unknown>('POST', `/reviews/${id}/take-over`, { notes });
export const closeReview = (id: string, reason: string, stopCase: boolean, notes?: string) => requestJson<unknown>('POST', `/reviews/${id}/close`, { reason, stopCase, notes });
