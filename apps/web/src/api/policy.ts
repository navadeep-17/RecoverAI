import { getJson, requestJson } from './client';
import type { PolicyConfig } from '../types/policy';

export const getPolicy = () => getJson<{ policy: PolicyConfig }>('/policy');
export const updatePolicy = (patch: Partial<PolicyConfig>) => requestJson<{ policy: PolicyConfig }>('PATCH', '/policy', patch);
