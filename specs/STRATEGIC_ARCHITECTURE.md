# OnlyiGaming Content Creation Tool — Strategic Architecture

> **Version:** 1.0 — February 7, 2026
> **Purpose:** This document describes the intent, principles, and end goal of the Content Creation Tool. It preserves the context and reasoning behind every architectural decision so that future developers, AI assistants, and team members understand not just what to build, but why.
> **Audience:** Anyone making decisions about this project — developers, designers, strategists, and AI coding assistants.
> **Status:** This is the governing strategic document. Companion documents handle implementation detail.

---

## Part 1: What We're Building and Why

### The Platform

OnlyiGaming is a B2B directory and content platform for the iGaming industry. It integrates eight sections — directory (80+ company categories), news, marketplace (M&A hub and project board), consultants (freelancer marketplace), media (multimedia with calendar), events (conferences with calendar), career (job board), and community (forums). Everything connects through a 4-layer tagging system with 335+ tags. A company like Evolution Gaming appears across directory listings, news articles, job postings, event coverage, consultant profiles, and community discussions — all linked by tags.

The platform runs on Strapi CMS with a Plasmic frontend migration underway. The team is Danne (strategy/product), Bojan (developer), Felipe (UX/UI), Stefan (SEO), and Joseph (design), working with freelancers rather than full-time developers.

### The Content Problem

OnlyiGaming needs content at scale. Hundreds of company profiles. News coverage. Directory descriptions. Podcast show notes. FAQ sections for 80+ categories. Each piece of content requires research, source gathering, writing, quality review, formatting, and distribution to the right systems (Strapi, Google Docs, spreadsheets).

Doing this manually doesn't scale. Doing it with disconnected scripts doesn't produce consistent quality. What's needed is a tool — operated by a human — that handles the mechanical parts (finding sources, fetching pages, assembling data, formatting output) while keeping the human in control of the creative and editorial decisions.

### The Content Creation Tool

This is not a pipeline in the factory sense — it's a tool that a human operator uses to create content intelligently. The operator decides what to make, which sources to use, what quality threshold to accept, and when to publish. The tool handles the tedious parts: crawling sitemaps, fetching pages, cleaning HTML, assembling source packages, calling LLMs, formatting output, pushing to CMS.

The tool follows an 11-step sequence. Not every content piece uses every step, but the order never changes. The steps are:

| Step | Name | What It Does |
|------|------|-------------|
| 0 | Project Start | Define what we're making — content type, entities, template selection |
| 1 | Discovery | Find candidate URLs and seed data from multiple sources |
| 2 | Pre-Scrape Validation | Filter out junk URLs before paying the cost to fetch them |
| 3 | Scraping | Fetch actual page content using the right method per source |
| 4 | Filtering & Assembly | Clean, deduplicate, and assemble source packages |
| 5 | Analysis & Generation | Analyze sources and generate output content (LLM costs here) |
| 6 | Quality Assurance | Verify generated content meets standards |
| 7 | Routing | Decide what happens to items that don't pass — rework, reroute, or discard |
| 8 | Bundling | Package approved content into delivery formats |
| 9 | Distribution | Push to external systems — Strapi, Google Docs, Sheets |
| 10 | Review | Final human gate before publication |

Company profiles are the first use case, not the only one. The architecture is designed so that the same skeleton supports any content type — present and future.

---

## Part 2: Why Modular — The Developer's Focus Belongs on Submodules

The Content Creation Tool is modular not because modularity is trendy, but because of a simple question: **when a developer sits down to work on this tool, what should they be thinking about?**

The answer: the task at hand. Making a scraper better. Tuning an LLM prompt. Adding a new discovery source. Building a video script generator. Integrating a cheaper API.

They should not be thinking about database connections, job queue configuration, React component architecture, or how steps pass data to each other. That's plumbing. It's essential, but once it works, it should disappear from the developer's world entirely. Every minute a developer spends on plumbing is a minute not spent on the actual content logic that makes the tool useful.

Modularity exists to protect that focus. The skeleton handles plumbing. The developer handles submodules. These two concerns live in separate mental spaces — and, as Part 8 will explain, in separate physical spaces.

### New tools appear constantly

