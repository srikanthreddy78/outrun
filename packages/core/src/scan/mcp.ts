import type { PrivateSupplement } from "./contracts";
import type { ScanService } from "./service";

export async function getReadinessScore(
  service: ScanService,
  input: { domain: string; requesterIp: string; privateSupplement?: PrivateSupplement },
) {
  return service.request(input.domain, input.requesterIp, input.privateSupplement);
}
