import type { Company, Contact, GuessVerification, ResearchRecord } from "../db/types.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const VERIFICATION_BADGES: Record<GuessVerification, [string, string]> = {
  VALID: ["APPROVED", "SMTP valid"],
  INVALID: ["REJECTED", "SMTP invalid · will bounce"],
  CATCH_ALL: ["UNKNOWN", "Catch-all domain · unconfirmed"],
  UNKNOWN: ["UNKNOWN", "SMTP inconclusive"],
};

/** Badge for a guess's SMTP verdict. A VALID verdict still describes a guess, not a sourced email. */
export function guessVerificationBadge(verification: GuessVerification | null, detail?: string | null): string {
  if (!verification) return '<span class="badge">Not SMTP-checked</span>';
  const [tone, label] = VERIFICATION_BADGES[verification];
  return `<span class="badge ${tone}"${detail ? ` title="${escapeHtml(detail)}"` : ""}>${label}</span>`;
}

function recoveryStatus(contact: Contact): string {
  if (!contact.emailRecoveryStartedAt && contact.emailRecoveryError) {
    return `<br><span class="muted">Treg recovery paused (will retry): ${escapeHtml(contact.emailRecoveryError)}</span>`;
  }
  if (!contact.emailRecoveryStartedAt || contact.emailRecoveryOutcome === "VERIFIED") return "";
  const label = contact.emailRecoveryOutcome === "CATCH_ALL_CANDIDATE" ? "Treg recovery: catch-all address found"
    : contact.emailRecoveryOutcome === "NOT_FOUND" ? "Treg recovery: no verified address"
      : "Treg recovery: started, no outcome recorded yet";
  return `<br><span class="muted"${contact.emailRecoveryNotes ? ` title="${escapeHtml(contact.emailRecoveryNotes)}"` : ""}>${label}</span>`;
}

export function renderEmailResults(
  companies: Company[], contacts: Contact[], research: ResearchRecord[],
): string {
  const completed = contacts.filter(({ emailStatus }) => emailStatus !== "UNKNOWN");
  if (completed.length === 0) {
    return '<div class="empty">No email discovery results yet. Approve contacts and run email discovery to see outcomes here.</div>';
  }

  const rows = completed.map((contact) => {
    const company = companies.find(({ id }) => id === contact.companyId);
    // recordEmailDiscovery stores a distinct signal for the exact address and status.
    // Do not present an unrelated role/profile source as evidence of an email.
    const expectedSignal = `Professional business email ${contact.emailStatus.toLowerCase()}: ${contact.email}`;
    const evidence = [...research].reverse().find((record) =>
      record.companyId === contact.companyId && record.contactId === contact.id
      && record.signal.toLowerCase() === expectedSignal.toLowerCase());
    let source = '<span class="muted">No email source recorded</span>';
    if (contact.emailStatus === "EMAIL_NOT_FOUND") {
      source = '<span class="muted">No reliable public email found</span>';
    } else if (evidence) {
      try {
        const url = new URL(evidence.sourceUrl);
        if (url.protocol === "https:" || url.protocol === "http:") {
          source = `<a href="${escapeHtml(url.href)}" target="_blank" rel="noreferrer">${escapeHtml(url.hostname)} ↗</a>`;
        }
      } catch { /* Keep the missing-source message for invalid URLs. */ }
    }
    const status = contact.emailStatus === "EMAIL_NOT_FOUND" ? "Email not found"
      : contact.emailStatus === "PUBLICLY_LISTED" ? "Publicly listed" : "Verified";
    const treg = contact.guessedEmailSource === "TREG_CATCH_ALL";
    const origin = treg
      ? `<span class="badge UNKNOWN">Guessed · Treg finder, catch-all</span><br><span class="muted">${escapeHtml(contact.guessedEmailBasis)}</span>`
      : `<span class="badge UNKNOWN">Guessed · ${escapeHtml(contact.guessedEmailConfidence?.replaceAll("_", " ") ?? "Unknown")}</span><br><span class="muted">${escapeHtml(contact.guessedEmailPattern)} — ${escapeHtml(contact.guessedEmailBasis)}</span>`;
    const guess = contact.guessedEmail
      ? `<strong>${escapeHtml(contact.guessedEmail)}</strong><br>${origin}${contact.guessedEmailSourceUrl ? `<br><a href="${escapeHtml(contact.guessedEmailSourceUrl)}" target="_blank" rel="noreferrer">${treg ? "Treg verifier audit" : "Pattern evidence"} ↗</a>` : ""}<br>${guessVerificationBadge(contact.guessedEmailVerification, contact.guessedEmailVerificationDetail)}${contact.guessedEmailVerificationDetail ? `<br><span class="muted">${escapeHtml(contact.guessedEmailVerificationDetail)}</span>` : ""}${recoveryStatus(contact)}`
      : '<span class="muted">—</span>';
    return `<tr><td><strong>${escapeHtml(contact.name)}</strong></td><td>${escapeHtml(company?.name ?? "Unknown company")}</td><td>${contact.email ? `<strong>${escapeHtml(contact.email)}</strong>` : '<span class="muted">Not found</span>'}</td><td>${guess}</td><td><span class="badge ${contact.emailStatus}">${status}</span></td><td class="source">${source}</td></tr>`;
  }).join("");

  return `<div class="tablewrap"><table class="email-results" aria-label="Email discovery results"><thead><tr><th>Contact</th><th>Company</th><th>Business email</th><th>Guessed email</th><th>Discovery status</th><th>Email source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