The AI landscape changes month to month. New LLMs with different strengths and price points. New APIs for company data. New scraping services that solve problems current tools can't. New embedding models. New search APIs. Each of these is a potential submodule. The architecture must make it trivial to plug in a new tool, test it alongside existing ones, compare results against historical data, and promote it or discard it — without touching anything else.

### Cheaper solutions emerge

What costs $0.10 per call today might cost $0.01 next year, or a free open-source alternative might appear. The system should make it easy to swap one implementation for another at the submodule level. A cheaper LLM that produces equivalent output? Replace the submodule. A free sitemap parser that's faster? Replace the submodule. The skeleton doesn't care which submodule runs — it cares that the contract is honored.

### New tasks will appear that we haven't imagined yet

Today the tool creates company profiles and news articles. Tomorrow it might need to:

- Generate comparison pages between competing companies
- Produce video scripts from research sources
- Create social media content packages for multiple platforms
- Build landing pages from templates and research data
- Generate image briefs and creative directions for designers
- Assemble investor reports from financial data sources
- Produce podcast show notes from transcripts
- Create training materials from documentation

Each of these is a different combination of discovery, processing, generation, and distribution — but they all follow the same fundamental flow: find sources → process sources → generate output → review → distribute. The 11-step sequence is general enough to accommodate content types that don't exist yet. A video production task might skip Steps 2-3 and use Step 5 for script generation. An image brief might use Step 1 for reference discovery and Step 5 for brief generation. The steps are containers. What goes in them changes. The containers don't.

### The tool should be open to entirely new domains

The iGaming directory is the first use case, but the architecture doesn't hardcode anything iGaming-specific into the skeleton. The skeleton knows about steps, submodules, entities, approvals, and data flow. It doesn't know about company profiles, sitemaps, or Strapi. This means the same tool could theoretically handle content creation for any industry, any platform, any content type — by swapping modules.

### What modularity actually requires

For modularity to be real and not just aspirational, it requires:

1. **A stable skeleton that never changes.** If adding a new submodule requires modifying the skeleton, modularity is an illusion. The skeleton must be complete enough to handle any submodule that follows the contract, without modification.

2. **A clear contract between skeleton and modules.** Every submodule must know exactly what it receives (input, options, tools) and what it must return (results). The skeleton must know exactly how to load, execute, and display any module that honors this contract.

3. **Physical enforcement of boundaries.** If the architecture depends on rules in markdown files and code comments being followed, there will always be a risk moment. Every development session becomes a gamble — will the boundaries hold, or will they be crossed under pressure? Physical separation in two repositories makes boundary violations impossible rather than merely discouraged. Part 8 explains the specific failure pattern that proved this necessity.

---

## Part 3: The Core Insight

> "Each step is a silo. Each submodule is a silo. The magic lies only in how we connect them."

This is the architectural principle that everything else derives from. Complexity should exist only in the connections between components, not within the components themselves.

A submodule is a pure function — it receives input, processes it, returns output. It doesn't know about databases, queues, or other submodules.

A step is a container — it runs submodules, collects results, and writes approved output to the database. It doesn't know what the submodules do.

The tool is steps chained through a database — each step reads the previous step's output, runs its submodules, and writes its own output. No step knows about any other step.

This means:

- Adding a new submodule requires zero infrastructure changes — just create a file with the right format
- Adding a new step requires zero changes to existing steps — just add a container
- Fixing a submodule bug cannot break another submodule or the step that contains it
- A new LLM, scraper, or API becomes just another submodule — plug it in, test it, keep it or discard it
- Infrastructure changes cannot accidentally happen while working on module logic

---

## Part 4: Three Principles

### Principle 1: Submodules Are Pure Functions

A submodule declares what it needs and what it does. The skeleton handles everything else.

```javascript
module.exports = {
  id: 'sitemap',
  name: 'Sitemap Parser',
  category: 'website',
  step: 1,
  cost: 'cheap',
  options: [
    { name: 'max_urls', type: 'number', default: 1000 },
    { name: 'include_images', type: 'boolean', default: false }
  ],
  execute: async (input, options, tools) => results
}
```

The contract:

