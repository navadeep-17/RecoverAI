# Phase 8A evaluator freeze manifest

- Benchmark label: `SYNTHETIC BENCHMARK`
- Evaluator seed: `42`
- Corpus fingerprint: `sha256:37b511838a04a46f979167f641465e67b84c139bdaf3a7b7ce06f185783caacf`
- Corpus: 500 deterministic synthetic scenarios
- Risk families: 125 each for `PAYMENT_FAILURE`, `SUBSCRIPTION_FAILURE`, `CHECKOUT_ABANDONMENT`, and `OVERDUE_RECEIVABLE`
- Splits per family: 75 dev, 25 validation, 25 heldout
- Split totals: 300 dev, 100 validation, 100 heldout
- Strategies: `NO_INTERVENTION`, `NAIVE_RECOVERY`, `RULE_BASED`, `RULE_BASED_WITH_POLICY`, `RECOVERAI`, `POLICY_AWARE_ORACLE`
- Recovery-credit rule: only the first deduplicated authoritative `PAYMENT_SUCCEEDED`, `CHECKOUT_COMPLETED`, or `INVOICE_PAID` event credits integer-paise recovered revenue
- Metric version: version 1, defined in `README.md`

The heldout benchmark has **not** been run on this frozen evaluator. A heldout execution performed against early incomplete scaffolding was a non-final pipeline smoke test; its artifact was removed and it was not used for subsequent tuning. Dev and validation were used for implementation and engineering-debug checks. The final heldout benchmark requires separate authorization.

This manifest records no hidden scenario truth.
