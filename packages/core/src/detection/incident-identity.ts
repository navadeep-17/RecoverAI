import { RiskType } from '@recoverai/shared';

export function generateIncidentKey(
  merchantId: string,
  riskType: RiskType,
  referenceId: string,
): string {
  const cleanRef = (referenceId || 'default').trim();
  return `${merchantId}:${riskType}:${cleanRef}`;
}