- **No database access.** Submodules never import Supabase, never write to tables, never read from tables. All data arrives through `input` and leaves through `results`.
- **No queue manipulation.** Submodules don't know BullMQ exists. They don't create jobs, check job status, or manage workers.
- **No imports from skeleton infrastructure.** The only bridge to the outside world is the `tools` object, which provides: `logger` (log messages), `http` (fetch URLs), `progress` (report execution progress to the UI).
- **Declarative UI.** The `options` array declares what configuration the submodule accepts. The skeleton renders the appropriate form fields (toggles, dropdowns, number inputs, text fields) without knowing what the options mean.

This means a freelancer can build a new submodule without understanding how Supabase, Redis, or BullMQ work. They write a function, declare its interface, and the skeleton handles orchestration, persistence, and UI.

This also means submodules are testable in isolation — pass input, get output, verify. No need to spin up databases, queues, or servers.

### Principle 2: Physical Separation Protects Stability

The house metaphor:

| Skeleton (Build Once, Freeze) | Furniture (Add Anytime, Swap Anytime) |
|------|------|
| Electrical wiring | Lamps, TV, appliances |
| Plumbing pipes | Toilet, sink, shower |
| Doors between rooms | What's in each room |
| Light switches | What the lights illuminate |

Translated to the Content Creation Tool:

| Skeleton | Furniture |
|------|------|
| Supabase connection + schema | What data gets written |
| Step-to-step data flow | What each step does with data |
| Approval CTA mechanism | What gets approved |
| Generic StepPanel shell | What UI each step shows |
| Module loading system | Actual module logic |
| Tools object interface | Which tools modules use |

**Two repositories:**

- **Repo 1 (Skeleton):** The house — walls, wiring, plumbing, doors. Built once, tested, then frozen. Contains: server.js, routes, services, workers, shared React components, hooks, stores, SQL schema.
- **Repo 2 (Modules):** The furniture — what goes in each room. Active development. Contains: individual submodule folders, each with a manifest and an execute function.

When a developer (human or AI) works on Repo 2, Repo 1 is physically separate. They cannot accidentally modify database connections, queue setup, or step flow while debugging a scraper. The skeleton doesn't change because a new module is being built. The skeleton doesn't change because a new LLM API is being integrated. The skeleton doesn't change because the tool is expanding from text content to video production.

**The trade-off is real.** When a feature genuinely requires changes to both infrastructure and modules (estimated 1-2 times per month), it requires coordinating across two repositories — roughly 30 minutes of extra friction per cross-boundary change. Part 8 explains why this trade-off is overwhelmingly worth it.

### Principle 3: The System Learns and Gets Smarter Over Time

Several steps in the tool make subjective decisions: Is this URL worth scraping? Is this generated content good enough? Should this failed item be rerouted or discarded? In v1, a human makes all these decisions. But the system should get smarter with use — not just cheaper, but genuinely better across four dimensions.

**1. Financial — Every run gets cheaper.**
Without learning, every run pays full price: every URL gets scraped (even ones that always produce junk), every LLM call runs at maximum effort (even for simple entities), every result gets full human review (even ones that are obviously fine). With learning, the system identifies patterns: "URLs matching this pattern from this domain are always junk — skip them." "Company profiles for this category consistently pass QA at this prompt configuration — auto-approve." Each run costs less than the last.

**2. Quality — Output improves with accumulated knowledge.**
A human reviewer doesn't just approve or reject — they notice patterns. "The profiles generated for payment providers always miss regulatory information." "News summaries from this source tend to be too promotional." When these observations are captured and fed back, the system produces better first drafts. Generation prompts get tuned per content type. Quality thresholds get calibrated per category. The 50th company profile is better than the 5th because the system has learned what "good" looks like for that category.

**3. Tool Selection — Different challenges need different tools.**
Not every entity needs the same discovery approach. A large publicly-traded company has rich sitemaps, LinkedIn presence, news coverage, and financial filings. A small startup might only have a basic website and a Crunchbase entry. The system should learn which combination of submodules works best for which type of entity. "For companies in the payment provider category with enterprise clients, Sitemap + LinkedIn + News gives the best source package." This is routing intelligence — matching the right tools to each challenge.

