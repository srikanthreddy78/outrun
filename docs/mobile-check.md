# Optional mobile onboarding check

MT-11 runs a bounded public-site check on a Mobilerun phone. It does not type into forms, sign in, submit data, purchase, or change settings. The result is separate from the 14 public web-readiness checks.

Set `MOBILERUN_CLOUD_API_KEY` and `MOBILERUN_DEVICE_ID` in the local environment, then run `pnpm mobile:check example.com`. The command starts one paid device task, polls its status for up to five minutes, and prints structured evidence. It never runs automatically. Use `MOBILERUN_RUN_KEY` to supply a stable idempotency key when retrying a start whose result is uncertain.

Without a configured phone and key, use the fake-fetch tests in `packages/core/src/integrations/mobilerun.test.ts`. No live device run has been made here.
