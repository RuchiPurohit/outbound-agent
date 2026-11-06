/**
 * Client-specific inputs for each funnel stage and the stage prompts built from them.
 *
 * Each client stores one value per field below. A stage prompt combines those inputs with
 * the fixed workflow and safety rules the application enforces (approval gates, persistence
 * calls, contact and follow-up limits, score factors, email patterns). The fixed rules are
 * not inputs because changing them in a prompt would not change what the dashboard enforces.
 *
 * The runner still reads prompts/*.md; these generated prompts are for review and export.
 */

export type FieldKind = "text" | "textarea" | "list" | "number" | "checkbox";
export type FieldValue = string | string[] | number | boolean;

export interface SetupField {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  min?: number;
  max?: number;
  /** Optional inputs never count as missing. */
  optional?: boolean;
  /** The value for the ConvoKit client, taken from today's prompts and docs. */
  convokit: FieldValue;
}

export const STAGE_IDS = [
  "company-discovery", "contact-discovery", "linkedin-profile-research",
  "email-discovery", "prospect-research", "email-generation", "follow-up-generation",
] as const;
export const DOCUMENT_IDS = ["doc-product", "doc-icp", "doc-email-rules"] as const;
export type StageId = typeof STAGE_IDS[number];
export type DocumentId = typeof DOCUMENT_IDS[number];
export type SectionId = "profile" | StageId | DocumentId;

export interface SetupSection {
  id: SectionId;
  title: string;
  /** What this stage does, shown under its heading. */
  summary: string;
  /** The current hand-written prompt or doc this section is derived from. */
  source?: string;
  /** For documents: the file name it is generated as, e.g. ICP.md. */
  fileName?: string;
  fields: SetupField[];
}

export const STEP_KINDS = {
  email: "Email (threaded reply)",
  linkedin: "LinkedIn task",
  call: "Call task",
  task: "Other manual task",
} as const;
export type StepKind = keyof typeof STEP_KINDS;
export const MAX_SEQUENCE_STEPS = 8;
export const DEFAULT_STEP_DELAY_DAYS = 7;

/** One step after the first email. Email steps are drafted; task steps are done by the human. */
export interface SequenceStep {
  kind: StepKind;
  /** Days after the previous step was sent or completed. */
  delayDays: number;
  name: string;
  /** Email steps: the template or goal. Task steps: what the human should do. */
  instructions: string;
  /** Email steps only, e.g. "Prefer 90–130 words and never exceed 150". */
  length: string;
}

export type ClientSetup = Record<SectionId, Record<string, FieldValue>>;

/** A campaign's sequence: guidance for its first emails (step 1) and the steps after them. */
export interface CampaignSequence {
  /** Campaign-specific guidance for first emails, applied within the client's email rules. */
  firstEmailGuidance: string;
  steps: SequenceStep[];
}

const SCORE_FACTORS = [
  ["workflowFit", "Messaging workflow fit", 30],
  ["chatImplementation", "Chat implementation opportunity", 20],
  ["timingSignal", "Timely buying signal", 15],
  ["teamFit", "Team/stage fit", 15],
  ["stackFit", "Supported stack fit", 10],
  ["liveProduct", "Live-product evidence", 10],
] as const;

const FOLLOW_UP_1 = "Hi <first name>,\n\nI turned <the idea from the first email, in 3–6 words> into something you can try in 30 seconds, no signup:\n\nhttps://convokit.app/demo?for=<Company>&s=<scenario>\n\nIt opens on <the scenario>. <One sentence tying it to the prospect's product.> You play both sides: type on the left and it lands on the right instantly, with typing indicators and history. Scan the QR code to make your phone the second screen.\n\n<Optional, only when it fits: one sentence on a confirmed capability.>\n\nConvoKit gives you a ready-made chat layer, so <Company> can add this in a day instead of building it from scratch. The code behind it is on the same page.\n\nIf it's not a priority right now, a quick \"not now\" is completely fine.\n\nRuchi\nhttps://convokit.app/";
const FOLLOW_UP_2 = "Hi <first name>,\n\nLast note from me on this. Two quick options:\n\n1. If <the workflow from the first email> isn't on <Company>'s roadmap, is there someone else who owns <collaboration / messaging / support>? Happy to send them the demo instead.\n2. If the timing is just off, I'll leave it here. The demo stays up:\n   https://convokit.app/demo?for=<Company>&s=<scenario>\n\nEither way, thanks for reading.\n\nRuchi\nhttps://convokit.app/";

