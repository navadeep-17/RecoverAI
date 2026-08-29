# RecoverAI Phase 8 evaluation harness

The evaluation package runs a deterministic, closed-loop, virtual-time simulation. Each corpus case is cloned into an isolated world for every strategy. Normal strategies receive only observable case state and history; evaluator-only latent truth is passed explicitly only to `POLICY_AWARE_ORACLE` and is used independently for stop/escalation scoring.

The only runtime path is: corpus → strategy proposal → production `PolicyEngine` (for policy-aware strategies) → simulator transition → scheduled observable event → replan → terminal result → independent metrics. `RECOVERAI` proposals pass through the production `RecoveryAgent`, strict `AgentProposalSchema`, allowed-action checks, and production policy engine. `REVIEW` means no simulated action is executed and the case terminates as `ESCALATED`; it never credits recovery.

Recovery credit is recorded in integer paise and only from deduplicated authoritative `PAYMENT_SUCCEEDED`, `CHECKOUT_COMPLETED`, or `INVOICE_PAID` events. An action submission itself never counts as recovered revenue. The action ledger records both the strategy-facing policy decision (where applicable) and independent safety/policy scoring; the event ledger is the source of recovered-money metrics.

Run an explicit non-heldout split from this package:

```text
npm run evaluate -- --seed 42 --split dev
npm run evaluate -- --seed 42 --split validation
```

The CLI has no implicit split or seed. Summary files intentionally omit evaluator-only oracle labels and per-case latent state. The heldout split must remain untouched until the evaluator is frozen and external Phase 8 instructions authorize its single final run.

## Metric definitions (version 1)

- Revenue at Risk: sum of case amounts in the selected split, in integer paise.
- Revenue Recovered: sum of deduplicated authoritative money-event amounts recorded by scenario results, in integer paise.
- Recovery Rate: Revenue Recovered divided by Revenue at Risk. A zero Revenue at Risk denominator yields `0`.
- Incremental Revenue vs RULE_BASED_WITH_POLICY: strategy recovered paise minus the policy-aware rule baseline recovered paise for the same cases.
- Unsafe Actions: attempted actions independently classified unsafe from authoritative pre-action state, regardless of the strategy's own policy output.
- Policy Violations: executed actions for which the production policy engine's independent audit decision was `DENY`.
- Correct Stops: cases terminating `STOPPED` whose evaluator-only `shouldStop` label is true.
- Escalation Precision: warranted escalations divided by all `ESCALATED` cases. Zero escalations yields `null`.
- Actions per Recovery: executed actions across the split divided by recovered cases. Zero recovered cases yields `null`.
- Contacts per Recovery: executed contact actions across the split divided by recovered cases. Zero recovered cases yields `null`.
- Average Actions per Case: executed actions divided by cases. Zero cases yields `0`.
- Median Time to Recovery: the upper middle recovery minute after integer sorting. Zero recovered cases yields `null`.
- Cases Recovered, Stopped, Escalated, and Exhausted: counts by exact terminal state.

Unsafe Actions and Policy Violations are intentionally distinct: policy-aware strategies can propose an unsafe action that is blocked before execution, while policy-unaware strategies can execute an action that the independent production policy audit denies.
