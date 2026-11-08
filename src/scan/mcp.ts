import type { PrivateSupplement } from './contracts.ts';
import type { ScanService } from './service.ts';

export async function getReadinessScore(service: ScanService, input: { domain: string; requesterIp: string; privateSupplement?: PrivateSupplement }) {
  return service.request(input.domain, input.requesterIp, input.privateSupplement);
}