export const SECTIONS: readonly SetupSection[] = [
  {
    id: "profile",
    title: "Client profile",
    summary: "Who you are selling for. Every stage prompt uses these details.",
    fields: [
      { key: "productName", label: "Product name", kind: "text", convokit: "ConvoKit" },
      { key: "productWebsite", label: "Product website", kind: "text", convokit: "https://convokit.app/" },
      { key: "productSummary", label: "What the product is", kind: "textarea",
        convokit: "ConvoKit is hosted chat infrastructure for teams that want chat as a feature, not as their core product. Customers can build and control their own product UI on top of ConvoKit's backend." },
      { key: "capabilities", label: "Confirmed capabilities", kind: "list", help: "Only what the client has confirmed. Prompts may mention nothing else.",
        convokit: ["hosted conversation APIs", "participant management and access controls", "realtime message delivery",
          "custom UI support", "Flutter support", "React web support", "React Native support",
          "webhooks, including event delivery suitable for analytics integrations",
          "signed, retried message.created webhooks that carry the message and its recipient IDs, so a customer can notify recipients by email or Slack in their own product",
          "audit trails"] },
      { key: "notYetAvailable", label: "Not yet available (never mention)", kind: "list", optional: true,
        convokit: ["email notifications to a team when a website visitor writes in the chat widget's support inbox"] },
      { key: "senderName", label: "Sender name (signature)", kind: "text", convokit: "Ruchi" },
      { key: "referenceDocs", label: "Other files to read first", kind: "list", optional: true,
        help: "Repository paths. The client's Product profile, ICP, and Email rules documents are listed automatically.",
        convokit: ["AGENTS.md"] },
    ],
  },
  {
    id: "company-discovery",
    title: "Company discovery",
    summary: "Finds and scores companies that match the campaign segment.",
    source: "prompts/company-discovery.md",
    fields: [
      { key: "defaultGeography", label: "Default geography", kind: "list", help: "A campaign's own segment overrides this.",
        convokit: ["United States", "Canada"] },
      { key: "companyShape", label: "Preferred company shape", kind: "list",
        convokit: ["founder-led or a small product/engineering organization likely to have a short decision path",
          "roughly 2–100 employees, with strongest preference for 5–50 (up to 200 when the buyer and trigger are strong)",
          "pre-seed through Series A, or a similarly small bootstrapped company with a live product and active development",
          "enough product maturity to integrate infrastructure, without enterprise procurement or a dedicated messaging-platform organization"] },
      { key: "prioritySegments", label: "Priority segments", kind: "list",
        convokit: ["multiplayer and social games, including simple board, card, trivia, fantasy, tournament, and casual games",
          "two-sided marketplaces and on-demand or gig applications",
          "dating, friendship, community, club, and membership applications",
          "education, tutoring, cohort, coaching, fitness, habit, and accountability apps",
          "telehealth and therapy platforms with a verified human care workflow",
          "property, rental, coliving, roommate, and local-service products",
          "collaborative B2B SaaS, project, client, creator, and professional workflows",
          "mobile, Flutter, React Native, product-development, and low-code agencies with a sourced relevant portfolio (channel partners)"] },
      { key: "buildTriggers", label: "Buying triggers that rank a company higher", kind: "list",
        convokit: ["a launch or roadmap direction involving multiplayer, groups, community, collaboration, matching, bookings, marketplaces, or creator/user interaction",
          "hiring for product, mobile, backend, platform, realtime, community, growth, or engagement work connected to the qualifying workflow",
          "a public request to build chat or realtime communication",
          "users coordinating through email, WhatsApp, Discord, Slack, comments, support, or another external channel that could move into the product",
          "new funding, an accelerator batch, active product expansion, or a new platform that creates an implementation window"] },
      { key: "qualifyingFeature", label: "Existing feature to check for", kind: "text",
        help: "Discovery records whether each company already has it: PRESENT, NO_PUBLIC_EVIDENCE, or UNKNOWN.",
        convokit: "human-to-human chat or user-to-user messaging" },
      { key: "opportunity", label: "Opportunity the product addresses", kind: "text",
        help: "Completes: \"hypothesis: <product> may help with …\"",
        convokit: "a specific embedded-messaging opportunity or infrastructure burden" },
      { key: "automaticQualifiers", label: "Automatic qualifiers", kind: "list",
        convokit: ["sourced comments, forums, support discussions, or collaboration features",
          "a sourced, product-specific hypothesis that chat could improve engagement, anchored to a feature, audience, or workflow",
          "a sourced shared human activity, including multiplayer and social games where players have a reason to communicate around a match, club, tournament, invitation, or rematch"] },
      { key: "exclusions", label: "Exclusions", kind: "list",
        convokit: ["single-player or bot-only products with no separate human interaction path",
          "human-to-AI assistants, copilots, or chatbots without a distinct human-to-human workflow (an AI assistant alone does not disqualify a company that otherwise qualifies)",
          "products selling messaging, community infrastructure, or realtime collaboration as their mature core product/IP (check the homepage headline and primary pricing page)",
          "companies whose use case requires unconfirmed product capabilities",
          "abandoned products or companies whose identity cannot be verified"] },
      { key: "deprioritize", label: "Deprioritize", kind: "list",
        convokit: ["existing embedded chat with no sourced switching or expansion trigger",
          "organizational scale or structure that suggests a long decision path",
          "no evidence of a live or actively developed product",
          "general agencies without relevant portfolio or technology evidence",
          "a communication idea that is generic rather than tied to the product"] },
      { key: "researchChannels", label: "Research channels", kind: "list",
        convokit: ["recent Y Combinator and other credible accelerator batches",
          "Product Hunt and public launch posts for multiplayer, marketplace, community, social, collaborative, creator, education, fitness, and service products",
          "app-store listings, official help centers, changelogs, roadmaps, and product documentation showing participant workflows",
          "public engineering or product jobs tied to realtime, mobile, backend, community, engagement, marketplace, multiplayer, or collaboration work",
          "attributable GitHub, Reddit, Indie Hackers, Flutter, React Native, and founder posts requesting chat or describing a messaging/vendor problem"] },
      ...SCORE_FACTORS.map(([key, label, points]): SetupField => ({
        key: `score_${key}`, label: `${label} (0–${points} points): what earns points`, kind: "text",
        convokit: ({
          workflowFit: "Strength and specificity of the human workflow or product-specific engagement opportunity",
          chatImplementation: "Greenfield build opportunity, external/fragmented communication, or a sourced switching/expansion trigger",
          timingSignal: "Recent evidence that creates an implementation window now",
          teamFit: "Small, capable team and stage suggesting a short decision path",
          stackFit: "Sourced Flutter, React web, or React Native product surface",
          liveProduct: "Evidence that the product is usable, launched, or actively reaching real users",
        } as Record<string, string>)[key]!,
      })),
    ],
  },
  {
    id: "contact-discovery",
    title: "Contact discovery",
    summary: "Finds up to two decision makers at each approved company.",
    source: "prompts/contact-discovery.md",
    fields: [
      { key: "targetRoles", label: "Target roles, in priority order", kind: "list",
        convokit: ["CTO or Technical Founder", "VP Engineering or Head of Engineering",
          "Staff or Principal Software Engineer", "Engineering Manager"] },
      { key: "responsibilityAreas", label: "Relevant responsibilities", kind: "list",
        help: "Prefer people who own these, not just a matching title.",
        convokit: ["platform engineering", "infrastructure", "backend systems", "developer experience",
          "realtime systems", "messaging", "APIs"] },
      { key: "allowFallback", label: "Include a founder or plausible decision maker when no strong match is verified", kind: "checkbox", convokit: true },
      { key: "preferredSources", label: "Preferred sources for roles", kind: "list",
        convokit: ["current company leadership and team pages", "technical posts", "speaker biographies", "public professional profiles"] },
    ],
  },
  {
    id: "linkedin-profile-research",
    title: "LinkedIn profile research",
    summary: "Finds verified LinkedIn profiles for discovered contacts that lack one.",
    source: "prompts/linkedin-profile-research.md",
    fields: [
      { key: "searchQuery", label: "Search query", kind: "text", convokit: "\"<full name>\" \"<company>\" site:linkedin.com/in" },
      { key: "matchRule", label: "When a profile counts as the same person", kind: "textarea",
        convokit: "The name matches and the profile headline or experience shows the contact's company (current, or the role the role source describes). A matching name alone is not enough." },
      { key: "notProfiles", label: "Never treat these as profiles", kind: "list",
        convokit: ["company pages (linkedin.com/company/...)", "posts", "careers pages", "YC pages", "GitHub", "blogs"] },
    ],
  },
  {
    id: "email-discovery",
    title: "Email discovery",
    summary: "Finds published business emails, otherwise stores one labelled pattern guess.",
    source: "prompts/email-discovery.md",
    fields: [
      { key: "addressSources", label: "Where to look for the contact's own address", kind: "list",
        convokit: ["employer-controlled pages", "public professional profiles", "conference biographies",
          "authored technical posts", "reputable public directories"] },
      { key: "patternEvidenceSources", label: "Where to look for a same-domain address that shows the pattern", kind: "list",
        convokit: ["public GitHub commits by the company's org or its founders/engineers (commit author emails, e.g. a commit's .patch view)",
          "the company site's team, about, contact, imprint/Impressum, privacy, and press pages",
          "press releases, podcast show notes, conference speaker pages, job posts, and app-store or package-registry listings that name a person"] },
    ],
  },
  {
    id: "prospect-research",
    title: "Prospect research",
    summary: "Finds up to three sourced signals per approved contact for a personal angle.",
    source: "prompts/prospect-research.md",
    fields: [
      { key: "signalTypes", label: "Useful signals", kind: "list",
        convokit: ["recent product launches", "engineering hiring", "technical posts", "collaboration/chat features",
          "marketplace/community functionality", "infrastructure changes", "funding"] },
      { key: "notSignals", label: "Never count as a signal", kind: "list",
        convokit: ["generic company information", "job titles", "email listings"] },
      { key: "shareColleagueSignals", label: "Reuse a company-level signal for colleagues at the same company", kind: "checkbox", convokit: true },
    ],
  },
  {
    id: "email-generation",
    title: "Email generation",
    summary: "Drafts one first-touch email per checked prospect, for human review.",
    source: "prompts/email-generation.md",
    fields: [
      { key: "tone", label: "Tone", kind: "text", convokit: "technical founder / engineer speaking to another engineer" },
      { key: "targetWords", label: "Preferred length (words, including signature)", kind: "number", min: 30, max: 300, convokit: 100 },
      { key: "maxWords", label: "Never exceed (words)", kind: "number", min: 30, max: 400, convokit: 140 },
      { key: "subjectRule", label: "Subject line", kind: "text",
        convokit: "Short and specific, includes the prospect company's name, no clickbait or fabricated familiarity" },
      { key: "structure", label: "Email structure, in order", kind: "list",
        convokit: ["Hi <first name>,", "Specific, sourced product observation.", "A valid, concrete business use case tied to that observation.",
          "Two-engineer context and how verified ConvoKit capabilities relate.", "A concise 10-minute call invitation.", "Signature."] },
      { key: "senderContext", label: "Sender context paragraph", kind: "textarea",
        convokit: "ConvoKit is being built by two engineers who understand the infrastructure beneath chat. Relate only 2–4 verified capabilities to the use case. End with: \"We can personally help in setting up and customizing the chat for <company>.\"" },
      { key: "callToAction", label: "Call to action", kind: "textarea",
        convokit: "One low-pressure invitation to a quick 10-minute conversation to understand how the prospect approaches messaging and whether ConvoKit can help. Do not ask for a 15-minute call or offer API docs as the primary CTA." },
      { key: "example", label: "Example email (rhythm only, never copied)", kind: "textarea",
        convokit: "Hi <first name>,\n\nI saw <company> <one verified, specific observation>.\n\nA similar need could arise when <User A> and <User B> need to <interaction> around <specific product object or workflow>.\n\nWe're two engineers building ConvoKit around <2–4 relevant, verified capabilities>, so teams can keep the experience product-native. We can personally help in setting up and customizing the chat for <company>.\n\nIf that's relevant to the products <company> builds, I'd love to spend 10 minutes learning how you approach messaging and whether we could help.\n\nRuchi\nhttps://convokit.app/" },
      { key: "bannedPhrases", label: "Banned phrases", kind: "list",
        convokit: ["Hope you're doing well", "I wanted to reach out", "I'm reaching out because", "I came across your company",
          "revolutionize", "seamlessly", "game-changing", "game changer", "powerful solution", "unlock", "unlock value", "supercharge",
          "best-in-class", "cutting-edge", "boost engagement", "touch base", "circle back"] },
    ],
  },
  {
    id: "follow-up-generation",
    title: "Follow-up generation",
    summary: "Drafts the next email step of each campaign's sequence for checked sent emails.",
    source: "prompts/follow-up-generation.md",
    fields: [
      { key: "demoLink", label: "Link every follow-up email carries", kind: "text", convokit: "https://convokit.app/demo?for=<Company>&s=<scenario>" },
      { key: "scenarios", label: "Demo scenarios (scenario: use for → opens on)", kind: "list",
        help: "Leave empty when the link has no per-segment variant.", optional: true,
        convokit: ["agent-review: agent platforms, AI coding and dev tools, internal-tool builders → an agent that finished a change but skipped two failing tests, and a teammate deciding whether to ship it or rerun",
          "marketplace: marketplaces with buyers and sellers → a buyer and seller sorting out an order",
          "coaching: health, coaching, wellness, tutoring → a weekly check-in between a client and their coach",
          "support: products whose customers contact a support team → a customer starting a chat with support",
          "community: edtech, cohorts, communities → a cohort thread where members ask about this week's lesson",
          "(omit s): anything else → a live chat with a visitor"] },
      { key: "bannedPhrases", label: "Banned phrases", kind: "list",
        convokit: ["just checking in", "bumping this", "following up on my last email"] },
      { key: "delayDays", label: "Default wait between follow-ups (days)", kind: "number", min: 0, max: 90,
        help: "New campaigns start with Follow-up 1 and Follow-up 2 below, this many days apart.", convokit: 7 },
      { key: "followUp1Name", label: "Follow-up 1 name", kind: "text", convokit: "Follow-up 1: live demo" },
      { key: "followUp1Length", label: "Follow-up 1 length", kind: "text", convokit: "Prefer 90–130 words and never exceed 150" },
      { key: "followUp1", label: "Follow-up 1 template", kind: "textarea", convokit: FOLLOW_UP_1 },
      { key: "followUp2Name", label: "Follow-up 2 name", kind: "text", optional: true, convokit: "Follow-up 2: close the loop" },
      { key: "followUp2Length", label: "Follow-up 2 length", kind: "text", optional: true,
        convokit: "Prefer 50–90 words and never exceed 110. It is the last email in the sequence" },
      { key: "followUp2", label: "Follow-up 2 template", kind: "textarea", optional: true,
        help: "Leave empty for a single follow-up.", convokit: FOLLOW_UP_2 },
    ],
  },
];

