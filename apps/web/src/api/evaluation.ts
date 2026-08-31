import { getJson } from './client';
import type { EvaluationSnapshot } from '../types/evaluation';
export const getEvaluation = () => getJson<EvaluationSnapshot>('/evaluation');
