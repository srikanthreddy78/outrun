import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { normalizeDomain } from '../scan/scan.ts';

export const ACCESS_TERMS_VERSION = '2026-11-07';
export const ACCESS_TERMS = 'The business authorizes limited automated, read-only testing of its public and provided test-account product surfaces. The test account may be used only for the agreed audit, may not submit forms or modify data, and access can be revoked at any time.';
export type PaidAccess = { orderId: string; domain: string; challengeHash: string; challengeExpiresAt: string; verifiedAt?: string; authorityAttestedAt?: string; termsVersion?: string; termsAcceptedAt?: string; credentialRef?: string; revokedAt?: string };
export interface CredentialVault { put(orderId: string, credential: { username: string; password: string }): Promise<string>; }
export class PaidAccessManager {
  private records = new Map<string, PaidAccess>();
  private vault: CredentialVault;
  constructor(vault: CredentialVault) { this.vault = vault; }
  issueChallenge(orderId: string, domainInput: string): { domain: string; dnsName: string; token: string; expiresAt: string } {
    const domain = normalizeDomain(domainInput); const token = `aga-verify-${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    this.records.set(orderId, { orderId, domain, challengeHash: createHash('sha256').update(token).digest('hex'), challengeExpiresAt: expiresAt });
    return { domain, dnsName: `_aga-verify.${domain}`, token, expiresAt };
  }
  async verifyDomain(orderId: string, lookupTxt: (name: string) => Promise<string[]>): Promise<void> {
    const record = this.require(orderId);
    if (Date.parse(record.challengeExpiresAt) < Date.now()) throw new Error('Challenge expired');
    const values = await lookupTxt(`_aga-verify.${record.domain}`);
    if (!values.some(value => { const hash = createHash('sha256').update(value).digest(); return timingSafeEqual(hash, Buffer.from(record.challengeHash, 'hex')); })) throw new Error('Domain proof failed');
    record.verifiedAt = new Date().toISOString();
  }
  acceptTerms(orderId: string, input: { authorityAttested: boolean; termsVersion: string }): void {
    const record = this.require(orderId);
    if (!record.verifiedAt) throw new Error('Domain proof required');
    if (!input.authorityAttested || input.termsVersion !== ACCESS_TERMS_VERSION) throw new Error('Authority attestation and current terms required');
    record.authorityAttestedAt = record.termsAcceptedAt = new Date().toISOString(); record.termsVersion = input.termsVersion;
  }
  async submitCredential(orderId: string, credential: { username: string; password: string }): Promise<void> {
    const record = this.require(orderId); this.assertAuthorized(record);
    if (!credential.username || !credential.password) throw new Error('Test login required');
    record.credentialRef = await this.vault.put(orderId, credential);
  }
  assertCanUseCredential(orderId: string): string { const record = this.require(orderId); this.assertAuthorized(record); if (!record.credentialRef) throw new Error('Test login missing'); return record.credentialRef; }
  revoke(orderId: string): void { this.require(orderId).revokedAt = new Date().toISOString(); }
  snapshot(orderId: string): Omit<PaidAccess, 'challengeHash' | 'credentialRef'> {
    const { challengeHash: _hash, credentialRef: _ref, ...safe } = this.require(orderId); return { ...safe };
  }
  private assertAuthorized(record: PaidAccess): void { if (record.revokedAt || !record.verifiedAt || !record.authorityAttestedAt || record.termsVersion !== ACCESS_TERMS_VERSION || !record.termsAcceptedAt) throw new Error('Paid access not authorized'); }
  private require(orderId: string): PaidAccess { const record = this.records.get(orderId); if (!record) throw new Error('Unknown order'); return record; }
}