const notesField: SetupField = { key: "notes", label: "Additional notes", kind: "textarea", optional: true,
  help: "Anything else this document should say. Added at the end as written.", convokit: "" };

/** Client documents, generated from these inputs plus related profile and stage inputs. */
export const DOCUMENTS: readonly SetupSection[] = [
  {
    id: "doc-product",
    title: "Product profile",
    fileName: "PRODUCT.md",
    summary: "What the product is and can do. Also uses: Client profile (capabilities), Follow-up generation (demo link, scenarios).",
    source: "docs/PRODUCT.md",
    fields: [
      { key: "lastConfirmed", label: "Capabilities last confirmed (date)", kind: "text", convokit: "2026-10-30" },
      { key: "officialSources", label: "Official sources of truth", kind: "list",
        convokit: ["https://convokit.app", "https://convokit.app/docs"] },
      { key: "demo", label: "Live demo description", kind: "textarea", optional: true,
        convokit: "A no-signup demo runs at https://convokit.app/demo. The visitor plays both people in a real ConvoKit conversation: they type in the left window and it arrives in the right window instantly, with typing indicators and history. A QR code makes their phone the second screen. The client code behind it is shown on the same page. Demo messages are deleted after 15 minutes." },
      { key: "demoLinkRules", label: "Demo link rules", kind: "list", optional: true,
        convokit: ["`for` puts the company's name in the page headings. Use the company's own capitalization (`ToolJet`, not `tooljet`); only letters, digits, spaces, and hyphens are shown.",
          "`s` picks one scenario per segment. Omit it when no scenario fits; the page then shows the generic live chat."] },
      { key: "claimLimits", label: "Claim limits", kind: "textarea",
        convokit: "Do not extrapolate additional capabilities, compliance certifications, service levels, pricing, or customer/reference claims from this list. Re-check this file and public sources before every research or drafting run." },
      notesField,
    ],
  },
  {
    id: "doc-icp",
    title: "Ideal customer profile",
    fileName: "ICP.md",
    summary: "Who to target, how to qualify, and how to score. Also uses: Client profile, Company discovery (segments, triggers, geography, shape, channels, exclusions, scoring), Contact discovery (buyers).",
    source: "docs/ICP.md",
    fields: [
      { key: "objective", label: "Commercial objective", kind: "textarea",
        convokit: "The objective is to find leads likely to adopt ConvoKit, not merely companies whose products resemble existing chat customers.\n\nThe best lead has a live human-to-human product workflow, a credible reason to add messaging, a team capable of integrating it, and, once contact discovery is authorized, a reachable decision maker. Embedded chat does not need to exist today. A sourced product workflow plus a specific chat hypothesis is sufficient to qualify at the company-discovery stage.\n\nDo not assume a company with existing chat is a strong lead. Replacing working infrastructure creates switching cost. Existing-chat companies rank below greenfield opportunities unless public evidence shows a current reason to replace, rebuild, expand, or reconsider the implementation." },
      { key: "productFit", label: "Product fit", kind: "textarea",
        convokit: "The prospect should want chat as a feature, not sell chat as its product. The team should benefit from owning or customizing its UI while outsourcing conversations, participants, message storage, access, realtime delivery, and operations.\n\nDo not claim unverified compliance, moderation, scale, pricing, migration tooling, service levels, or vendor-comparison advantages.\n\nTechnology fit helps conversion but is not mandatory when the public stack is unknown. Never reject a strong workflow merely because its implementation stack is not public." },
      { key: "qualificationPaths", label: "Qualification paths (a company needs one)", kind: "list",
        convokit: ["**Greenfield human messaging opportunity — preferred.** Two human roles, two players, or a human group share a sourced activity or product object and have a concrete reason to communicate. Chat need not exist.",
          "**Product-specific engagement opportunity — preferred.** A sourced feature or audience makes chat, reactions, coordination, invitations, groups, or conversation a plausible engagement improvement, even when both participant roles are not explicitly documented.",
          "**External or fragmented communication — strong.** Users currently coordinate through an external channel, comments, forums, support discussions, email, or manual workflows connected to the product.",
          "**Existing embedded messaging — conditional.** Human-to-human chat exists and there is a sourced switching, rebuilding, limitation, or expansion trigger. Existing chat alone does not qualify a company and should rank low."] },
      { key: "tier1", label: "Tier 1: pursue first", kind: "list",
        convokit: ["strong greenfield human communication opportunity", "live product or credible near-launch product",
          "recent implementation or product-expansion trigger", "small sourced team or stage indicating a short likely decision path",
          "supported stack is known, or stack is unknown but the other signals are strong"] },
      { key: "tier2", label: "Tier 2: pursue selectively", kind: "list",
        convokit: ["strong greenfield workflow but no dated trigger", "good agency/channel-partner fit with a relevant sourced portfolio",
          "external communication that could plausibly move in-product", "existing chat with a sourced limitation, rebuild, migration, or expansion need"] },
      { key: "tier3", label: "Tier 3: research or nurture", kind: "list",
        convokit: ["plausible chat hypothesis but weak proof of active usage or team readiness", "existing chat with no switching trigger",
          "product is early, inactive, or has no current implementation window"] },
      { key: "calibration", label: "Scoring calibration", kind: "textarea", help: "Point bands for each score factor.",
        convokit: "`workflowFit`:\n\n- 0: no sourced product workflow or audience\n- 5–10: generic social possibility with little product-specific detail\n- 11–20: sourced shared activity or audience with a concrete chat hypothesis\n- 21–26: named human roles or players communicating around a specific match, booking, listing, project, session, order, group, or other product object\n- 27–30: especially frequent, consequential, or central coordination need\n\n`chatImplementation`:\n\n- 0–3: implementation state is unknown and the opportunity is generic\n- 4–8: no public chat evidence after a completed search, with a credible and product-specific greenfield hypothesis\n- 9–14: strong greenfield opportunity, external communication, or an apparent gap anchored to a sourced workflow\n- 15–20: explicit chat build request, external-channel pain, planned messaging, or a sourced reason to replace, rebuild, or expand an existing implementation\n\n`timingSignal`:\n\n- 0: no dated reason to act\n- 3–6: recent funding, accelerator participation, general product hiring, or a relevant launch without direct communication scope\n- 7–11: recent social, multiplayer, marketplace, collaboration, community, or platform expansion connected to the hypothesis\n- 12–15: explicit messaging work, a build request, an active rebuild/migration, or attributable dissatisfaction with the current approach\n\n`teamFit`:\n\n- 0–4: team readiness, size, and stage are unclear or poorly aligned\n- 5–9: either company size or stage is sourced and reasonably aligned\n- 10–13: small product team and early stage are both sourced and aligned\n- 14–15: live, founder-led or similarly compact product team with strong sourced evidence of a short likely decision path\n\n`stackFit` and `liveProduct` use their table definitions. A supported stack can reduce integration friction but cannot rescue a weak human workflow." },
      { key: "rankingRules", label: "Ranking rules", kind: "list",
        convokit: ["Rank conversion opportunity, not sophistication of the current chat system.",
          "Prefer a 70-point greenfield lead over a 75-point existing-chat lead when the latter has no switching trigger; explain the ordering in the report.",
          "As a default company-approval threshold, prioritize scores of 60 or higher with at least 10 `chatImplementation` points and a dated trigger. A strong greenfield company without a dated trigger may remain Tier 2 for human review.",
          "Never award points because a claim merely seems likely.",
          "Explain borderline scores and missing conversion evidence in the report."] },
      { key: "discipline", label: "Research and outreach discipline", kind: "list",
        convokit: ["Important claims require a public source URL.",
          "Never invent chat plans, pain, employee counts, funding, stack, titles, or switching intent.",
          "Keep observed facts separate from hypotheses.",
          "Company fit, buyer confidence, and email availability are separate judgments.",
          "Do not reject a strong company solely because a perfect technical title is not verified; persist clearly labeled fallback contacts for human review."] },
      notesField,
    ],
  },
  {
    id: "doc-email-rules",
    title: "Email rules",
    fileName: "EMAIL_RULES.md",
    summary: "How to qualify a prospect for drafting and how emails read. Also uses: Client profile, Email generation, Follow-up generation.",
    source: "docs/EMAIL_RULES.md",
    fields: [
      { key: "objective", label: "Objective", kind: "textarea",
        convokit: "Write like a technical founder emailing a product or engineering leader. The goal is to earn a conversation by identifying a legitimate product workflow, not to maximize the number of emails drafted." },
      { key: "qualificationSources", label: "Re-check the prospect with, in order", kind: "list",
        convokit: ["Product website and product documentation/help center.", "Features and pricing pages.",
          "Product or engineering blog.", "Other reliable public sources only when necessary."] },
      { key: "understand", label: "Understand before drafting", kind: "textarea",
        convokit: "Understand the primary users, important workflows, whether two user types interact, how they currently communicate, and which domain object a conversation would attach to. Do not infer a workflow from the company's category alone." },
      { key: "prospectTypes", label: "Prospect types", kind: "list",
        convokit: ["`EXISTING_MESSAGING` (Type A): meaningful chat or messaging already exists. Focus on the infrastructure they may maintain as the surface grows. Do not tell them they need messaging.",
          "`MESSAGING_OPPORTUNITY` (Type B): a specific existing user-to-user workflow may benefit from contextual in-product communication. Identify `User A → interaction → User B` and the object containing the conversation when public evidence makes those details available.",
          "`LOW_FIT` (Type C): messaging does not solve an important, evidenced product problem, or the use case needs too many assumptions. Do not draft."] },
      { key: "typeGuidance", label: "Writing guidance per type", kind: "list",
        convokit: ["For Type A, mention only 2–4 currently verified capabilities relevant to the existing messaging surface and acknowledge that the prospect controls its UI.",
          "For Type B, describe the concrete user-to-user interaction and use conditional language such as “It made me wonder whether…”, “may”, or “could”. Sell the workflow rather than generic “chat” or “engagement.”"] },
      { key: "qualifierPolicy", label: "Automatic-qualifier policy", kind: "textarea",
        convokit: "Verified comments, forums, support discussions, or collaboration surfaces are automatic qualifiers and must not be discarded merely because they are not embedded chat. A product-specific hypothesis that chat could improve engagement is also an automatic qualifier when anchored to a sourced feature, audience, or workflow. Classify either at least `MEDIUM` fit and draft a Type B email with conditional wording. Never present the engagement benefit or internal demand as proven, and never claim messaging is absent merely because it was not publicly found." },
      { key: "thesis", label: "Sales thesis format", kind: "text",
        convokit: "ConvoKit may be relevant to this company because [specific observed workflow and conditional messaging infrastructure problem or opportunity]." },
      { key: "accuracy", label: "Accuracy rules", kind: "textarea",
        convokit: "Keep observed facts separate from inferred hypotheses. Do not present an inference as an internal company fact. Never invent product features, technical architecture, user workflows, integrations, counts, priorities, or problems. Avoid hype, fake urgency, excessive adjectives, long feature lists, and unnecessary em dashes." },
      notesField,
    ],
  },
];

