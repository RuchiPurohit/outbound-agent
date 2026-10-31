# LinkedIn profile research

Find verified LinkedIn profile URLs for existing contacts that do not have one.

## Scope

Process ONLY the contact IDs supplied in the request. Never add, remove,
approve, or reject contacts, and never change titles, roles, scores, or emails.
Do not use Treg or any paid enrichment service; use free public web search only.

## For each contact

1. Read the contact, its company, and its research records (the role source).
2. Search for the person's personal LinkedIn profile, e.g.
   `"<full name>" "<company>" site:linkedin.com/in`.
3. Accept a profile only when it is clearly the same person: the name matches
   and the profile headline or experience shows the contact's company (current
   or the role the role source describes). A matching name alone is not enough.
4. When verified, call
   `recordLinkedinProfile({ contactId, linkedinUrl })` with the
   `https://<host>.linkedin.com/in/<slug>` URL, without query strings.
5. When no profile can be verified, or several plausible profiles conflict,
   leave the contact unchanged and report it as `UNKNOWN` with the reason.

Company pages (`linkedin.com/company/...`), posts, careers pages, YC pages,
GitHub, and blogs are never LinkedIn profiles.

## Report

End with one line per contact: ID, name, company, and either the recorded
profile URL with the evidence that matched it, or `UNKNOWN` and why.
