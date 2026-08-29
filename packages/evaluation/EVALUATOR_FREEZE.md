# Phase 8A evaluator freeze manifest

- Benchmark label: `SYNTHETIC BENCHMARK`
- Evaluator seed: `42`
- Previous rejected freeze: `f872f1fee8e744a41373e58ed00e29d6982f5d66`
- Previous fingerprint: `sha256:37b511838a04a46f979167f641465e67b84c139bdaf3a7b7ce06f185783caacf`
- Corpus fingerprint: `sha256:c6c573fb9b36f5db02584cc4410c4c4451f858986e3762236ad63c36cb35c9f9`
- Corpus: 500 deterministic synthetic scenarios
- Risk families: 125 each for `PAYMENT_FAILURE`, `SUBSCRIPTION_FAILURE`, `CHECKOUT_ABANDONMENT`, and `OVERDUE_RECEIVABLE`
- Splits per family: 75 dev, 25 validation, 25 heldout
- Split totals: 300 dev, 100 validation, 100 heldout
- Strategies: `NO_INTERVENTION`, `NAIVE_RECOVERY`, `RULE_BASED`, `RULE_BASED_WITH_POLICY`, `RECOVERAI`, `POLICY_AWARE_ORACLE`
- Recovery-credit rule: only the first deduplicated authoritative `PAYMENT_SUCCEEDED`, `CHECKOUT_COMPLETED`, or `INVOICE_PAID` event credits integer-paise recovered revenue
- Metric version: version 1, defined in `README.md`

The first Phase 8A freeze at `f872f1f` was rejected during external pre-heldout review and is superseded by this richer causal evaluator before any heldout execution. The heldout benchmark has **not** been run on either frozen evaluator. A heldout execution performed against early incomplete scaffolding was a non-final pipeline smoke test; its artifact was removed and it was not used for subsequent tuning. Dev and validation were used for implementation and engineering-debug checks. The final heldout benchmark requires separate authorization.

This manifest records no hidden scenario truth.
