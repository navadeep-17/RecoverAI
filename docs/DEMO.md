# RecoverAI runtime demo

Prerequisites: Node 18+, a running local PostgreSQL instance, and the repository's normal `DATABASE_URL`. The current header-principal adapter is development/hackathon-only authentication, not production authentication.

Run `npm run demo:setup` to check PostgreSQL and apply migrations; it never drops or recreates data. For the full synthetic acceptance trace, run `npm run demo`. It uses real PostgreSQL and pg-boss with deterministic `AI_PROVIDER=mock` when no provider is selected. Mock mode proves the proposal contract and closed-loop safety, not Gemini quality.

Canonical trace outcomes:

- Demo A: ₹14,999 card-expiry recovery reaches `RECOVERED`; verified recovered is ₹14,999 and agent-attributed is ₹0 unless authoritative action correlation exists.
- Demo B: ₹8,499 checkout abandonment reaches `RECOVERED`; communications are labelled `SIMULATED_RECOVERY_PROVIDER` unless explicit Razorpay Test Mode is configured.
- Demo C: ₹85,000 receivable creates a durable promise, a pg-boss promise-check delivery, then a visible `PENDING` HumanReview and `NEEDS_REVIEW` case.

Razorpay is optional and Test Mode only. With `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`, payment-link creation routes to the Test Mode adapter; CI never requires those credentials. For a non-side-effect Gemini proposal smoke, set `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, and optionally `GEMINI_MODEL`, then run the focused Gemini tests or worker composition checks. Do not print keys.

For normal local services after setup, use separate terminals:

```powershell
npm run --workspace=@recoverai/api dev
npm run --workspace=@recoverai/worker dev
npm run --workspace=@recoverai/web dev
```

The runtime trace distinguishes verified settlement (authoritative event + exact money) from agent-attributed settlement (only a persisted, successful correlated RecoverAI action). Synthetic benchmark/evaluation figures are not runtime recovered money.
