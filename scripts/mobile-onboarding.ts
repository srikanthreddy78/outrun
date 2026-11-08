import { createMobilerunClient, runMobileOnboardingCheck } from "@outrun/core/integrations/mobilerun";

const domain = process.argv[2];
const key = process.env.MOBILERUN_CLOUD_API_KEY;
const deviceId = process.env.MOBILERUN_DEVICE_ID;
if (!domain || !key || !deviceId) {
  console.error("Usage: MOBILERUN_CLOUD_API_KEY=... MOBILERUN_DEVICE_ID=... pnpm mobile:check example.com");
  process.exit(2);
}

runMobileOnboardingCheck(createMobilerunClient(key, deviceId), domain, {
  ...(process.env.MOBILERUN_RUN_KEY ? { idempotencyKey: process.env.MOBILERUN_RUN_KEY } : {}),
})
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Mobile check failed");
    process.exitCode = 1;
  });