**4. Future-proofing — New tools and LLMs plug in naturally.**
Because the system logs every decision and its outcome, a new tool can be evaluated against historical data: "Would this new LLM have produced better results for the 200 company profiles we generated last month?" The submodule architecture means new tools are just new modules — plug them in, run them alongside existing ones, compare results, promote or discard. The system's learning history makes this comparison possible and measurable.

**How this works in practice — the calibration pattern:**

- **v1 (Ship First):** Human reviews everything. Every decision is logged with reasons — which URLs were approved/rejected, which content passed/failed QA, which items were rerouted. This logging is not optional. It's the foundation everything else builds on.
- **Next:** System analyzes logged decisions and proposes rules. "You've rejected 94% of URLs matching `/tag/*` on casino news sites. Should I auto-reject these?" Human approves or rejects the proposed rule.
- **Later:** Approved rules run in shadow mode — the system applies them but still shows results to the human for confirmation. Rules matching human decisions 95%+ of the time get promoted to automatic.
- **End-game:** Mature rules run automatically. New edge cases still surface for human review. Continuous drift detection compares automated decisions against occasional human overrides.

**Decision logging starts in v1** because without the historical data, none of the later stages are possible.

---

## Part 5: The Three-Level Skeleton

The skeleton has exactly three levels of mechanics. These three levels are what gets built once and frozen. Everything above this is module content that changes frequently.

### Level 1: Between Steps

Step N finalizes → data saved to Supabase → Step N+1 loads that data.

Steps communicate exclusively through the database. There are no direct connections between steps. No event passing. No callbacks. Step 2 doesn't know Step 1 exists — it reads whatever data is in Supabase for this run at this step.

This means:
- Steps can be reordered without code changes (they just read from different step numbers)
- Steps can be skipped entirely for content types that don't need them
- A step failure doesn't cascade — Step 3 doesn't break because Step 2 had an error, it simply has no input to work with
- Adding a new step requires zero changes to existing steps

### Level 2: Between Submodules Within a Step

Run submodule A → approve results → Run submodule B → approve results → all approved results aggregate when step finalizes.

Within a step, submodules share context — data uploaded or produced by one submodule is available to others in the same step. But each submodule runs independently and **sequentially** — the user triggers them one at a time, reviews results, approves or rejects, then moves to the next submodule. There is no concurrent execution of sibling submodules within a step.

The shared step context pattern:
- Each submodule declares what input it needs (e.g., "I need a `website` column in the entity data")
- When running, the submodule checks: (1) does my own upload have this data? (2) does the shared step context from another submodule have it? (3) if neither, prompt the user
- Priority: submodule's own upload > shared context > prompt user

When the step finalizes, all approved results from all submodules in that step are aggregated and written to Supabase as the step's output. This becomes the input for the next step.

### Level 3: Within Each Submodule (Three Accordions)

Every submodule pane has exactly three sections, rendered as accordions:

**1. Input** — The skeleton handles: load entity data from previous step output OR accept a direct upload. Check shared step context for available data from sibling submodules. Display what's available and what's missing. The submodule doesn't handle any of this — it declares what it needs, and the skeleton figures out where to get it.

**2. Options** — The skeleton handles: render whatever configuration options the module declares in its manifest. Toggles, dropdowns, number inputs, text fields, template selectors. The skeleton doesn't know what these options mean — it just renders the form. The module defines the options and their defaults.

**3. Results** — The skeleton handles: [RUN] button triggers execution → show progress → display output → [APPROVE] / [REJECT] per item. Download CTA for bulk export. Try Again CTA for re-running with different options. The skeleton displays results in a standard format and handles the approval workflow. It doesn't know what the results mean.

**The skeleton renders all three sections for every submodule.** This is why adding a new submodule requires zero skeleton changes — the skeleton already knows how to handle any submodule that follows the contract.

---

## Part 6: What Each Step Achieves

This section describes the intent of each step — what problem it solves and why it exists — not the implementation detail of which submodules it contains. Submodule inventories and specifications live in companion documents.

### Step 0: Project Start

**Intent:** Define the scope of what we're making before doing any work.

The user names the project, selects the content type (company profile, news article, directory description, video script, image brief, or any future content type), chooses which entities to process, and optionally selects a template that pre-configures options across downstream steps.

This step is mostly UI — no heavy computation. Its output is a project record and a list of entities that flow through subsequent steps.

