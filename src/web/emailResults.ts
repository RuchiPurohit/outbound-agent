import type { Company, Contact, GuessVerification, ResearchRecord, WorkflowRun } from "../db/types.js";

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

/**
 * Persistent SMTP and Treg progress for the email discovery card, derived from SQLite so it
 * survives dashboard restarts. `runs` are the campaign's workflow runs, newest first.
 */
export function renderEmailPipelineStatus(
  contacts: Contact[], runs: WorkflowRun[], state: { checking: boolean; lastCheck?: string },
): string {
  const guessed = contacts.filter(({ status, emailStatus, guessedEmail }) =>
    status === "APPROVED" && emailStatus === "EMAIL_NOT_FOUND" && !!guessedEmail);
  const parts: string[] = [];
  if (state.checking) {
    parts.push('<div class="notice">SMTP check running… This page refreshes every 3s.</div>');
  } else if (guessed.length) {
    const count = (verdict: GuessVerification | null) =>
      guessed.filter(({ guessedEmailVerification }) => guessedEmailVerification === verdict).length;
    const unchecked = count(null);
    parts.push(`<p class="muted"><strong>SMTP check:</strong> ${unchecked ? `${unchecked} not checked yet · ` : "all guesses checked · "}${count("VALID")} valid · ${count("INVALID")} invalid · ${count("CATCH_ALL")} catch-all · ${count("UNKNOWN")} inconclusive${state.lastCheck ? `<br>${escapeHtml(state.lastCheck)}` : ""}</p>`);
  }

  type Details = { contactIds?: number[]; emailTask?: string };
  const targeted = (task: string | undefined) => runs.filter(({ kind, details }) => {
    if (kind !== "EMAIL_DISCOVERY" || !details) return false;
    const parsed = JSON.parse(details) as Details;
    return !!parsed.contactIds?.length && parsed.emailTask === task;
  });
  const evidence = targeted("PATTERN_EVIDENCE")[0];
  if (evidence) {
    const ids = new Set((JSON.parse(evidence.details!) as Details).contactIds);
    const supported = contacts.filter(({ id, guessedEmailConfidence }) =>
      ids.has(id) && guessedEmailConfidence === "PATTERN_SUPPORTED").length;
    parts.push(evidence.status === "RUNNING" || evidence.status === "PENDING"
      ? `<div class="notice"><strong>Pattern-evidence search running</strong> (run ${evidence.id}) for ${ids.size} contact(s)… This page refreshes every 3s.</div>`
      : `<p class="muted"><strong>Last pattern-evidence search</strong> (run ${evidence.id}, ${evidence.status.toLowerCase()}): ${supported} of ${ids.size} guess(es) now backed by a public same-domain address.</p>`);
  }

  const latest = targeted(undefined)[0];
  if (latest) {
    const ids = new Set((JSON.parse(latest.details!) as { contactIds: number[] }).contactIds);
    const targets = contacts.filter(({ id }) => ids.has(id));
    const tally = (predicate: (contact: Contact) => boolean) => targets.filter(predicate).length;
    if (latest.status === "RUNNING" || latest.status === "PENDING") {
      parts.push(`<div class="notice"><strong>Treg recovery running</strong> (run ${latest.id}) for ${ids.size} contact(s)… Progress is under Workflow runs; this page refreshes every 3s.</div>`);
    } else {
      const silent = tally((contact) => contact.emailRecoveryOutcome === null && !contact.emailRecoveryError);
      parts.push(`<p class="muted"><strong>Last Treg recovery</strong> (run ${latest.id}, ${latest.status.toLowerCase()}): ${tally(({ emailRecoveryOutcome }) => emailRecoveryOutcome === "VERIFIED")} verified · ${tally(({ emailRecoveryOutcome }) => emailRecoveryOutcome === "CATCH_ALL_CANDIDATE")} catch-all address found · ${tally(({ emailRecoveryOutcome }) => emailRecoveryOutcome === "NOT_FOUND")} not found · ${tally(({ emailRecoveryError }) => !!emailRecoveryError)} paused by a provider error</p>`);
      if (silent) {
        parts.push(`<div class="notice error"><strong>Treg recovery run ${latest.id} recorded no outcome for ${silent} contact(s).</strong> Check its output under Workflow runs; these contacts are back in the Recover with Treg count.</div>`);
      }
    }
  }
  const paused = contacts.filter(({ emailRecoveryStartedAt, emailRecoveryError }) => !emailRecoveryStartedAt && emailRecoveryError);
  if (paused.length) {
    parts.push(`<div class="notice error"><strong>Treg recovery paused:</strong> ${escapeHtml(paused[0].emailRecoveryError)}. ${paused.length} contact(s) will retry the next time you click Recover with Treg.</div>`);
  }
  return parts.join("");
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
