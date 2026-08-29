# Phase 8B heldout benchmark manifest

- Benchmark label: SYNTHETIC BENCHMARK
- Evaluator SHA: f599312bd1e81ea4f9d4d9fc3d2acd880b2d9849
- Seed: 42
- Corpus fingerprint: sha256:f07508e41e4c7a29a1a3c09b2206fa5d7c8cb2dca20a75de9d59e927f8bb8e96
- Heldout command: npm run evaluate -- --seed 42 --split heldout
- Heldout case count: 100
- Heldout per family: PAYMENT_FAILURE=25, SUBSCRIPTION_FAILURE=25, CHECKOUT_ABANDONMENT=25, OVERDUE_RECEIVABLE=25
- Strategies: NO_INTERVENTION, NAIVE_RECOVERY, RULE_BASED, RULE_BASED_WITH_POLICY, RECOVERAI, POLICY_AWARE_ORACLE
- Run timestamp: 2026-08-30 (heldout executed once from the frozen evaluator state)
- Evaluator freeze status: evaluator logic was not changed after the approved freeze and before the heldout run
- Tuning status: no heldout-based tuning was performed
- Synthetic benchmark status: this benchmark is fully synthetic and deterministic; it is intended for evaluator integrity checks and not for production inference claims

## Headline heldout results

| Strategy | Revenue Recovered | Recovery Rate | Unsafe Actions | Policy Violations | Cases Recovered | Median Time To Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NO_INTERVENTION | 102,658,249 | 0.201986 | 0 | 0 | 20 | 1320 |
| NAIVE_RECOVERY | 107,322,751 | 0.211163 | 1012 | 892 | 19 | 317 |
| RULE_BASED | 170,889,299 | 0.336234 | 275 | 101 | 28 | 213 |
| RULE_BASED_WITH_POLICY | 33,404,289 | 0.065724 | 24 | 0 | 12 | 213 |
| RECOVERAI | 28,169,500 | 0.055425 | 35 | 0 | 11 | 206 |
| POLICY_AWARE_ORACLE | 132,106,143 | 0.259926 | 0 | 0 | 34 | 706 |

## RECOVERAI deltas vs RULE_BASED_WITH_POLICY

- Revenue recovered: -5,234,789
- Recovery rate: -0.010299
- Unsafe actions: +11
- Policy violations: 0
- Correct stops: +1
- Escalation precision: +0.002086
- Actions per recovery: +3.310606
- Contacts per recovery: +0.166667
- Median time to recovery: -7 minutes

## RECOVERAI deltas vs RULE_BASED

- Revenue recovered: -142,719,799
- Recovery rate: -0.280809
- Unsafe actions: -240
- Policy violations: -101
- Correct stops: -4
- Escalation precision: -0.130237
- Actions per recovery: -2.165584
- Contacts per recovery: -2.000000
- Median time to recovery: -7 minutes

## RECOVERAI deltas vs NAIVE_RECOVERY

- Revenue recovered: -79,153,251
- Recovery rate: -0.155738
- Unsafe actions: -977
- Policy violations: -892
- Correct stops: +1
- Escalation precision: not defined / no escalation bucket for NAIVE_RECOVERY
- Actions per recovery: -42.009569
- Contacts per recovery: -21.157895
- Median time to recovery: -111 minutes

## RECOVERAI deltas vs POLICY_AWARE_ORACLE

- Revenue recovered: -103,889,643
- Recovery rate: -0.204501
- Unsafe actions: +35
- Policy violations: 0
- Correct stops: -13
- Escalation precision: -0.205401
- Actions per recovery: +10.668451
- Contacts per recovery: +1.882353
- Median time to recovery: -500 minutes

## Known limitations

- The benchmark is intentionally synthetic and deterministic.
- Heldout data is a frozen benchmark artifact, not a production sample.
- No heldout-based tuning was performed after the single frozen run.
- Strategy comparison reflects benchmark behavior only and should not be treated as a production decision model.
