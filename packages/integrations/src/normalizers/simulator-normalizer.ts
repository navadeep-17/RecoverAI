import {
  MerchantEventSource,
  NormalizedMerchantEvent,
} from '@recoverai/shared';
import { DirectMerchantEventInput, MerchantEventNormalizer } from './merchant-normalizer.js';

export class SimulatorEventNormalizer {
  static normalize(input: Omit<DirectMerchantEventInput, 'source'>): NormalizedMerchantEvent {
    return MerchantEventNormalizer.normalize({
      ...input,
      source: MerchantEventSource.SIMULATOR,
    });
  }
}
