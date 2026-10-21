import type { OutboundStore } from "../db/store.js";
import type { Contact, GuessVerification } from "../db/types.js";
import { patternCandidates } from "./guessPatterns.js";
import type { CandidateVerificationResult } from "./smtpVerifier.js";

export interface MailboxVerifier {
  verifyCandidates(candidates: string[]): Promise<CandidateVerificationResult>;
}

export type GuessVerificationSummary = Record<GuessVerification, number> & {
  failed: number;
  /** Guesses replaced by another pattern that the mail server accepted. */
  replaced: number;
};

/**
 * SMTP-checks guessed addresses only. Sourced PUBLICLY_LISTED/VERIFIED emails are never
 * probed, and a verdict never promotes a guess out of EMAIL_NOT_FOUND. For pattern guesses,
 * the stored guess is probed first, then the runbook's other patterns, and the first accepted
 * address becomes the guess. Runs sequentially to keep the probe rate low.
 */
export async function verifyGuessedEmails(
  store: OutboundStore,
  campaignId: number,
  verifier: MailboxVerifier,
  onResult?: (contact: Contact, result: CandidateVerificationResult) => void,
): Promise<GuessVerificationSummary> {
  const summary: GuessVerificationSummary = { VALID: 0, INVALID: 0, CATCH_ALL: 0, UNKNOWN: 0, failed: 0, replaced: 0 };
  for (const contact of store.listGuessesAwaitingVerification(campaignId)) {
    const guess = contact.guessedEmail!;
    const company = store.getCompany(contact.companyId)!;
    const alternatives = contact.guessedEmailSource === "PATTERN"
      ? patternCandidates(contact.name, company.domain).filter(({ email }) => email !== guess.toLowerCase())
      : [];
    try {
      const result = await verifier.verifyCandidates([guess, ...alternatives.map(({ email }) => email)]);
      const replacement = alternatives.find(({ email }) => email === result.address);
      store.recordGuessVerification({ contactId: contact.id, guessedEmail: guess,
        verdict: result.verdict, detail: result.detail, replacement });
      summary[result.verdict] += 1;
      if (replacement) summary.replaced += 1;
      onResult?.(contact, result);
    } catch (error) {
      // No verdict was saved (e.g. the guess changed mid-check), so it is not a recovery candidate.
      summary.failed += 1;
      onResult?.(contact, { address: guess, verdict: "UNKNOWN",
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

export function formatSummary(summary: GuessVerificationSummary): string {
  return `${summary.VALID} valid, ${summary.INVALID} invalid, ${summary.CATCH_ALL} catch-all, `
    + `${summary.UNKNOWN} unknown${summary.replaced ? ` (${summary.replaced} guess(es) replaced by an accepted pattern)` : ""}`
    + `${summary.failed ? `, ${summary.failed} failed` : ""}`;
}
