export class UnsupportedProviderEventError extends Error {
  constructor(public readonly provider: string, public readonly eventName: string) {
    super(`Unsupported ${provider} event: "${eventName}". Unsupported provider events must not produce revenue-risk cases.`);
    this.name = 'UnsupportedProviderEventError';
  }
}

export class InvalidProviderAmountError extends Error {
  constructor(public readonly reason: string, public readonly rawAmount?: unknown) {
    super(`Invalid provider amount: ${reason}`);
    this.name = 'InvalidProviderAmountError';
  }
}

export class MissingEventIdentityError extends Error {
  constructor(public readonly eventType: string, public readonly requiredField: string) {
    super(`Event of type "${eventType}" is missing required authoritative identity field: "${requiredField}"`);
    this.name = 'MissingEventIdentityError';
  }
}

export class JobSchedulingError extends Error {
  constructor(public readonly jobType: string, public readonly details: string, public readonly cause?: unknown) {
    super(`Failed to schedule durable job "${jobType}": ${details}`);
    this.name = 'JobSchedulingError';
  }
}

export class ActionExecutionError extends Error {
  constructor(
    public readonly actionId: string,
    public readonly actionType: string,
    public readonly reason: string,
    public readonly cause?: unknown,
  ) {
    super(`Action execution failed for [${actionType}] (actionId: ${actionId}): ${reason}`);
    this.name = 'ActionExecutionError';
  }
}

