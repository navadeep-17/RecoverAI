import { RecoveryActionType } from '@recoverai/shared';

export enum ProviderExecutionOutcome {
  SUCCESS = 'SUCCESS',
  RETRYABLE_FAILURE = 'RETRYABLE_FAILURE',
  PERMANENT_FAILURE = 'PERMANENT_FAILURE',
}

export type ProviderErrorClassification =
  | 'NETWORK_TIMEOUT'
  | 'RATE_LIMIT'
  | 'AUTH_ERROR'
  | 'INVALID_REQUEST'
  | 'PROVIDER_ERROR'
  | 'UNSUPPORTED';

export interface ProviderActionCustomer {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  externalCustomerId?: string;
}

export interface ProviderActionCaseSummary {
  riskType: string;
  amountAtRisk: string;
  currency: string;
}

export interface ProviderActionInput {
  merchantId: string;
  caseId: string;
  actionId: string;
  actionType: RecoveryActionType;
  idempotencyKey: string;
  actionParams: Record<string, unknown>;
  customer?: ProviderActionCustomer;
  caseSummary?: ProviderActionCaseSummary;
}

export interface ProviderActionResult {
  providerName: string;
  isSimulated: boolean;
  outcome: ProviderExecutionOutcome;
  idempotencyKey: string;
  externalActionId?: string;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  errorClassification?: ProviderErrorClassification;
}

export interface IActionProvider {
  readonly providerName: string;
  readonly isSimulated: boolean;

  /**
   * Determines if this provider supports executing the given action type.
   */
  supports(actionType: RecoveryActionType): boolean;

  /**
   * Executes the side-effect action against the external system or simulator.
   */
  execute(input: ProviderActionInput): Promise<ProviderActionResult>;
}

export class ProviderRegistry {
  private providers: IActionProvider[] = [];

  constructor(initialProviders?: IActionProvider[]) {
    if (initialProviders && initialProviders.length > 0) {
      this.providers.push(...initialProviders);
    }
  }

  registerProvider(provider: IActionProvider): void {
    this.providers.unshift(provider);
  }

  getProviderForAction(actionType: RecoveryActionType): IActionProvider | null {
    for (const provider of this.providers) {
      if (provider.supports(actionType)) {
        return provider;
      }
    }
    return null;
  }
}