const ALL_SECTIONS: readonly SetupSection[] = [...SECTIONS, ...DOCUMENTS];

export function getSection(id: string): SetupSection | undefined {
  return ALL_SECTIONS.find((section) => section.id === id);
}

const blankValue = (field: SetupField): FieldValue =>
  field.kind === "list" ? [] : field.kind === "text" || field.kind === "textarea" ? "" : field.convokit;


/**
 * The email steps a new campaign starts with, from the client's follow-up rules: Follow-up 1,
 * and Follow-up 2 when the client has a template for it, each the client's default wait apart.
 */
export function defaultSequenceFromSetup(setup: ClientSetup): SequenceStep[] {
  const rules = setup["follow-up-generation"];
  const text = (key: string) => String(rules[key] ?? "").trim();
  const wait = Number.isInteger(rules.delayDays) ? rules.delayDays as number : DEFAULT_STEP_DELAY_DAYS;
  const step = (n: 1 | 2): SequenceStep => ({ kind: "email", delayDays: wait, name: text(`followUp${n}Name`) || `Follow-up ${n}`,
    length: text(`followUp${n}Length`), instructions: text(`followUp${n}`) });
  return text("followUp2") ? [step(1), step(2)] : [step(1)];
}

/** ConvoKit's default follow-ups, used for campaigns without a client. */
export function defaultSequence(): SequenceStep[] {
  return defaultSequenceFromSetup(defaultSetup("convokit"));
}

/** The inputs for a client: ConvoKit's current values, or blanks for a new client. */
export function defaultSetup(kind: "convokit" | "blank"): ClientSetup {
  const sections = Object.fromEntries(ALL_SECTIONS.map((section) => [section.id, Object.fromEntries(section.fields
    .map((field) => [field.key, kind === "convokit" ? field.convokit : blankValue(field)]))]));
  return sections as ClientSetup;
}

function validStep(value: unknown): SequenceStep | undefined {
  if (!value || typeof value !== "object") return undefined;
  const step = value as Record<string, unknown>;
  if (typeof step.kind !== "string" || !(step.kind in STEP_KINDS)) return undefined;
  if (typeof step.delayDays !== "number" || !Number.isInteger(step.delayDays) || step.delayDays < 0 || step.delayDays > 90) return undefined;
  return { kind: step.kind as StepKind, delayDays: step.delayDays, name: String(step.name ?? ""),
    instructions: String(step.instructions ?? ""), length: String(step.length ?? "") };
}

