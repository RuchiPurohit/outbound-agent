import type { EmailGuessPattern } from "../db/types.js";

export interface PatternCandidate {
  pattern: EmailGuessPattern;
  email: string;
}

// Honorifics and suffixes that are never part of a mailbox name.
const IGNORED = new Set(["dr", "mr", "mrs", "ms", "prof", "jr", "sr", "ii", "iii", "iv", "phd", "md", "mba"]);

/**
 * Company-domain candidates in the runbook's pattern order (prompts/email-discovery.md).
 * Names that do not reduce to plain ASCII letters yield fewer or no candidates.
 */
export function patternCandidates(name: string, domain: string): PatternCandidate[] {
  const tokens = name
    .replace(/\([^)]*\)/g, " ")
    .split(",")[0]
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[.'’-]/g, ""))
    .filter((token) => token && !IGNORED.has(token));
  if (tokens.length === 0 || tokens.some((token) => !/^[a-z]+$/.test(token))) return [];

  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
  const host = domain.trim().toLowerCase().replace(/^www\./, "");
  const locals: [EmailGuessPattern, string | undefined][] = [
    ["firstname", first],
    ["firstname.lastname", last && `${first}.${last}`],
    ["firstnamelastname", last && `${first}${last}`],
    ["firstinitiallastname", last && `${first[0]}${last}`],
    ["firstname_lastname", last && `${first}_${last}`],
  ];
  return locals.filter((entry): entry is [EmailGuessPattern, string] => !!entry[1])
    .map(([pattern, local]) => ({ pattern, email: `${local}@${host}` }));
}
