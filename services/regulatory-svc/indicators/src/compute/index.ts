// Combined compute registry. Keys MUST equal the catalog ids exactly —
// `assertRegistryMatchesCatalog` enforces it at boot and in unit tests.

import { ComputeRegistry } from '../types';
import { FINANCIAL_REGISTRY } from './financial';
import { BEHAVIOURAL_REGISTRY } from './behavioural';
import { TRANSACTION_REGISTRY } from './transaction';
import { CREDIT_REGISTRY } from './credit';
import { FRAUD_REGISTRY } from './fraud';

export const COMPUTE_REGISTRY: ComputeRegistry = {
  ...FINANCIAL_REGISTRY,
  ...BEHAVIOURAL_REGISTRY,
  ...TRANSACTION_REGISTRY,
  ...CREDIT_REGISTRY,
  ...FRAUD_REGISTRY,
};

export {
  FINANCIAL_REGISTRY,
  BEHAVIOURAL_REGISTRY,
  TRANSACTION_REGISTRY,
  CREDIT_REGISTRY,
  FRAUD_REGISTRY,
};