const validSteps = (value: unknown[]): SequenceStep[] =>
  value.map(validStep).filter((step): step is SequenceStep => !!step).slice(0, MAX_SEQUENCE_STEPS);

/** A campaign's stored sequence, or the standard one when none is stored or it is unreadable. */
export function parseCampaignSequence(stored: string | null): CampaignSequence {
  try {
    const raw = stored ? JSON.parse(stored) as { firstEmailGuidance?: unknown; steps?: unknown } : undefined;
    if (raw && Array.isArray(raw.steps)) {
      return { firstEmailGuidance: typeof raw.firstEmailGuidance === "string" ? raw.firstEmailGuidance : "", steps: validSteps(raw.steps) };
    }
  } catch { /* fall through to the standard sequence */ }
  return { firstEmailGuidance: "", steps: defaultSequence() };
}

/**
 * The follow-up steps an older client's stored settings describe: a sequence saved on the
 * client, or one built from its Follow-up 1 and Follow-up 2 templates. Undefined when the
 * settings describe neither. Used once to give existing campaigns their own sequence.
 */
export function sequenceFromClientSettings(stored: unknown): SequenceStep[] | undefined {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, Record<string, unknown> | undefined> & { sequence?: unknown };
  if (Array.isArray(raw.sequence)) return validSteps(raw.sequence);
  const legacy = raw["follow-up-generation"];
  if (!legacy || typeof legacy.followUp1 !== "string" || !legacy.followUp1.trim()) return undefined;
  // Older settings had templates without names or a wait; fill those from ConvoKit's defaults.
  const defaults = defaultSetup("convokit")["follow-up-generation"];
  return defaultSequenceFromSetup(resolveSetup({ ...raw, "follow-up-generation": { ...defaults, followUp2: "", ...legacy } }));
}

const validValue = (field: SetupField, value: unknown): value is FieldValue => {
  if (field.kind === "list") return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (field.kind === "number") return typeof value === "number" && Number.isInteger(value);
  if (field.kind === "checkbox") return typeof value === "boolean";
  return typeof value === "string";
};

/** Reads stored inputs, filling any missing or malformed field with its blank value. */
export function resolveSetup(stored: unknown): ClientSetup {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, Record<string, unknown> | undefined>;
  const sections = Object.fromEntries(ALL_SECTIONS.map((section) => [section.id, Object.fromEntries(section.fields.map((field) => {
    const value = raw[section.id]?.[field.key];
    return [field.key, validValue(field, value) ? value : blankValue(field)];
  }))]));
  return sections as ClientSetup;
}

/**
 * Parses the sequence editor. Rows arrive as parallel arrays; a row marked for removal or
 * left completely blank is dropped.
 */
export function parseSequenceForm(form: { getAll(name: string): string[]; get(name: string): string | null }): CampaignSequence {
  const kinds = form.getAll("kind");
  const removed = new Set(form.getAll("remove"));
  const steps: SequenceStep[] = [];
  kinds.forEach((kind, index) => {
    const name = (form.getAll("name")[index] ?? "").trim();
    const instructions = (form.getAll("instructions")[index] ?? "").replace(/\r\n/g, "\n").trim();
    const length = (form.getAll("length")[index] ?? "").trim();
    if (removed.has(String(index)) || (!name && !instructions)) return;
    if (!(kind in STEP_KINDS)) throw new Error(`Step ${steps.length + 2}: choose a step type`);
    const delayDays = Number(form.getAll("delayDays")[index]);
    if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > 90) {
      throw new Error(`Step ${steps.length + 2}: wait must be a whole number of days from 0 to 90`);
    }
    if (!name || name.length > 120) throw new Error(`Step ${steps.length + 2}: give it a name (up to 120 characters)`);
    if (instructions.length > 10_000 || length.length > 300) throw new Error(`Step ${steps.length + 2} is too long`);
    steps.push({ kind: kind as StepKind, delayDays, name, instructions, length: kind === "email" ? length : "" });
  });
  if (steps.length > MAX_SEQUENCE_STEPS) throw new Error(`A sequence can have at most ${MAX_SEQUENCE_STEPS} steps after the first email`);
  const firstEmailGuidance = (form.get("firstEmailGuidance") ?? "").replace(/\r\n/g, "\n").trim();
  if (firstEmailGuidance.length > 5000) throw new Error("Keep the first-email guidance under 5000 characters");
  return { firstEmailGuidance, steps };
}

/** Problems that would leave a step without what it needs, for the sequence's status badge. */
export function sequenceIssues(steps: SequenceStep[]): string[] {
  return steps.flatMap((step, index) => !step.instructions.trim()
    ? [`Step ${index + 2} (${step.name}) has no ${step.kind === "email" ? "template" : "instructions"}`] : []);
}

/** Parses one section's form submission; throws a readable error for invalid input. */
export function parseSectionForm(sectionId: SectionId, form: { get(name: string): string | null }): Record<string, FieldValue> {
  const section = getSection(sectionId)!;
  return Object.fromEntries(section.fields.map((field) => {
    const raw = form.get(field.key) ?? "";
    if (field.kind === "checkbox") return [field.key, raw === "yes"];
    if (field.kind === "number") {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < (field.min ?? 0) || value > (field.max ?? 10_000)) {
        throw new Error(`${field.label} must be a whole number from ${field.min ?? 0} to ${field.max ?? 10_000}`);
      }
      return [field.key, value];
    }
    if (field.kind === "list") {
      const items = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (items.length > 60 || items.some((item) => item.length > 1000)) {
        throw new Error(`${field.label}: use at most 60 lines of up to 1000 characters`);
      }
      return [field.key, items];
    }
    const value = raw.replace(/\r\n/g, "\n").trim();
    if (value.length > (field.kind === "text" ? 1000 : 10_000)) throw new Error(`${field.label} is too long`);
    return [field.key, value];
  }));
}

// ---------------------------------------------------------------------------
// Prompt builders

const missing = (label: string): string => `[NOT SET: ${label}]`;

