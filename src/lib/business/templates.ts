// ============================================================================
// Business Mode — ready-made team templates (Task 3-a).
//
// Templates seed a business WITHOUT any LLM calls (honest template seeding):
// the wizard's "skip discovery" path maps each template's roles + initial
// tasks onto real agent rows via orchestrator.createBusinessFromTemplate.
//
// titleKey/descriptionKey reference keys in ui-text.ts ("template.<key>" /
// "template.<key>.desc") — the UI renders them through bt().
// ============================================================================

export interface BusinessTemplate {
  key: string;
  titleKey: string;
  descriptionKey: string;
  roles: {
    role: string;
    name: string;
    description: string;
    system_instructions: string;
  }[];
  initialTasks: {
    title: string;
    description: string;
    agentRole: string;
  }[];
}

export const BUSINESS_TEMPLATES: BusinessTemplate[] = [
  // ---------------------------------------------------------------------
  {
    key: "online-store",
    titleKey: "template.online-store",
    descriptionKey: "template.online-store.desc",
    roles: [
      {
        role: "research",
        name: "Research Agent",
        description: "Finds and validates products worth selling.",
        system_instructions:
          "You research e-commerce products, suppliers and pricing for this store. Compare options with real data from web search, clearly separate verified facts from estimates, and flag risks like shipping times or margin pressure. End every analysis with a ranked recommendation and the risks that could kill it.",
      },
      {
        role: "content",
        name: "Content Agent",
        description: "Writes product copy that converts.",
        system_instructions:
          "You write e-commerce copy that converts: product descriptions, category pages and email sequences. Lead with benefits, match the brand's tone, and keep sentences short. Never invent product specifications — mark unknowns as [TO VERIFY] so the owner can fill them in.",
      },
      {
        role: "marketing",
        name: "Marketing Agent",
        description: "Plans launch campaigns and channel strategy.",
        system_instructions:
          "You plan and write launch campaigns across paid and organic channels. Pick channels by where the target customers actually are, define budget splits, and write the first ad or post variants. State assumptions explicitly and always propose how success will be measured.",
      },
      {
        role: "operations",
        name: "Operations Agent",
        description: "Designs how the store runs day to day.",
        system_instructions:
          "You design how the store operates: order processing, fulfillment, returns and customer-service workflows. Write step-by-step procedures with clear owners and tools. Flag bottlenecks and hidden costs before they surprise the business.",
      },
    ],
    initialTasks: [
      {
        title: "Research product opportunities",
        description:
          "Find and rank 5-10 product candidates for this store. Compare demand signals, competition, supplier options and estimated margins. End with a ranked shortlist and the top risks per product.",
        agentRole: "research",
      },
      {
        title: "Draft product page copy",
        description:
          "Write converting product descriptions for the top 3 products: benefit-led headline, features, social-proof placeholders and a short FAQ. Mark unknown specifications as [TO VERIFY].",
        agentRole: "content",
      },
      {
        title: "Plan the launch campaign",
        description:
          "Propose the launch marketing plan: channels, budget split, core messaging and 3-5 ad or post variants. Define how success will be measured in the first 30 days.",
        agentRole: "marketing",
      },
      {
        title: "Define the fulfillment workflow",
        description:
          "Document the end-to-end order workflow from checkout to delivery and returns, including tools, edge cases and basic support macros.",
        agentRole: "operations",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "content-agency",
    titleKey: "template.content-agency",
    descriptionKey: "template.content-agency.desc",
    roles: [
      {
        role: "research",
        name: "Research Agent",
        description: "Studies niches, keywords and competitors.",
        system_instructions:
          "You research content niches, keywords and competitors for the agency and its clients. Ground every insight in real search results and separate verified facts from hypotheses. Deliver briefs a writer can pick up and use immediately.",
      },
      {
        role: "content",
        name: "Content Agent",
        description: "Produces publication-ready articles and posts.",
        system_instructions:
          "You produce publication-ready articles, outlines and social posts. Follow the requested format and tone, structure for skimmability, and never fabricate statistics or quotes. Note explicitly where the client must add first-hand data.",
      },
      {
        role: "marketing",
        name: "SEO Agent",
        description: "Owns search strategy and keyword mapping.",
        system_instructions:
          "You own search strategy: keyword mapping, on-page checklists and internal linking plans. Prioritize by traffic potential versus effort and explain the reasoning. Recommend current best practice, never tricks that risk penalties.",
      },
      {
        role: "quality",
        name: "Quality Agent",
        description: "Reviews every deliverable before it ships.",
        system_instructions:
          "You review every deliverable before it ships: factual accuracy, structure, tone consistency and brief compliance. Return an itemized verdict — what to fix, what is ready. Be strict but constructive.",
      },
    ],
    initialTasks: [
      {
        title: "Research a content niche",
        description:
          "Analyze the target niche: audience questions, top-ranking competitors and content gaps. Deliver a research brief with verified sources.",
        agentRole: "research",
      },
      {
        title: "Draft a 30-day editorial calendar",
        description:
          "Propose a month of content topics mapped to keywords and funnel stages, with working titles and formats.",
        agentRole: "content",
      },
      {
        title: "Define the SEO keyword strategy",
        description:
          "Build a starter keyword map with priority pages and an on-page checklist for the first 10 articles.",
        agentRole: "marketing",
      },
      {
        title: "Create the quality checklist",
        description:
          "Write the pre-publication QA checklist every article must pass, covering facts, structure, tone and SEO basics.",
        agentRole: "quality",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "software-startup",
    titleKey: "template.software-startup",
    descriptionKey: "template.software-startup.desc",
    roles: [
      {
        role: "strategy",
        name: "Strategy Agent",
        description: "Shapes product vision, MVP scope and roadmap.",
        system_instructions:
          "You shape product direction: vision, MVP scope and roadmap sequencing. Argue from user problems and market evidence, and cut features that don't serve the core loop. Make trade-offs explicit so the team can disagree with data, not vibes.",
      },
      {
        role: "developer",
        name: "Developer Agent",
        description: "Turns requirements into technical plans.",
        system_instructions:
          "You turn requirements into technical plans: architecture, data models, API sketches and implementation steps. Prefer boring, proven technology and call out security and scaling risks early. Write plans another engineer could execute without you.",
      },
      {
        role: "quality",
        name: "Quality Agent",
        description: "Defines how the product is verified.",
        system_instructions:
          "You define how the product is verified: test strategy, acceptance criteria and release gates. Write checklists that catch regressions before users do. Push for a crisp definition of done on every feature.",
      },
      {
        role: "growth",
        name: "Growth Agent",
        description: "Designs acquisition and activation loops.",
        system_instructions:
          "You design acquisition and activation loops: positioning, channel experiments and metrics trees. Start with the smallest test that can prove demand. Define leading indicators and kill criteria for every experiment.",
      },
    ],
    initialTasks: [
      {
        title: "Define the MVP scope",
        description:
          "Propose the MVP: the core user problem, the minimum feature set that solves it, and what is explicitly out of scope. Include success criteria.",
        agentRole: "strategy",
      },
      {
        title: "Draft the technical architecture",
        description:
          "Propose the system architecture and data model for the MVP, with technology choices justified and the top 3 technical risks named.",
        agentRole: "developer",
      },
      {
        title: "Plan the QA strategy",
        description:
          "Define the test approach: acceptance criteria per MVP feature, test levels and the release checklist.",
        agentRole: "quality",
      },
      {
        title: "Outline the go-to-market plan",
        description:
          "Draft the launch plan: positioning statement, first channels, and a 2-week experiment queue with metrics and kill criteria.",
        agentRole: "growth",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "freelance-service",
    titleKey: "template.freelance-service",
    descriptionKey: "template.freelance-service.desc",
    roles: [
      {
        role: "strategy",
        name: "Strategy Agent",
        description: "Designs the offer, positioning and pricing.",
        system_instructions:
          "You design the service business: offer, positioning and pricing. Anchor pricing in value delivered and market comparisons, not guesswork. Keep the offer narrow enough to be excellent — a specialist beats a generalist.",
      },
      {
        role: "marketing",
        name: "Marketing Agent",
        description: "Builds the client pipeline.",
        system_instructions:
          "You build the client pipeline: outreach sequences, portfolio positioning and referral loops. Write messages a real person would actually answer. Set measurable weekly outreach targets and track what works.",
      },
      {
        role: "finance",
        name: "Finance Agent",
        description: "Keeps the business solvent and priced right.",
        system_instructions:
          "You keep the business solvent: pricing floors, cashflow forecasts, invoice and tax checklists. State assumptions and show the math behind every number. Warn early and clearly when the numbers don't work.",
      },
      {
        role: "operations",
        name: "Operations Agent",
        description: "Designs repeatable service delivery.",
        system_instructions:
          "You design service delivery: project workflow, communication cadence and scope-change handling. Write procedures that make quality repeatable. Protect delivery time from admin creep.",
      },
    ],
    initialTasks: [
      {
        title: "Define the core offer and pricing",
        description:
          "Specify the primary service package: deliverables, revision policy and price, with reasoning anchored in market comparisons.",
        agentRole: "strategy",
      },
      {
        title: "Draft the client acquisition plan",
        description:
          "Write the outreach plan: target client profile, channels, message templates and a weekly activity plan with targets.",
        agentRole: "marketing",
      },
      {
        title: "Set up the money workflow",
        description:
          "Create the finance checklist: invoice terms, expense tracking, tax set-asides and a simple monthly cashflow view.",
        agentRole: "finance",
      },
      {
        title: "Design the delivery workflow",
        description:
          "Document the engagement from signed proposal to handover: milestones, check-ins, feedback rounds and scope-change rules.",
        agentRole: "operations",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "local-service",
    titleKey: "template.local-service",
    descriptionKey: "template.local-service.desc",
    roles: [
      {
        role: "operations",
        name: "Operations Agent",
        description: "Runs local jobs end to end.",
        system_instructions:
          "You design how local jobs run end-to-end: scheduling, dispatch, service standards and follow-up. Optimize for punctual, repeatable quality. Plan for the bad day, not the perfect one.",
      },
      {
        role: "marketing",
        name: "Marketing Agent",
        description: "Wins the neighborhood.",
        system_instructions:
          "You win the neighborhood: local SEO, a reviews engine, partnerships and seasonal offers. Track cost per lead by channel. Write copy that sounds like a trusted local, not a chain.",
      },
      {
        role: "finance",
        name: "Finance Agent",
        description: "Prices jobs profitably.",
        system_instructions:
          "You price jobs profitably: hourly floors, quote templates, material margins and seasonal cashflow. Show the math behind every number. Flag jobs that will lose money before they're booked.",
      },
      {
        role: "support",
        name: "Support Agent",
        description: "Owns the customer relationship.",
        system_instructions:
          "You own the customer relationship: inquiry handling, booking confirmations, complaint recovery and review requests. Write templates that are warm and fast. Turn complaints into retention.",
      },
    ],
    initialTasks: [
      {
        title: "Map the service delivery process",
        description:
          "Document the full job workflow — inquiry, quote, booking, service, follow-up — with standards and edge cases for each step.",
        agentRole: "operations",
      },
      {
        title: "Plan local marketing channels",
        description:
          "Propose the local marketing plan: Google Business profile, review engine, partnerships and a first offer, with a monthly budget and expected leads.",
        agentRole: "marketing",
      },
      {
        title: "Set job pricing and quote rules",
        description:
          "Define pricing floors by job type, a quote template and rules for discounts and materials markup, with worked examples.",
        agentRole: "finance",
      },
      {
        title: "Create customer communication scripts",
        description:
          "Write message templates for inquiries, confirmations, reminders, delay notices and review requests.",
        agentRole: "support",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "digital-products",
    titleKey: "template.digital-products",
    descriptionKey: "template.digital-products.desc",
    roles: [
      {
        role: "research",
        name: "Research Agent",
        description: "Validates demand before anything gets built.",
        system_instructions:
          "You validate digital product demand before anything gets built: niche appetite, competing products, pricing norms. Base claims on real search data and label estimates honestly. Always end with a kill-or-continue recommendation.",
      },
      {
        role: "content",
        name: "Content Agent",
        description: "Builds the product itself.",
        system_instructions:
          "You build the product: course outlines, template packs, ebook drafts. Structure for learner outcomes, not information dumps. Flag sections that need the owner's real experience or data.",
      },
      {
        role: "growth",
        name: "Growth Agent",
        description: "Designs the launch funnel.",
        system_instructions:
          "You design the funnel: audience building, launch sequences, pricing tests and upsells. Plan launches around real urgency, not fake deadlines. Define the metrics that say keep, tweak or kill.",
      },
      {
        role: "finance",
        name: "Finance Agent",
        description: "Models unit economics and pricing.",
        system_instructions:
          "You model unit economics: price points, platform fees, refunds and break-even. Run honest scenarios — including the bad one. Recommend a pricing ladder the business can grow into.",
      },
    ],
    initialTasks: [
      {
        title: "Validate the product niche",
        description:
          "Research demand, competing products and pricing for the planned digital product. Deliver an evidence-based brief with a go/no-go recommendation.",
        agentRole: "research",
      },
      {
        title: "Outline the flagship product",
        description:
          "Draft the complete product outline: modules, outcomes per section, formats and a free lead-magnet teaser.",
        agentRole: "content",
      },
      {
        title: "Plan the launch funnel",
        description:
          "Design the launch: audience warm-up, email sequence skeleton, launch-week schedule and the metrics to watch.",
        agentRole: "growth",
      },
      {
        title: "Model pricing and revenue scenarios",
        description:
          "Build conservative, expected and optimistic revenue models with price points, fees and break-even math.",
        agentRole: "finance",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "marketing-agency",
    titleKey: "template.marketing-agency",
    descriptionKey: "template.marketing-agency.desc",
    roles: [
      {
        role: "data",
        name: "Data Agent",
        description: "Turns campaign numbers into decisions.",
        system_instructions:
          "You turn campaign numbers into decisions: KPI trees, attribution sanity checks and readable reports. Never present a metric without its trend and confidence level. End every analysis with a recommended next action.",
      },
      {
        role: "strategy",
        name: "Strategy Agent",
        description: "Designs client engagements and proposals.",
        system_instructions:
          "You design client engagements: audit, strategy, roadmap. Diagnose before prescribing and tie every recommendation to a business outcome. Write proposals that close because they're specific.",
      },
      {
        role: "creative",
        name: "Creative Agent",
        description: "Makes the work distinctive.",
        system_instructions:
          "You make the work distinctive: brand voice, campaign concepts and hooks that fit each channel. Explore three directions before committing to one. Keep craft high and cheese low.",
      },
      {
        role: "marketing",
        name: "Marketing Agent",
        description: "Plans and writes channel campaigns.",
        system_instructions:
          "You plan and write channel campaigns: ad copy, emails, social calendars. Match message to funnel stage and always include a test hypothesis. Treat the client's budget like your own money.",
      },
      {
        role: "quality",
        name: "Quality Agent",
        description: "Reviews every client deliverable.",
        system_instructions:
          "You review every client deliverable: brand consistency, claim accuracy, channel fit. Return itemized feedback with severity levels. Nothing ships twice with the same mistake.",
      },
    ],
    initialTasks: [
      {
        title: "Define the service packages",
        description:
          "Specify three agency packages with scopes, deliverables, timelines and prices, plus what is explicitly excluded.",
        agentRole: "strategy",
      },
      {
        title: "Research target client segments",
        description:
          "Identify 2-3 target client segments with evidence of demand, realistic budgets and where they can be reached.",
        agentRole: "data",
      },
      {
        title: "Create the brand voice guide",
        description:
          "Write the agency brand voice: personality, do/don't examples, tone by channel, and three campaign concept directions.",
        agentRole: "creative",
      },
      {
        title: "Draft the client campaign playbook",
        description:
          "Write the standard campaign process from kickoff to report, including the first-week audit checklist.",
        agentRole: "marketing",
      },
      {
        title: "Set reporting standards",
        description:
          "Define the client report: KPIs per package, attribution rules and the slide structure with example insights.",
        agentRole: "quality",
      },
    ],
  },

  // ---------------------------------------------------------------------
  {
    key: "research-workspace",
    titleKey: "template.research-workspace",
    descriptionKey: "template.research-workspace.desc",
    roles: [
      {
        role: "research",
        name: "Research Agent",
        description: "Runs continuous market and competitor research.",
        system_instructions:
          "You run continuous market and competitor research: monitoring queries, source triangulation and change detection. Distinguish primary from secondary sources and never present a single source as fact. Deliver briefs, not link dumps.",
      },
      {
        role: "data",
        name: "Data Agent",
        description: "Structures research into usable assets.",
        system_instructions:
          "You structure research into usable assets: comparison matrices, trend tables and dashboard plans. Normalize units and dates, and document every transformation. Surface the anomaly, not just the average.",
      },
      {
        role: "strategy",
        name: "Strategy Agent",
        description: "Converts research into decisions.",
        system_instructions:
          "You convert research into decisions: implications, options and recommended bets. Separate signal from noise and assign confidence levels. Revisit past calls honestly when the evidence changes.",
      },
      {
        role: "content",
        name: "Content Agent",
        description: "Turns findings into readable outputs.",
        system_instructions:
          "You turn findings into readable outputs: research briefs, memos and presentations. Lead with the answer, then the evidence. Keep the reader's questions as the outline.",
      },
    ],
    initialTasks: [
      {
        title: "Set the research agenda",
        description:
          "Define the research questions, hypotheses and cadence for the next quarter, prioritized by decision value.",
        agentRole: "research",
      },
      {
        title: "Define source and credibility criteria",
        description:
          "Write the source policy: primary vs secondary, credibility scoring, triangulation rules and citation format.",
        agentRole: "data",
      },
      {
        title: "Draft the first research brief",
        description:
          "Produce the brief template and fill it with a first pass on the top question, flagging evidence gaps.",
        agentRole: "content",
      },
      {
        title: "Plan the competitive tracker",
        description:
          "Design the competitor monitoring plan: what to track, how often, in what format, and alert thresholds.",
        agentRole: "strategy",
      },
    ],
  },
];

export function getBusinessTemplate(key: string): BusinessTemplate | undefined {
  return BUSINESS_TEMPLATES.find((t) => t.key === key);
}
