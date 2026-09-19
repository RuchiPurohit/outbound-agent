# Initial ICP

Product:
ConvoKit

What it does:
Chat infrastructure developers integrate instead of building
messaging systems themselves.

## Company profile

Company types:

- B2B SaaS
- developer tools
- two-sided marketplaces
- on-demand and gig applications
- telehealth, coaching, and therapy platforms
- education and tutoring platforms
- fitness, habit, and accountability applications
- property, rental, coliving, and roommate platforms
- dating and community applications
- collaborative software and AI products with user-to-user interaction
- products introducing community or messaging functionality
- Flutter, mobile, and product-development agencies serving these segments
- FlutterFlow and low-code builders whose customers need a chat backend

Initial geography:

- United States
- Canada

Company size:

20-200 employees

Prefer seed through Series A companies. Engineering headcount is `UNKNOWN`
unless a public source states it; never infer it from total headcount.
Larger companies and enterprises are normally lower priority because their
procurement and platform requirements favor established enterprise vendors.

## Product shape

The best prospect wants chat as a feature, not as its product. Prefer teams that
want to own or customize the user interface while outsourcing conversations,
participants, message storage, access, realtime delivery, and operations.
Analytics/event integration and webhook requirements are useful buying signals.
ConvoKit's owner-confirmed product profile in `docs/PRODUCT.md` includes webhook
support, audit trails, custom UI, and Flutter, React web, and React Native support.

Channel partners are a distinct high-priority path. A mobile or Flutter agency
can introduce ConvoKit across multiple client applications. Qualify the agency's
relevant portfolio and delivery stack; do not assume an annual app volume or
offer a partner price unless a current, approved program documents it.

## Positive signals

Prioritize companies that:

- recently raised funding
- are hiring backend/platform engineers
- recently launched collaborative features
- have user-to-user communication
- have communities
- have marketplace interactions
- appear to be building messaging/chat functionality
- are seed through Series A and already live with users
- use Flutter, JavaScript/TypeScript, or React on a supported product surface
- expose a homegrown, limited, externally hosted, or missing chat experience
- have a current build/buy trigger such as a public chat implementation request
- are mobile/Flutter agencies repeatedly building apps in qualifying segments

## Priority use cases

- marketplace buyer ↔ seller around a listing, order, rental, or service
- customer ↔ provider during an on-demand job
- client ↔ clinician, coach, or therapist around a session or care workflow
- student ↔ tutor, or cohort members around a course or lesson
- coach ↔ client, or accountability group members around a plan or habit
- tenant ↔ landlord/property manager, or prospective roommates around a property
- members or matches communicating inside dating and community products

Regulated workflows may value isolation, access controls, audit trails, and
operational history. ConvoKit's product profile confirms participant access and
audit trails. Treat specific compliance, retention, and certification claims as
separate requirements that still need verification.

## Research channels

Use, but are not limited to:

- recent YC batches in marketplace, consumer, healthcare, and education
- Product Hunt launches from the last 90 days in the priority segments
- Launch Academy, VanHack, Spring Activator, and relevant Vancouver/mobile cohorts
- public Upwork or Fiverr jobs requesting Flutter/React chat or messaging
- attributable GitHub, Reddit, Indie Hackers, and Flutter community posts about
  building chat or dissatisfaction with Stream, Sendbird, CometChat, or Firebase

These are discovery sources, not automatic proof of a company or buying intent.
For job posts and community complaints, identify and verify the actual company,
domain, affiliation, product, and date before persistence. Never store an
anonymous poster as a company, infer private details, or contact/reply during
research. Prefer first-party company evidence for final qualification.

## Messaging-fit qualification

A company is qualified only when first-party evidence supports at least one of
these ConvoKit theses:

1. **Existing human messaging:** the product already contains meaningful
   human-to-human embedded messaging, messaging is not the company's core
   product/IP, and maintaining or expanding that surface is a credible
   engineering burden.
2. **Human messaging opportunity:** two identifiable human user roles already
   participate in a verified product workflow and have a concrete reason to
   communicate around a specific product object such as a project, order,
   booking, request, document, listing, transaction, or case.