function reader(setup: ClientSetup, sectionId: SectionId) {
  const section = getSection(sectionId)!;
  const label = (key: string) => section.fields.find((field) => field.key === key)?.label ?? key;
  return {
    text: (key: string): string => String(setup[sectionId][key] ?? "").trim() || missing(label(key)),
    num: (key: string): number => Number(setup[sectionId][key]),
    flag: (key: string): boolean => setup[sectionId][key] === true,
    bullets: (key: string, numbered = false): string => {
      const items = setup[sectionId][key] as string[];
      return items.length ? items.map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${item}`).join("\n") : `- ${missing(label(key))}`;
    },
    has: (key: string): boolean => (setup[sectionId][key] as string[]).length > 0,
  };
}

/** Which client documents each stage reads, matching what the runner gives it today. */
export const STAGE_DOCUMENTS: Record<StageId, DocumentId[]> = {
  "company-discovery": ["doc-icp", "doc-product"],
  "contact-discovery": ["doc-icp"],
  "linkedin-profile-research": [],
  "email-discovery": ["doc-icp"],
  "prospect-research": ["doc-icp"],
  "email-generation": ["doc-product", "doc-email-rules"],
  "follow-up-generation": ["doc-product", "doc-email-rules"],
};

function header(setup: ClientSetup, title: string, stage: StageId): string {
  const profile = reader(setup, "profile");
  const files = [...setup.profile.referenceDocs as string[],
    ...STAGE_DOCUMENTS[stage].map((id) => `${getSection(id)!.fileName} (client document)`)];
  return `# ${title}

<!-- Generated from the client setup page. Edit the inputs there, not this file. -->

${files.length ? `Read ${files.join(", ")} before starting.\n\n` : ""}## Client

- Product: ${profile.text("productName")} (${profile.text("productWebsite")})
- What it is: ${profile.text("productSummary")}

Confirmed capabilities (mention or rely on nothing else):

${profile.bullets("capabilities")}
${(setup.profile.notYetAvailable as string[]).length ? `\nNot yet available. Never mention or imply these:\n\n${profile.bullets("notYetAvailable")}\n` : ""}`;
}

const STAGE_BUILDERS: Record<StageId, (setup: ClientSetup) => string> = {
  "company-discovery": (setup) => {
    const s = reader(setup, "company-discovery");
    const product = reader(setup, "profile").text("productName");
    const scoring = SCORE_FACTORS.map(([key, label, points]) => `| \`${key}\` | ${label} | 0–${points} | ${s.text(`score_${key}`)} |`).join("\n");
    return `${header(setup, "Company discovery", "company-discovery")}
## Who to find

Research companies for the requested campaign. The campaign's stored segment
overrides the default geography, size, or industry below.

Default geography:

${s.bullets("defaultGeography")}

Preferred company shape:

${s.bullets("companyShape")}

Priority segments:

${s.bullets("prioritySegments")}

Rank a company higher when a recent source shows:

${s.bullets("buildTriggers")}

Research channels:

${s.bullets("researchChannels")}

A public job or community post is only a lead. Verify company identity, domain,
product, affiliation, date, and fit before storing it. Never contact or reply to
the source during discovery, and never invent a company from an anonymous post.

## What to collect for every company

- company name and canonical domain
- source-stated total employee count or range, with its URL; otherwise unknown.
  Record engineering headcount only when independently sourced
- geography and its source URL
- strongest relevant signal and its source URL
- a specific reason it might need ${product}
- whether ${s.text("qualifyingFeature")} already exists: \`PRESENT\` only with a
  direct public source, \`NO_PUBLIC_EVIDENCE\` after a completed search finds
  none (not proof of absence), otherwise \`UNKNOWN\`
- \`chatImplementation\`: \`HOMEGROWN\`, \`VENDOR\` (with vendor name), \`EXTERNAL\`,
  \`NONE_FOUND\`, or \`UNKNOWN\`, with a source for any known implementation
- a six-factor \`scoreBreakdown\` (the store computes the total score)
- a one-sentence \`salesThesis\` with two explicit clauses:

> Observed: [specific sourced workflow or feature]; hypothesis: ${product} may
> help with ${s.text("opportunity")}.

## Qualification gate

Store a company only when first-party evidence supports the thesis. Mark the
benefit as a hypothesis, never a proven fact. Automatic qualifiers:

${s.bullets("automaticQualifiers")}

Exclude:

${s.bullets("exclusions")}

Deprioritize:

${s.bullets("deprioritize")}

Do not store a low-fit candidate merely because it matches the requested
industry, geography, or employee count.

## Scoring

Score each factor from sourced evidence only; leave unsupported factors at zero.
Never assign a score by intuition or because a claim seems likely.

| Stored key | Factor | Points | What earns points |
| --- | --- | ---: | --- |
${scoring}

Rank by the computed score. Rank strong greenfield opportunities above products
that already have the feature but no sourced switching or expansion trigger.

## Fixed rules

- Important claims need a public source URL. Never invent a company, employee
  count, location, event, or product claim; store unknown instead of guessing.
- Do not insert duplicate domains into the campaign.
- Store each new company as \`DISCOVERED\`; only the user may approve it.
- Store the strongest signal and its source as a company-level research record.
- Do not discover contacts or emails, and do not create outreach.
- Respect the requested result count. Never weaken verification or pad the
  list; if fewer qualify, state \`requested N, found M\` and explain why.
- Write \`data/campaign-<id>-companies.md\` ranked by score, with score factors,
  existing-feature status, implementation, sourced headcount, thesis, and the
  rejected candidates with sourced reasons.

This is an execution run: research, persist, and report. Do not merely describe
the process.
`;
  },

  "contact-discovery": (setup) => {
    const s = reader(setup, "contact-discovery");
    const product = reader(setup, "profile").text("productName");
    return `${header(setup, "Contact discovery", "contact-discovery")}
Use this only after the user has approved companies. Research only companies
whose status is exactly \`APPROVED\` in the selected campaign; if there are none,
stop and tell the user how to approve them.

## Goal

For each approved company, find at most two contacts. Target roles, in priority
order:

${s.bullets("targetRoles", true)}

Do not select someone merely because their title matches. Prefer evidence that
their responsibilities involve:

${s.bullets("responsibilityAreas")}

A lower-title owner of these areas can be more relevant than a nontechnical
founder.
${s.flag("allowFallback")
    ? `
If no strong match can be verified, still store up to two of the best publicly
identifiable founders or plausible decision makers for human review. Keep their
supported public title, mark unsupported role details \`UNKNOWN\`, give a lower
score, and state the evidence gap.
`
    : `
If no strong match can be verified, store no contact for that company and report
the evidence gap.
`}
## Required fields

- full name, exact current title, company
- LinkedIn profile URL (\`https://www.linkedin.com/in/...\`) only when verified to
  be this person; never a company page, blog post, or another site
- role category: \`CTO_TECHNICAL_FOUNDER\`, \`VP_HEAD_ENGINEERING\`,
  \`STAFF_PRINCIPAL_ENGINEER\`, \`ENGINEERING_MANAGER\`, or \`UNKNOWN\`
- role score from 0 to 100
- a concise reason this person is relevant to ${product}
- a source URL proving the current role

Preferred sources:

${s.bullets("preferredSources")}

## Fixed rules

- Never invent a person, title, profile URL, responsibility, or claim.
- Check existing contacts first and do not create duplicates.
- Store contacts with \`email = NULL\`, \`email_status = 'UNKNOWN'\`, and
  \`status = 'DISCOVERED'\`, plus a contact-level research record with the role
  evidence, source URL, and relevance reasoning. Do not approve contacts.
- Do not search for or guess emails, draft outreach, or send anything.

Report contacts grouped by company and ranked by role score, with fallback
candidates in a clearly labeled section.
`;
  },

  "linkedin-profile-research": (setup) => {
    const s = reader(setup, "linkedin-profile-research");
    return `${header(setup, "LinkedIn profile research", "linkedin-profile-research")}
Find verified LinkedIn profile URLs for the contact IDs supplied in the request
only. Never add, remove, approve, or reject contacts, and never change titles,
roles, scores, or emails. Use free public web search only, never a paid
enrichment service.

## For each contact

1. Read the contact, its company, and its research records (the role source).
2. Search with: ${s.text("searchQuery")}
3. Accept a profile only when it is clearly the same person. ${s.text("matchRule")}
4. When verified, call \`recordLinkedinProfile({ contactId, linkedinUrl })\` with
   the \`https://<host>.linkedin.com/in/<slug>\` URL, without query strings.
5. When no profile can be verified, or several conflict, leave the contact
   unchanged and report it as \`UNKNOWN\` with the reason.

Never treat these as profiles:

${s.bullets("notProfiles")}

End with one line per contact: ID, name, company, and either the recorded URL
with the evidence that matched, or \`UNKNOWN\` and why.
`;
  },

  "email-discovery": (setup) => {
    const s = reader(setup, "email-discovery");
    return `${header(setup, "Email discovery", "email-discovery")}
Process approved contacts whose \`email_status\` is \`UNKNOWN\` (and existing
\`EMAIL_NOT_FOUND\` results without a guess, only to add the guess). Do not draft
or send email, and never call Treg here; paid recovery is a separate,
human-triggered step.

## Find a published address

Search credible public sources for the contact's own professional business
address. The source page must display the exact address. Prefer:

${s.bullets("addressSources")}

Record exactly one outcome per contact:

- \`PUBLICLY_LISTED\`: the exact address is visibly published on a credible source.
- \`VERIFIED\`: the exact publicly sourced address has reliable evidence of
  current deliverability.
- \`EMAIL_NOT_FOUND\`: no reliable business address was found.

## Store one labelled guess when none is found

After recording \`EMAIL_NOT_FOUND\`, store at most one best guess with
\`recordEmailGuess\`, never in \`contacts.email\`. Use the company's email domain
(\`companies.email_domain\`, else \`companies.domain\`), never a personal email
provider.

Prefer a pattern demonstrated by another exact, publicly listed employee
address on the same domain (confidence \`PATTERN_SUPPORTED\`, with its URL).
Search these free sources once per domain first:

${s.bullets("patternEvidenceSources")}

Generic role addresses (\`hello@\`, \`info@\`, \`support@\`, \`careers@\`, \`press@\`)
do not demonstrate a personal pattern. Otherwise use the first fitting common
pattern: \`firstname\`, \`firstname.lastname\`, \`firstnamelastname\`,
\`firstinitiallastname\`, \`firstname_lastname\` (confidence \`COMMON_PATTERN\`, or
\`AMBIGUOUS\` when the name is uncertain). Lowercase ASCII; explain the choice in
\`basis\`.

## Fixed rules

- An inferred address is never public, verified, or sendable.
- Do not probe or send to any mailbox; the deterministic SMTP check runs after
  this workflow and only annotates the guess.
- Never invent an address or a source.
`;
  },

  "prospect-research": (setup) => {
    const s = reader(setup, "prospect-research");
    const product = reader(setup, "profile").text("productName");
    return `${header(setup, "Prospect research", "prospect-research")}
Use \`listResearchEligibleProspects(campaignId)\` and skip contacts that already
have \`getProspectResearch(contactId)\`. Never treat a guessed email as public,
verified, or deliverable.

Research deeply enough for one credible personalization angle. Find at most
three useful signals, preferring direct, recent public sources:

${s.bullets("signalTypes")}

Never count these as signals:

${s.bullets("notSignals")}

Read the actual source pages. Never invent dates, launches, titles, claims, or
problems. Keep verified facts separate from a plausible pain hypothesis.

Persist with \`saveProspectResearch\`:

- contactId
- signals: up to three {signal, sourceUrl, notes} objects
- strongestSignalIndex: zero-based index into signals
- painHypothesis: explicitly conditional, not a claim of known pain
- relevance: the specific relationship to ${product}
- notes: optional limitations or uncertainty

If no credible angle is found, use signals: [] and explain why in notes. This
stores NO_SIGNAL and blocks drafting. Do not manufacture an angle.
${s.flag("shareColleagueSignals")
    ? `
Research colleagues at the same company together. When a company-level signal
gives one contact a credible angle, reuse it for each colleague and tailor the
pain hypothesis and relevance to their role. Save NO_SIGNAL for a colleague only
when the angle genuinely does not fit them, and say why.
`
    : ""}
Write \`data/campaign-<id>-research.md\`. Do not generate emails, change approval
states, or send anything. Stop after research; the user selects contacts for
drafting in the dashboard.
`;
  },

  "email-generation": (setup) => {
    const s = reader(setup, "email-generation");
    const profile = reader(setup, "profile");
    return `${header(setup, "First-touch email generation", "email-generation")}
Process ONLY the contact IDs checked in the dashboard request. An empty
selection authorizes no drafting.

## Eligibility

1. The contact is in \`listEligibleProspects(campaignId)\`, with a sourced email or
   a separately stored guess. Never describe a guess as sourced or verified.
2. \`getProspectResearch(contactId).status\` is READY. Skip NO_SIGNAL.
3. The contact has no existing outreach of any status.

## The email

- Tone: ${s.text("tone")}.
- Prefer about ${s.num("targetWords")} words including the signature; never exceed ${s.num("maxWords")}.
- Subject: ${s.text("subjectRule")}.
- Reference exactly one verified prospect signal and store its research ID.
- Keep the use case conditional unless it is verified.

Structure, in order:

${s.bullets("structure", true)}

Sender context: ${s.text("senderContext")}

Call to action: ${s.text("callToAction")}

Sign off with exactly:

\`\`\`text
${profile.text("senderName")}
${profile.text("productWebsite")}
\`\`\`

Model the rhythm on this example without copying prospect facts:

\`\`\`text
${s.text("example")}
\`\`\`

Never use:

${s.bullets("bannedPhrases")}

If replacing the company name makes most of the email work for another
company, rewrite it. Never invent personalization or a previous relationship.

## Persistence

Use \`createOutreach({contactId, subject, body, researchId})\` to store one DRAFT.
For a requested rewrite, update only the specified DRAFT with
\`rewriteOutreach\`, apply the feedback, and keep the cited signal. Write
\`data/campaign-<id>-drafts.md\`. Never send, create Gmail drafts, or approve.
`;
  },

  "follow-up-generation": (setup) => {
    const s = reader(setup, "follow-up-generation");
    const profile = reader(setup, "profile");
    return `${header(setup, "Follow-up email generation", "follow-up-generation")}
Process ONLY the sent first-touch outreach IDs checked in the dashboard. An
empty selection authorizes no drafting.

1. Each ID must be a first touch with status SENT. Skip REPLIED and BOUNCED.
2. \`nextFollowUpStep(id)\` returns the sequence step to write (1 is the step
   after the first email), or undefined (skip). Only email steps are drafted.
3. Read the first touch, its cited signal, the prospect research, and every
   earlier follow-up in the thread, so a later email does not repeat them.

## Link

Each follow-up carries exactly one link: ${s.text("demoLink")}
${s.has("scenarios") ? `
Pick the scenario that matches the company's segment:

${s.bullets("scenarios")}
` : ""}
## Sequence

Each campaign has its own sequence (its Sequence tab): step 1 is the first email,
followed by up to 8 email or manual task steps, each after its own wait. The
drafting request lists, for every selected email, the step to write with its
name, length rule, and template. Follow those. Manual task steps (LinkedIn,
call, other) are done by the human and never drafted.

## Every follow-up email

- Start with \`Hi <first name>,\` and end with \`${profile.text("senderName")}\` and
  \`${profile.text("productWebsite")}\` on separate lines.
- Never claim the recipient read, opened, clicked, or ignored an earlier email.
  Do not guilt the recipient, fabricate urgency, or repeat feature lists.
- Mention only confirmed capabilities.
- Never use:

${s.bullets("bannedPhrases")}

## Persistence

Use \`createFollowUp({outreachId, body})\` to store one DRAFT; the subject, step,
and cited signal are set automatically so it threads under the first touch.
Write \`data/campaign-<id>-follow-ups.md\`. Never send, schedule, or approve.
Each step unlocks its wait after the previous step was sent or completed, and an
email step only after an explicit human send confirmation.
`;
  },
};

