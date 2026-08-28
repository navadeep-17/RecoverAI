import { RecoveryActionType } from '@recoverai/shared';
import {
  IActionProvider,
  ProviderActionInput,
  ProviderActionResult,
  ProviderExecutionOutcome,
} from './provider-contracts.js';

export interface SimulatedProviderBehaviorOptions {
  forceOutcome?: ProviderExecutionOutcome;
  forceErrorClassification?: ProviderActionResult['errorClassification'];
  forceErrorMessage?: string;
  throwException?: Error;
}

export class SimulatedRecoveryProvider implements IActionProvider {
  readonly providerName = 'SIMULATED_RECOVERY_PROVIDER';
  readonly isSimulated = true;

  // Track dispatched actions for test inspection
  public dispatchedCalls: ProviderActionInput[] = [];

  // Configurable behavior for testing resilience
  private behaviorOverride: SimulatedProviderBehaviorOptions | null = null;

  setBehavior(options: SimulatedProviderBehaviorOptions | null): void {
    this.behaviorOverride = options;
  }

  supports(actionType: RecoveryActionType): boolean {
    switch (actionType) {
      case RecoveryActionType.REQUEST_PAYMENT_UPDATE:
      case RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK:
      case RecoveryActionType.SEND_CHECKOUT_RECOVERY:
      case RecoveryActionType.SEND_RECEIVABLE_REMINDER:
      case RecoveryActionType.RETRY_PAYMENT:
        return true;
      default:
        return false;
    }
  }

  async execute(input: ProviderActionInput): Promise<ProviderActionResult> {
    this.dispatchedCalls.push(input);

    if (this.behaviorOverride?.throwException) {
      throw this.behaviorOverride.throwException;
    }

    if (this.behaviorOverride?.forceOutcome) {
      const outcome = this.behaviorOverride.forceOutcome;
      if (outcome === ProviderExecutionOutcome.SUCCESS) {
        return {
          providerName: this.providerName,
          isSimulated: this.isSimulated,
          outcome: ProviderExecutionOutcome.SUCCESS,
          idempotencyKey: input.idempotencyKey,
          externalActionId: `sim_act_${input.idempotencyKey}`,
          metadata: {
            simulatedAt: new Date().toISOString(),
            actionType: input.actionType,
            recipient: input.customer?.email || input.customer?.phone || 'unknown',
          },
        };
      }

      return {
        providerName: this.providerName,
        isSimulated: this.isSimulated,
        outcome,
        idempotencyKey: input.idempotencyKey,
        errorMessage: this.behaviorOverride.forceErrorMessage || 'Simulated provider failure',
        errorClassification: this.behaviorOverride.forceErrorClassification || (
          outcome === ProviderExecutionOutcome.RETRYABLE_FAILURE ? 'NETWORK_TIMEOUT' : 'INVALID_REQUEST'
        ),
      };
    }

    // Default simulated behavior: deterministic successful execution
    const externalActionId = `sim_act_${input.idempotencyKey.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    return {
      providerName: this.providerName,
      isSimulated: this.isSimulated,
      outcome: ProviderExecutionOutcome.SUCCESS,
      idempotencyKey: input.idempotencyKey,
      externalActionId,
      metadata: {
        simulatedAt: new Date().toISOString(),
        actionType: input.actionType,
        recipient: input.customer?.email || input.customer?.phone || 'simulated_customer',
        amount: input.caseSummary?.amountAtRisk,
        currency: input.caseSummary?.currency,
      },
    };
  }
}
