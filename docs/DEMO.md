# RecoverAI runtime demo

Prerequisites: Node 18+, a running local PostgreSQL instance, and the repository's normal `DATABASE_URL`. The current header-principal adapter is development/hackathon-only authentication, not production authentication.

Run `npm run demo:setup` to check PostgreSQL and apply migrations; it never drops or recreates data. For the full deterministic acceptance trace, run `npm run demo`. The acceptance harness uses real PostgreSQL, real event ingestion/detection, policy, orchestration, and deterministic `MockLLMProvider`; it does not prove Gemini quality or Razorpay execution.

Canonical trace outcomes:

- Demo A begins with a persisted subscription-renewal failure, whose detector-created case reaches `RECOVERED`; verified recovered is ₹14,999 and agent-attributed is ₹0 unless authoritative action correlation exists.
- Demo B begins with persisted `CHECKOUT_STARTED`, a durable abandonment schedule, and real timer detection before its ₹8,499 case reaches `RECOVERED`.
- Demo C begins with persisted `INVOICE_CREATED`, a durable overdue schedule, and real timer detection before its ₹85,000 case creates a durable promise, then a visible `PENDING` HumanReview and `NEEDS_REVIEW` case.

The canonical acceptance harness uses `MockLLMProvider` and `SIMULATED_RECOVERY_PROVIDER`. A separate worker integration test is the real pg-boss delivery proof; canonical Demo C is the domain trace and does not claim direct pg-boss delivery. Normal runtime can use Gemini when configured, Razorpay Test Mode for payment-link actions when its credentials are configured, and the simulator for non-Razorpay actions.

Razorpay is optional and Test Mode only. With `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`, normal runtime payment-link creation routes to the Test Mode adapter; the acceptance harness remains simulated and CI never requires those credentials. For a non-side-effect Gemini proposal smoke, set `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, and optionally `GEMINI_MODEL`, then run the focused Gemini tests or worker composition checks. Do not print keys.

For normal local services after setup, use separate terminals:

```powershell
npm run --workspace=@recoverai/api dev
npm run --workspace=@recoverai/worker dev
npm run --workspace=@recoverai/web dev
```

The runtime trace distinguishes verified settlement (authoritative event + exact money) from agent-attributed settlement (only a persisted, successful correlated RecoverAI action). Synthetic benchmark/evaluation figures are not runtime recovered money.