/** The stage prompt for a client, built from its inputs plus the fixed rules. */
export function buildStagePrompt(stageId: StageId, setup: ClientSetup): string {
  return STAGE_BUILDERS[stageId](setup);
}

/** Labels of the inputs a stage prompt still needs (empty text or list fields). */
export function missingInputs(sectionId: SectionId, setup: ClientSetup): string[] {
  const fields = getSection(sectionId)!.fields.filter((field) => {
    const value = setup[sectionId][field.key];
    return !field.optional && ((field.kind === "list" && (value as string[]).length === 0)
      || ((field.kind === "text" || field.kind === "textarea") && !String(value).trim()));
  }).map(({ label }) => label);
  return fields;
}

// ---------------------------------------------------------------------------
// Document builders

const notesBlock = (setup: ClientSetup, id: DocumentId): string => {
  const notes = String(setup[id].notes ?? "").trim();
  return notes ? `\n## Additional notes\n\n${notes}\n` : "";
};

/** Renders "name: use for → opens on" scenario lines as a table; other lines stay bullets. */
function scenarioTable(lines: string[]): string {
  const rows = lines.map((line) => line.match(/^(.+?):\s*(.+?)\s*→\s*(.+)$/));
  if (rows.some((row) => !row)) return lines.map((line) => `- ${line}`).join("\n");
  const cell = (value: string) => value.replaceAll("|", "\\|");
  return ["| Scenario (`s=`) | Use for | Opens on |", "| --- | --- | --- |",
    ...rows.map((row) => {
      const name = row![1]!.trim();
      return `| ${name.startsWith("(") ? cell(name) : `\`${cell(name)}\``} | ${cell(row![2]!)} | ${cell(row![3]!)} |`;
    })].join("\n");
}

const DOCUMENT_BUILDERS: Record<DocumentId, (setup: ClientSetup) => string> = {
  "doc-product": (setup) => {
    const profile = reader(setup, "profile");
    const d = reader(setup, "doc-product");
    const followUp = reader(setup, "follow-up-generation");
    const product = profile.text("productName");
    const demo = String(setup["doc-product"].demo ?? "").trim();
    const scenarios = setup["follow-up-generation"].scenarios as string[];
    const notYet = setup.profile.notYetAvailable as string[];
    return `# ${product} product profile

<!-- Generated from the client setup page. Edit the inputs there, not this file. -->

This file records product capabilities confirmed directly by the ${product}
owner. It is an authoritative internal source for company research and email
drafting, alongside these official sources. Last confirmed: ${d.text("lastConfirmed")}.

${d.bullets("officialSources")}

## Product shape

${profile.text("productSummary")}

## Confirmed capabilities

${profile.bullets("capabilities")}
${demo ? `
## Live demo

${demo}

Link format: \`${followUp.text("demoLink")}\`
${(setup["doc-product"].demoLinkRules as string[]).length ? `\n${d.bullets("demoLinkRules")}\n` : ""}${scenarios.length ? `\n${scenarioTable(scenarios)}\n` : ""}` : ""}
## Not yet available

${notYet.length ? `Do not mention these in outreach until this file lists them as confirmed:\n\n${profile.bullets("notYetAvailable")}` : "Nothing is listed. Still mention only the confirmed capabilities above."}

${d.text("claimLimits")}
${notesBlock(setup, "doc-product")}`;
  },

  "doc-icp": (setup) => {
    const profile = reader(setup, "profile");
    const d = reader(setup, "doc-icp");
    const company = reader(setup, "company-discovery");
    const contact = reader(setup, "contact-discovery");
    const product = profile.text("productName");
    const scoring = SCORE_FACTORS.map(([key, label, points]) => `| ${label} (\`${key}\`) | 0–${points} | ${company.text(`score_${key}`)} |`).join("\n");
    const paths = (setup["doc-icp"].qualificationPaths as string[]).length ? d.bullets("qualificationPaths", true) : d.bullets("qualificationPaths");
    return `# Conversion-oriented ICP

<!-- Generated from the client setup page. Edit the inputs there, not this file. -->

Product: ${product}

What it does: ${profile.text("productSummary")}

## Commercial objective

${d.text("objective")}

## Ideal customer profile

Priority segments:

${company.bullets("prioritySegments")}

Rank especially highly when a recent source shows:

${company.bullets("buildTriggers")}

## Company and buyer profile

Default geography (an explicit campaign segment may override it):

${company.bullets("defaultGeography")}

Preferred company shape:

${company.bullets("companyShape")}

Engineering headcount is \`UNKNOWN\` unless a public source states it; never infer
it from total headcount.

Preferred buyers, in order:

${contact.bullets("targetRoles", true)}

## Product fit

${d.text("productFit")}

Confirmed ${product} capabilities are defined only in PRODUCT.md.

## Qualification gate

A company qualifies only when public evidence establishes a real product,
audience, or workflow and supports one of these paths:

${paths}

Automatic qualifiers:

${company.bullets("automaticQualifiers")}

Every persisted company needs a thesis with two separate clauses:

> Observed: [specific sourced product, audience, or workflow]; hypothesis:
> ${product} may help with ${company.text("opportunity")}.

The observation is verified; the possible benefit is explicitly hypothetical.
For ${company.text("qualifyingFeature")}, \`NO_PUBLIC_EVIDENCE\` means a completed
public search found none. It is not proof of absence. \`UNKNOWN\` means the check
was incomplete.

## Conversion-priority tiers

### Tier 1 — pursue first

${d.bullets("tier1")}

### Tier 2 — pursue selectively

${d.bullets("tier2")}

### Tier 3 — research or nurture

${d.bullets("tier3")}

Tier 3 may be persisted for human review, but should not displace Tier 1 or
Tier 2 leads merely to reach a requested count.

## ICP scoring rubric (100 points)

Apply the qualification gate first. Unknown or unsupported evidence earns zero.
Do not double-count one source as proof of unrelated factors.

| Stored factor | Points | What earns points |
| --- | ---: | --- |
${scoring}

### Scoring calibration

${d.text("calibration")}

### Ranking rules

${d.bullets("rankingRules")}

## Research channels

${company.bullets("researchChannels")}

Jobs and community posts are leads, not proof. Verify company identity, domain,
affiliation, date, and product fit before persistence. Never contact a poster
during research.

## Negative and exclusion signals

Deprioritize:

${company.bullets("deprioritize")}

Exclude:

${company.bullets("exclusions")}

## Research and outreach discipline

${d.bullets("discipline")}
- Company discovery must not research or persist contacts.
- Store at most two contacts per company.
- Human review determines which companies and contacts proceed.
- Every first-touch email requires explicit approval.
${notesBlock(setup, "doc-icp")}`;
  },

  "doc-email-rules": (setup) => {
    const profile = reader(setup, "profile");
    const d = reader(setup, "doc-email-rules");
    const email = reader(setup, "email-generation");
    const followUp = reader(setup, "follow-up-generation");
    const product = profile.text("productName");
    const sources = reader(setup, "doc-product").bullets("officialSources");
    return `# Email Rules

<!-- Generated from the client setup page. Edit the inputs there, not this file. -->

## Objective and source of truth

${d.text("objective")}

Before drafting or rewriting, use PRODUCT.md and the latest official ${product}
sources as the source of truth:

${sources}

Never invent a ${product} capability, supported platform, customer, performance
claim, price, or comparison.

## Qualification before drafting

Re-check the prospect's product using first-party sources where possible:

${d.bullets("qualificationSources", true)}

${d.text("understand")}

Internally classify every selected prospect:

${d.bullets("prospectTypes")}

${d.text("qualifierPolicy")}

Form one evidence-based sales thesis before writing:

> ${d.text("thesis")}

## First-touch email

- Tone: ${email.text("tone")}.
- Prefer about ${email.num("targetWords")} words including the signature; never exceed ${email.num("maxWords")}.
- Subject: ${email.text("subjectRule")}.
- Open with \`Hi <first name>,\` on its own line, then the sourced observation.
- Reference exactly one verified prospect research signal and store its ID.
${d.bullets("typeGuidance")}
- Sender context: ${email.text("senderContext")}
- Call to action: ${email.text("callToAction")}
- Never invent previous contact or a personal relationship.

Structure:

${email.bullets("structure", true)}

Use this exact signature:

\`\`\`text
${profile.text("senderName")}
${profile.text("productWebsite")}
\`\`\`

Model the rhythm on this pattern without copying prospect facts between emails:

\`\`\`text
${email.text("example")}
\`\`\`

If replacing the company name makes most of the email work for another company,
rewrite it.

## Accuracy and wording

${d.text("accuracy")}

Never use:

${email.bullets("bannedPhrases")}

## Follow-up sequence rules

Each follow-up is its own outreach record linked to the first touch, replies in
the same thread (\`Re: <original subject>\`), keeps the first touch's cited
signal, and needs explicit human approval and send confirmation. Each campaign
has its own sequence (its Sequence tab): the steps after the first email, each
an email or a manual task with its own wait and template. Each step unlocks its
wait after the previous step was sent or completed, and no step runs once the
prospect is marked as replied or the first email bounced. A drafting request
lists the step to write.

Every follow-up email carries exactly one link (${followUp.text("demoLink")}),
never claims the recipient read, opened, clicked, or ignored an earlier email,
and never uses:

${followUp.bullets("bannedPhrases")}

### Default follow-up emails

A new campaign's sequence starts with these, ${followUp.num("delayDays")} day(s) apart. Each campaign can
then change its own steps.

#### ${followUp.text("followUp1Name")}

${followUp.text("followUp1Length")}.

\`\`\`text
${followUp.text("followUp1")}
\`\`\`
${String(setup["follow-up-generation"].followUp2 ?? "").trim() ? `
#### ${followUp.text("followUp2Name")}

${followUp.text("followUp2Length")}.

\`\`\`text
${followUp.text("followUp2")}
\`\`\`
` : ""}
## Persistence and human review

Record fit (\`HIGH\`, \`MEDIUM\`, or \`LOW\`), prospect type, the sales thesis, 2–4
sourced observations, the proposed workflow, and conversation context. For
\`LOW\` fit, record why it was skipped and do not create outreach. A public email
listing is not a personalization signal. Every generated or rewritten email
stays \`DRAFT\` until explicit human dashboard approval. Never send messages,
create Gmail drafts, or grant approval during generation or rewriting.
${notesBlock(setup, "doc-email-rules")}`;
  },
};

/** A client document (e.g. ICP.md) built from its inputs and related stage inputs. */
export function buildDocument(id: DocumentId, setup: ClientSetup): string {
  return DOCUMENT_BUILDERS[id](setup);
}