### Step 1: Discovery

**Intent:** Cast a wide net to find every possible source of information about each entity.

Different entities have different footprints on the web. A large company might have a rich sitemap, LinkedIn presence, news coverage, Crunchbase profile, and YouTube channel. A small startup might only have a basic website. Discovery submodules each know how to find information through a different channel.

**Key architectural point:** There is no centralized upload step. Each submodule owns its own input. A Sitemap parser needs a website URL. A News search needs a company name. A LinkedIn scraper needs a LinkedIn URL. Each submodule declares what it needs and finds it through the shared step context pattern (own upload > shared context > prompt user).

### Step 2: Pre-Scrape Validation

**Intent:** Save money and time by filtering out worthless URLs before fetching them.

Discovery typically produces far more URLs than are worth scraping. Validation filters these cheaply — regex rules, robots.txt checks, URL pattern analysis — so the expensive scraping step only processes URLs likely to produce useful content.

This is one of the steps where calibration has the highest financial impact. If the system learns that URLs matching `/tag/*` from news sites are always junk, it can filter them automatically instead of wasting scraping budget.

### Step 3: Scraping

**Intent:** Fetch actual page content using the right method for each source.

Not all pages can be fetched the same way. Some need simple HTTP requests. Some need a headless browser for JavaScript rendering. Some are behind authentication or rate limiting. Some are PDFs or structured data feeds. Different submodules handle different scraping challenges.

### Step 4: Filtering & Assembly

**Intent:** Transform raw scraped content into clean, organized source packages ready for generation.

Raw HTML needs cleaning — remove navigation, ads, boilerplate. Duplicate content needs deduplication. Multiple sources for the same entity need assembly into a coherent source package. The output is the actual material the LLM will work from.

### Step 5: Analysis & Generation

**Intent:** Use the assembled sources to produce the final content.

This is where LLM costs concentrate. The system analyzes source packages, identifies key information, and generates output content according to templates and prompts configured for the content type. Quality depends heavily on input quality from previous steps and on calibrated prompts. This is where the calibration pattern has the biggest quality impact.

### Step 6: Quality Assurance

**Intent:** Verify that generated content meets standards before it moves to packaging.

QA ranges from simple automated checks (minimum length, required sections present) to sophisticated evaluation (factual accuracy, tone consistency, SEO optimization). v1 relies heavily on human review. The end-game is calibrated thresholds that auto-approve content above a learned standard.

### Step 7: Routing

**Intent:** Decide what happens to items that don't pass quality standards.

In v1, the user IS the router. They see failed items with reasons and decide: re-run with different options, send back to a previous step, or discard. There is no automated routing engine in v1. In the end-game, routing rules learned from user decisions automate common rework patterns.

### Step 8: Bundling

**Intent:** Package approved content into the formats required by downstream systems.

A company profile might need to be bundled as a Strapi-ready JSON object, a Google Doc for editorial review, and a spreadsheet row for tracking. Bundling handles format transformation without changing the content.

### Step 9: Distribution

**Intent:** Push bundled content to external systems.

Strapi API calls, Google Drive uploads, spreadsheet updates. Each distribution target has its own submodule that handles authentication, API formatting, and confirmation.

### Step 10: Review

**Intent:** Final human gate before content goes live.

Even with QA at Step 6, a final editorial review catches things automation misses. This step is lightweight in the tool (just an approval UI) but represents the human judgment that ensures nothing publishes that shouldn't.

---

## Part 7: Beyond Text — The Broader Ambition

The 11-step sequence is deliberately abstract. It describes a universal content creation flow, not a text-content-specific one.

**Video production:**
- Step 0: Define video project (explainer, product demo, interview)
- Step 1: Discover source material (company website, product pages, existing media, brand guidelines)
- Steps 2-4: Fetch and assemble reference materials
- Step 5: Generate video script, shot list, creative brief
- Step 6: QA against brand voice and factual accuracy
- Steps 8-9: Bundle as production package, distribute to video team or production tool

**Image and design briefs:**
- Step 0: Define brief project (social media graphics, infographic, banner ads)
- Step 1: Discover reference images, brand assets, competitor examples
- Step 5: Generate creative briefs with layout suggestions, copy, design direction
- Step 9: Distribute to design team or push to design tool

