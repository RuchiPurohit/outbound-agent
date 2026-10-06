import type { Company, Contact, ResearchRecord } from "../db/types.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

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
    const guess = contact.guessedEmail
      ? `<strong>${escapeHtml(contact.guessedEmail)}</strong><br><span class="badge UNKNOWN">Guessed · ${escapeHtml(contact.guessedEmailConfidence?.replaceAll("_", " ") ?? "Unknown")}</span><br><span class="muted">${escapeHtml(contact.guessedEmailPattern)} — ${escapeHtml(contact.guessedEmailBasis)}</span>${contact.guessedEmailSourceUrl ? `<br><a href="${escapeHtml(contact.guessedEmailSourceUrl)}" target="_blank" rel="noreferrer">Pattern evidence ↗</a>` : ""}`
      : '<span class="muted">—</span>';
    return `<tr><td><strong>${escapeHtml(contact.name)}</strong></td><td>${escapeHtml(company?.name ?? "Unknown company")}</td><td>${contact.email ? `<strong>${escapeHtml(contact.email)}</strong>` : '<span class="muted">Not found</span>'}</td><td>${guess}</td><td><span class="badge ${contact.emailStatus}">${status}</span></td><td class="source">${source}</td></tr>`;
  }).join("");

  return `<div class="tablewrap"><table class="email-results" aria-label="Email discovery results"><thead><tr><th>Contact</th><th>Company</th><th>Business email</th><th>Guessed email</th><th>Discovery status</th><th>Email source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