3. **Automatic qualifying signal:** first-party evidence of comments, forums,
   support discussions, or collaboration inside the product; or a plausible,
   product-specific hypothesis that embedded chat could improve how users engage
   with a verified product workflow. These qualify for deeper research even when
   embedded chat, both participant roles, or internal demand are not yet public.

An automatic qualifier must still be anchored to a sourced product feature,
audience, or workflow. The possible benefit is a hypothesis, not a verified fact.

An AI assistant does not disqualify a company that independently passes a
human-to-human messaging path or the sourced automatic-qualifier path above.
Human-to-AI chat by itself is not evidence of human-to-human messaging.

## ICP scoring rubric (100 points)

Apply the qualification gate first, then assign integer points in each range.
Unknown or unsupported evidence earns zero for that factor. Store the six
component scores; the total is computed from them, not guessed separately.

| Factor | Points | What earns the upper end |
| --- | ---: | --- |
| Messaging workflow fit | 0–30 | Specific, sourced human interaction or strong sourced collaboration surface |
| Chat implementation opportunity | 0–20 | Sourced homegrown, limited, or external implementation with a credible build/buy angle; `NONE_FOUND` alone earns little |
| Timely buying signal | 0–15 | Recent sourced launch, implementation request, hiring, or attributable vendor complaint |
| Team/stage fit | 0–15 | Sourced seed–Series A stage and sourced total headcount aligned with the campaign |
| Supported stack fit | 0–10 | Sourced Flutter, React web, or React Native implementation |
| Live-product evidence | 0–10 | Public evidence that real users can use the product now |

Calibration examples (not extra points):

- `workflowFit`: 0 without a sourced product workflow; roughly 5–10 for a
  sourced comment surface or product-specific engagement hypothesis without
  named participants; 15–20 for named human roles and a concrete object; 25–30
  for a directly evidenced human-to-human messaging workflow relevant to ConvoKit.
- `chatImplementation`: 0 for `UNKNOWN` or `NONE_FOUND` alone; roughly 5–10
  for a documented vendor or external channel with a specific limitation;
  15–20 for a sourced homegrown implementation with a credible maintenance or
  expansion burden. Do not infer homegrown from appearance alone.
- `timingSignal`: 0 without a dated signal; roughly 5 for relevant hiring,
  10 for a recent workflow launch, and 15 for a current sourced request to
  build messaging. A recent date without messaging relevance earns little.
- `teamFit`: 0 if stage and headcount are unsupported; roughly 7 when only one
  is sourced and aligned; up to 15 when both are sourced and fit the segment.

Use the remaining stack and live-product ranges as stated in the table. Explain
borderline scores in the company report; do not double-count one source as
proof of unrelated factors.

Do not treat `NONE_FOUND` chat implementation as proof that a company has no
chat. A generic engagement hypothesis may qualify under the gate above, but
earns few workflow-fit points until the interaction is made concrete.

Geography is an eligibility filter: use the campaign segment when it explicitly
overrides location; otherwise require United States or Canada. Record the
location and its source. Do not add hidden geographic score points or assume
Vancouver/Pacific-time preference unless requested for a campaign.

## Negative signals

Deprioritize:

- very large companies
- companies whose messaging infrastructure is clearly core IP
- general agencies or consultancies without a relevant mobile/product portfolio
- companies with no obvious need for realtime communication

Exclude entirely:

- AI assistants, copilots, chatbots, or human-to-AI chat when no separate
  human-to-human or sourced automatic-qualifier path exists
- products where messaging, chat, or realtime collaboration is already the
  mature core product or clear core IP
- prospects that require unverified ConvoKit capabilities, including AI-agent
  orchestration

Use a concrete core-IP test: inspect the homepage headline and primary pricing
page. Exclude when they sell messaging, community, or collaboration itself as
the primary product and there is no distinct non-messaging workflow ConvoKit
would support. A marketplace or community app that uses messaging as one
feature is not excluded merely because its homepage mentions communication.
Record the exclusion reason and source in the discovery report.

## Target roles

1. CTO / Technical Founder
2. VP Engineering / Head of Engineering
3. Staff / Principal Engineer
4. Engineering Manager

Maximum:

2 contacts per company.