**Landing pages and microsites:**
- Step 0: Define page type and target audience
- Step 1: Discover competitive examples, keyword data, content requirements
- Step 5: Generate page copy, meta descriptions, structured content blocks
- Step 9: Push to CMS or static site generator

**Social media content packages:**
- Steps 1-4: Research topic, gather sources
- Step 5: Generate platform-specific posts (LinkedIn long-form, Twitter thread, Instagram caption)
- Step 8: Bundle as multi-platform content package
- Step 9: Distribute to scheduling tools

None of these require changes to the skeleton. They require new submodules in the appropriate steps. The skeleton already handles input loading, option rendering, execution, approval, aggregation, and step-to-step data flow. It does this for sitemap parsing today. It will do it for video script generation tomorrow. The mechanics are identical.

This is why the architecture prioritizes modularity above all else. The skeleton is built once and frozen not because change is bad, but because the skeleton's job is already done — it provides the universal container mechanics. All future innovation happens at the submodule level, where the developer's focus belongs.

---

## Part 8: The Risk — Why Boundaries Must Be Physical

Parts 2 through 7 describe the vision and its architecture. This part explains why the implementation requires physical enforcement through two repositories, not just good practices in a single codebase.

### Rules in files will always be a risk moment

The modularity described above works perfectly — if everyone follows the rules. Don't modify infrastructure while working on modules. Don't import database clients into submodules. Don't change the step flow to fix a module bug.

But rules in markdown files and code comments are advisory. They can be read, understood, and still broken — especially under the pressure of debugging. When a module isn't working, the fastest fix often involves touching infrastructure. In that moment, the architectural boundary exists only as a suggestion.

**If the architecture depends on rules in markdown files being followed, there will always be a risk moment.** Every development session becomes a gamble: will this be the session where the rules hold, or the session where they're broken?

### The pattern that proved this

Across multiple development sessions, the same destructive pattern repeated:

1. Developer (or AI coding assistant) starts working on module logic — fixing a scraper, improving a filter, tuning a prompt
2. While debugging, they modify infrastructure — database connections, queue configuration, step flow logic, React shell components
3. These infrastructure changes introduce regressions in previously working features
4. The next session discovers the regressions and spends its time rebuilding infrastructure instead of building forward

The module logic itself has been stable throughout. What breaks every time is the plumbing between modules. The project has extensive documentation — CLAUDE.md files with explicit rules, architecture decision records, workflow specifications. None of it prevented the pattern because AI coding assistants read documentation at the start of a session but drift from it under debugging pressure.

### Physical separation eliminates the gamble

Two repositories don't make boundary violations discouraged — they make them impossible. If the infrastructure files aren't in the working repository, they can't be accidentally modified. Not "shouldn't be" — *can't be*.

**Why not a monorepo with package boundaries?** Tools like Turborepo/Nx can enforce import restrictions through ESLint rules. But ESLint rules are checked at lint time, not at edit time. An AI coding assistant following an import chain during debugging will read, modify, and save files across package boundaries without running the linter. The protection only triggers after the damage is done. Physical repo separation means the modules workspace literally does not contain infrastructure files — there is nothing for the AI to follow, read, or modify. This is a constraint designed specifically for AI-assisted development workflows.

The trade-off is real: cross-boundary changes (~1-2 per month) require coordinating across two repositories, roughly 30 minutes of extra friction each time. This is overwhelmingly worth it compared to hours or days lost to accidental regressions — a pattern that occurred in the majority of development sessions before the split.

### What needs to be stable

The things that keep breaking are not complex. They are plumbing:

- **Database connections** — Supabase connection pooling, timeout handling, reconnection
- **Job queue setup** — Redis connection, BullMQ worker configuration, job recovery
- **Step-to-step data flow** — How Step 1's output becomes Step 2's input through Supabase
- **The React shell** — Step containers, submodule panels, approval buttons, navigation
- **The module loading pattern** — How the system discovers, loads, and executes a submodule

None of these need frequent changes. Once working, they should be frozen. Repo 1 contains the plumbing. Repo 2 contains the modules. Day-to-day development happens in Repo 2. Repo 1 is touched deliberately, rarely, and with full awareness of the consequences.

---

## Part 9: v1 vs End-Game

### v1: Manual Everything, Log Everything

The first version of any step should be the simplest possible implementation that proves the skeleton works. One discovery method, one scraper, one generator, one distribution target. The human reviews everything manually. No automation, no intelligence, no shortcuts.

But every human decision gets logged — which URLs were approved or rejected, which content passed or failed QA, which items were rerouted and why. This logging is not optional and not a "nice to have." It is the foundation that makes every later stage possible.

**The v1 goal:** One piece of content through all 11 steps, from project creation to published output. Manual review at every step. Prove the skeleton works end-to-end.

### End-Game: Intelligent, Multi-Source, Multi-Format

The end-game system looks fundamentally different from v1 — not because it was redesigned, but because it learned:

- **Discovery** expands from one source type to many — websites, search engines, social platforms, news archives, industry databases, APIs. Each is a submodule.
- **Validation** graduates from manual review to calibrated rules — learned from thousands of logged decisions, running in shadow mode before enforcement.
- **Generation** handles multiple content types with prompts calibrated per category, producing better first drafts because the system knows what "good" looks like.
- **Quality** thresholds auto-approve content above a learned standard, surfacing only edge cases for human review.
- **Routing** applies automated rework rules learned from user decisions — "when a profile fails QA for this reason, re-run with this prompt configuration."
- **Distribution** pushes to multiple targets — CMS, document systems, design tools, scheduling tools, production systems.
- **New tools and LLMs** get evaluated against historical data, A/B tested alongside existing modules, and promoted or discarded based on measured performance.

The end-game is not a separate system to be designed later. It emerges naturally from consistent decision logging in v1. Every human decision in v1 becomes training data for end-game automation.

---

## Part 10: How This Connects to the Broader Platform

The Content Creation Tool's output feeds OnlyiGaming through the tagging system.

A company profile generated by the tool gets tagged with directory categories (DIR-003 Live Dealer Providers), geography tags (MARKET-EU), product tags (PROD-live-casino), and publication type tags (TYPE-profile). Once in Strapi, this content appears across the platform wherever those tags are relevant.

The Content Creation Tool must produce output that:
- Conforms to Strapi's content type schemas
- Includes all required tags and metadata
- Is ready for the platform's tag-first architecture without manual re-tagging
- Handles relationships between entities

Distribution (Step 9) handles Strapi formatting. But content structure is determined earlier — Step 5 must know what fields Strapi expects, and Step 0 must capture which tags apply.

---

## Part 11: How Documents Fit Together

Three documents govern this project. Each has a clear scope.

| Document | What It Covers | Scope |
|----------|---------------|-------|
| **Strategic Architecture (this document)** | Intent, principles, end goal, reasoning, context. Why decisions were made. | The "why" — governs all other documents |
| **Skeleton Spec** | Two-repo split. Three-level mechanics. Manifest contract. Tools object. Schema. Infrastructure reliability. | The "what to build" — the frozen house |
| **Module Decisions** | Submodule specs. Shared step context API. Error contracts. UI states. Approval flow. | The "detailed how" for modules — the furniture |

**Hierarchy:** If documents conflict — Strategic Architecture wins on principles and intent, Skeleton Spec wins on infrastructure, Module Decisions wins on module-level detail.

**Everything else is reference material.** Historical documents may exist for context but are not authoritative. Any developer or AI assistant should follow these three documents.

---

## Part 12: The Test

The architecture is working when:

1. **A freelancer can build a new submodule** in Repo 2 without knowing how Supabase, Redis, or BullMQ work.

2. **A skeleton developer can fix infrastructure** in Repo 1 without breaking any existing submodule.

3. **Adding a new submodule requires zero skeleton changes.** Create a file in the right folder, it appears in the UI.

4. **The system produces its first published content** through all 11 steps with manual review at every step. The skeleton works end-to-end.

5. **Decision logging captures every human judgment** from day one.

6. **A new LLM or tool can be evaluated** against historical data without modifying the skeleton.

7. **A new content type can be added** (video scripts, image briefs, landing pages) by creating new submodules only — no skeleton or existing submodule changes.

8. **The rebuild cycle stops.** Development sessions build forward instead of rebuilding infrastructure.
