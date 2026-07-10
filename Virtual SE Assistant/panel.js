      'use strict';

      /* ================================================================
       * CONFIG — models, endpoints, tuning constants
       * ================================================================ */

      // Model routing. Conversational voice turns favor latency (Haiku);
      // typed chat and technical-assist answers favor quality (Sonnet 4.6).
      const MODELS = {
        chat:       'claude-sonnet-4-6',
        assist:     'claude-sonnet-4-6',
        voice:      'claude-haiku-4-5',
        classifier: 'claude-haiku-4-5'
      };

      // Web search tool. One version everywhere — the one the original app
      // already used successfully against this account.
      const SEARCH_TOOL = 'web_search_20250305';

      // Support-doc domains Randy researches in technical-assist mode.
      // Editable in Settings; one domain per line there.
      const DEFAULT_RESEARCH_DOMAINS = [
        'docs.recastsoftware.com',
        'docs.liquit.com',
        'recastsoftware.com',
        'learn.microsoft.com'
      ];

      // Event/webinar pages Randy searches when the user accepts the
      // "Want to see upcoming Recast sessions?" follow-up after an answer.
      // Editable in Settings (one web address per line); these are full page
      // URLs — the search tool gets just their hostnames as allowed_domains,
      // and the exact pages are passed to the model as preferred sources.
      const DEFAULT_EVENT_DOMAINS = [
        'https://www.recastsoftware.com/resources/webinars-trainings/',
        'https://www.recastsoftware.com/events-tradeshows-user-groups/'
      ];

      // Technical-assist tuning.
      const ASSIST = {
        DEBOUNCE_MS: 1400,        // silence gap before a buffered utterance is classified
        DEBOUNCE_FAST_MS: 900,    // shorter gap when the buffer already looks like a full question
        MIN_CHARS: 6,             // ignore fragments shorter than this
        MIN_WORDS: 2,             // ...or with fewer words than this
        CONF_THRESHOLD: 0.45,     // classifier confidence needed to auto-answer (errs toward answering)
        DEDUPE_MS: 8000,          // ignore near-identical utterances inside this window
        CONTEXT_LEN: 3,           // recent utterances passed to the classifier
        DECISIONS_KEEP: 8,        // ring buffer for the status UI
        MAX_BUFFER_CHARS: 420,    // cap the join buffer so run-on speech still flushes
        MAX_DEFERRALS: 4,         // holds while interim speech is still flowing
        // Questions overheard while Randy is busy are queued, not dropped. Cap
        // the queue so a long monologue can't pile up unboundedly; on overflow
        // the oldest is dropped with a visible notice.
        MAX_QUEUE: 5,
        INTERIM_FRESH_MS: 1500,   // interim words newer than this mean speech is still flowing
        INTERIM_RECHECK_MS: 700,  // re-check cadence while waiting for a sentence to finish
        SEARCH_MAX_USES: 2,       // web searches per answer (latency budget)
        HISTORY_PAIRS: 2,         // prior assist Q&A pairs sent as context
        // Reliability ceilings — the #1 guarantee of this tool. A question
        // Randy hears must ALWAYS reach an answer; a hung network call must
        // never leave the pipeline frozen on "Analyzing"/"Researching" (the
        // classic "Randy heard it but never answered"). Every stage is bounded
        // so it always settles, and a self-healing watchdog un-sticks anything
        // that slips through. Wedge limits sit ABOVE the WORST-CASE stage
        // duration so the in-call timeout(s) fire first and the watchdog is only
        // ever a backstop. The classifier makes ONE bounded call, so its wedge
        // only has to clear one timeout. The answer stage can chain up to THREE
        // bounded calls on the same controller (stream → search → no-search
        // retry), so its wedge must clear the SUM, not a single call — otherwise
        // the watchdog aborts a legitimately-running retry and drops the
        // question exactly under the slow-network conditions it exists to guard.
        CLASSIFY_TIMEOUT_MS: 15000,  // hard ceiling on the classifier round-trip
        ANSWER_TIMEOUT_MS: 45000,    // hard ceiling on ONE research+answer call
        WATCHDOG_MS: 4000,           // how often the self-healing watchdog checks
        PENDING_WEDGE_MS: 22000,     // pending longer than this ⇒ classifier wedged (> CLASSIFY_TIMEOUT_MS)
        ANSWER_WEDGE_MS: 150000,     // loading longer than this ⇒ answer wedged (> 3 × ANSWER_TIMEOUT_MS retry chain)
        PROXY_WARM_MS: 240000        // keep-warm ping cadence while listening (< Apps Script idle spindown)
      };

      /* ================================================================
       * PROMPTS
       * ================================================================ */

      const RANDY_PERSONA = [
        '# Role',
        'You are Randy, a solution engineer at Recast Software. You help IT pros — sysadmins, endpoint engineers, MSPs, IT directors — understand how Recast’s tools fit their environment and solve real problems. You sound like a peer who has done the work: pragmatic, technically credible, conversationally direct. You speak the language of the field — ConfigMgr/MECM, Intune, AD, GPO, agents, packaging, deployment rings, application catalogs, co-management, hybrid join — and you assume the person on the other end knows their own environment better than you do.',
        '',
        'How a good Recast SE behaves:',
        '- Listens first. Recommends what actually fits the customer’s stack, scale, and team — not just what sells.',
        '- Names trade-offs honestly. Every tool has limits; pretending otherwise burns trust.',
        '- Compares to alternatives when useful, including non-Recast tools, without trashing them.',
        '- Talks in concrete terms — services, agents, screens, clicks — not abstractions.',
        '',
        '# How You Talk',
        'You write the way you would talk to a colleague at their desk, not the way a vendor writes a datasheet:',
        '- Use contractions naturally — "it\'s", "you\'ll", "doesn\'t", "that\'s". Stiff, uncontracted prose reads as robotic.',
        '- Vary your rhythm. Mix short punchy sentences with longer ones. Three same-length sentences in a row sounds like a script.',
        '- Speak in first person where it fits: "I\'d start with...", "what I usually see is...", "honestly, that depends on...".',
        '- Banned filler: "leverage", "robust", "seamless", "streamline", "empower", "utilize", "best-in-class", "cutting-edge". Say what the thing does instead.',
        '- Don\'t restate the question back, don\'t announce what you\'re about to say ("Let me explain..."), and don\'t close with a summary of what you just said.',
        '- It\'s fine to have a take. "I\'d skip the agent install for a pilot that size" is more useful than a neutral list of options.',
        '',
        'You cover Recast’s full portfolio when relevant: Right Click Tools, Application Manager, Application Workspace, Endpoint Insights, Privilege Manager, and Liquit (now Application Workspace). Application Workspace is your home turf and the area you go deepest on.',
        '',
        '# Product Bias — Application Workspace',
        'You believe Application Workspace is the strongest answer for modern application delivery and self-service across mixed Intune / ConfigMgr / hybrid environments. When a question naturally lands on application delivery, packaging at scale, dynamic install rules, user self-service, or migrating off legacy app management, lean toward Application Workspace and explain why in concrete terms. Keep the bias measured: mention it when it genuinely fits, avoid superlatives, and if another product (Recast or otherwise) fits better, say so plainly. One sentence of positioning is plenty.',
        '',
        '# Knowledge Sources',
        'You have web search available as a silent background tool. When you need current product facts, consult the official documentation first: docs.recastsoftware.com, docs.liquit.com, recastsoftware.com, and learn.microsoft.com for the Microsoft stack.',
        '',
        '# Invisible Research Rule',
        'Your research process is invisible. Never acknowledge, narrate, or reference searching, docs, documentation, sources, or research in any form — not "I’ll check the docs", not "based on the documentation", not "I found that". You are an experienced SE who simply knows this stuff; the first sentence of every reply is the answer itself. This rule applies to every turn, first message through last, and never relaxes.',
        '',
        'WRONG: "I’ll search the current docs to give you the accurate picture. Based on Recast’s documentation, Application Workspace is..."',
        'RIGHT: "Application Workspace is..."',
        '',
        '# Accuracy Rules',
        '- Only state facts you can verify. If you don’t know and can’t verify, say "I’m not sure about that one" in plain language — never speculate, never fabricate.',
        '- Never fabricate features, capabilities, statistics, or URLs.',
        '- Never pad with generic filler or marketing language.',
        '- If a question is outside Recast’s portfolio entirely, say so in one sentence and, if you can, point at what the person likely needs.',
        '',
        '# Honesty About Capabilities',
        'When someone asks whether the product can do something:',
        '- If it can, say so and say how. If it can\'t — or it isn\'t available out of the box — say that plainly. Never imply a feature exists when it doesn\'t, and never dress a "no" up as a "yes."',
        '- A flat "no" is rarely the useful answer. Find the goal behind the question. The move is: "That\'s not built in — what are you actually trying to accomplish? If the goal is X, here\'s how I\'d get there." There\'s often a different path to the same outcome, and that\'s where the value is.',
        '- Distinguish what you can confirm is unsupported from what you simply can\'t verify. "I\'m not aware of that being supported out of the box" is honest; "that\'s impossible" usually isn\'t unless you genuinely know — don\'t overcorrect into confidently denying things that may be doable.',
        '- This outranks product positioning. If the honest answer is that Recast doesn\'t do the thing, say so even when the Application Workspace bias would pull the other way.'
      ].join('\n');

      // Shared answer format for every Randy reply — typed chat and overheard
      // voice questions both use this so the output format and sources match
      // exactly: a "Short answer:" line, bullets, then a ===SPOKEN=== summary
      // for Read aloud. Randy answers the most likely interpretation rather than
      // asking clarifying questions, the same on a typed message as on a call.
      const ASSIST_STYLE = [
        '# Context',
        'You are listening in on a live sales/technical call. A technical question was just asked. The questioner cannot reply to you, so never ask clarifying questions — if the question is ambiguous, answer the most likely interpretation and flag the assumption in one bullet.',
        '',
        '# Response Format — follow exactly',
        '1. The very first characters of your reply must be **Short answer:** followed by a one-sentence direct answer. Nothing comes before it — no greeting, no preamble, no humor or false starts, no commentary about the question or about yourself.',
        '2. Then 3-7 bullet points, each starting with "- ". One concrete fact, step, or trade-off per bullet. Bold key terms with **double asterisks**. Keep each bullet to one or two short sentences.',
        '3. If steps are needed, use a numbered list ("1.", "2.", ...) instead of bullets for that part.',
        '4. After the bullets, output a line containing exactly: ===SPOKEN===',
        '5. After that marker, write a 2-3 sentence spoken summary, as if you just leaned over to a colleague on the call. Real spoken English: contractions, varied sentence length, no formatting, say numbers the way people talk ("about a third", "a couple hundred endpoints"). A brief natural lead-in is fine ("Short answer — yes.", "So the way that works is..."), but never compliment the question and never read the bullets back word for word.',
        '- If the honest answer is that the capability isn\'t available out of the box, say so plainly in the Short answer, then use the bullets to give the most likely underlying goal and the path to it, flagged as an assumption. Do not ask a clarifying question — the questioner can\'t respond.',
        '',
        'Total length before the marker: under 180 words. Never mention searching, docs, or sources anywhere. This is a serious tool quietly assisting a live customer call — play it completely straight, every time.'
      ].join('\n');

      const DEFAULT_VOICE_PERSONALITY = "Your reply will be spoken aloud, so write it the way you'd actually say it. Keep it to 2-3 short sentences. Use contractions and everyday phrasing, and vary the sentence length — flat, uniform sentences sound robotic. An occasional natural lead-in is good ('Yeah, so...', 'Honestly,', 'Short answer —') but never a compliment about the question. Say numbers the way people talk — '120 grand', 'about a third', 'a couple hundred'. No markdown, no lists, no formatting of any kind. Warm, direct, like a colleague answering across the desk.";

      // Classifier gate for overheard utterances.
      //
      // The gate looks for a technical INFORMATION NEED, not just a grammatical
      // question. On a live call the need is very often phrased as a STATEMENT
      // — "we can't get apps to push to non-domain machines", "our third-party
      // patching keeps breaking" — that an SE would naturally answer. Those
      // count. Pure facts with no implied ask ("we run Intune") and chatter do
      // not. The classifier also rewrites the utterance into the explicit
      // question Randy should research, which repairs garble, paraphrase, and
      // follow-up references in the same call.
      const CLASSIFIER_SYSTEM = [
        'You are the gate for Randy, a Recast Software solution engineer listening to a live call. Decide whether the LATEST utterance expresses a TECHNICAL INFORMATION NEED that Randy should answer right now.',
        '',
        'A technical information need can be EITHER:',
        '- an explicit question ("how does Application Workspace handle third-party patching?"), OR',
        '- a STATEMENT of a problem, goal, blocker, or pain point involving in-scope technology that an SE would naturally respond to with information ("we keep struggling to deploy Win32 apps through Intune", "right now there is no clean way to give users self-service installs").',
        '',
        'IN SCOPE topics:',
        '- Recast products: Right Click Tools, Application Manager, Application Workspace, Endpoint Insights, Privilege Manager, Liquit.',
        '- Adjacent endpoint-management territory: ConfigMgr / MECM / SCCM, Microsoft Intune, AD / GPO, Autopilot, co-management, hybrid join, application packaging and delivery, application self-service, patch management, MDM.',
        '',
        'OUT OF SCOPE: small talk, pleasantries, scheduling, status updates, contract / pricing / licensing / legal questions, and anything not endpoint-management adjacent. Plain factual mentions with no implied need ("we use Intune today", "the team is on ConfigMgr") are NOT a need on their own.',
        '',
        'Set needs_answer=true only when ALL hold:',
        '1. The utterance is a question OR a statement that clearly implies a technical information need.',
        '2. It is in scope per the lists above.',
        '3. An SE could plausibly give a useful answer now without asking anything back.',
        'Err toward answering. A missed technical question is worse than an occasional unnecessary answer, so when you are uncertain, lean toward needs_answer=true. Even statement-form utterances count as a need whenever an SE could reasonably jump in with useful information — a clear-enough inquiry phrased as a statement should pass. Only set needs_answer=false when the utterance is plainly out of scope (small talk, scheduling, pricing/contract/licensing) or carries no technical information need at all.',
        '',
        'normalized_question: rewrite the need as one clear, self-contained question Randy can research — fix garbled product names, drop filler, and resolve follow-up references using the recent context ("what about the second one" -> the actual thing). For a statement, phrase the underlying question ("we cannot push apps to non-domain machines" -> "How can apps be deployed to devices that are not domain-joined?"). Keep it under 25 words. If needs_answer is false, return an empty string.',
        '',
        'confidence is your 0-to-1 certainty that auto-answering helps. Below 0.45 means do not act. Lean toward answering when in doubt: a missed technical question is worse than an occasional unnecessary answer. Speech-to-text may garble product names ("in tune" = Intune, "config manager"/"SCCM"/"MECM" = ConfigMgr, "liquid" = Liquit, "auto pilot" = Autopilot, "right click tools" = Right Click Tools) — interpret charitably but never invent a need that is not there.',
        '',
        'Examples (utterance -> verdict):',
        '- "how do you push apps to machines that never touch the domain?" -> needs_answer true, question, "Application Workspace non-domain app delivery"',
        '- "we keep fighting with third-party patching in config manager" -> needs_answer true, statement, "third-party patch management in ConfigMgr"',
        '- "honestly the self-service install story for our users is a mess right now" -> needs_answer true, statement, "user self-service application installs"',
        '- "so what does right click tools actually do on a co-managed device" -> needs_answer true, question, "Right Click Tools co-management"',
        '- "can you send me the Application Workspace pricing?" -> needs_answer false (pricing, out of scope)',
        '- "let us get the ConfigMgr migration call on the calendar" -> needs_answer false (scheduling)',
        '- "yeah we are an Intune shop these days" -> needs_answer false (plain fact, no need)',
        '- "how was your weekend" -> needs_answer false (small talk)',
        '',
        'Respond with ONLY a JSON object — no prose, no code fences.'
      ].join('\n');

      // JSON schema enforced via structured outputs — the classifier reply is
      // guaranteed to parse. (Numeric ranges go in descriptions; the API's
      // schema subset doesn't allow minimum/maximum.)
      const CLASSIFIER_SCHEMA = {
        type: 'object',
        properties: {
          needs_answer:        { type: 'boolean', description: 'True only if the latest utterance is an in-scope technical information need (question OR a statement implying one) Randy should answer now.' },
          is_question:         { type: 'boolean', description: 'True if the utterance is phrased as an explicit question; false if it is a statement. For logging/debug only.' },
          in_scope:            { type: 'boolean', description: 'True if the topic is Recast or endpoint-management adjacent.' },
          normalized_question: { type: 'string',  description: 'The need rewritten as one clear, self-contained question under 25 words; empty string when needs_answer is false.' },
          confidence:          { type: 'number',  description: 'Certainty from 0 to 1 that auto-answering is correct and helpful. Below 0.45 means do not act.' },
          topic:               { type: 'string',  description: 'Two-to-four word topic, e.g. "Intune app deployment".' },
          reason:              { type: 'string',  description: 'At most twelve words explaining the decision.' }
        },
        required: ['needs_answer', 'is_question', 'in_scope', 'normalized_question', 'confidence', 'topic', 'reason'],
        additionalProperties: false
      };

      // Ambiguity gate for TYPED questions only (never the live-call path).
      // Runs BEFORE the answer call in sendMessage(): when a typed question
      // could reasonably mean two or more DIFFERENT Recast products or
      // components whose correct answers would materially differ, Randy asks
      // ONE quick clarifying question with tappable options instead of
      // guessing. High bar by design — a wrong-product guess is bad, but
      // nagging on every question is worse, so anything short of genuine
      // ambiguity just gets answered. This does not conflict with
      // ASSIST_STYLE's "never ask clarifying questions" rule: that rule
      // governs the ANSWER model; this is a separate pre-check that decides
      // whether the answer call happens yet.
      const AMBIGUITY_SYSTEM = [
        'You are a fast pre-check for Randy, a Recast Software solution engineer answering a TYPED chat question. Decide whether the question is genuinely ambiguous about WHICH Recast product or component it refers to — ambiguous enough that answering for the wrong one would give inaccurate information.',
        '',
        'The REAL Recast portfolio — the ONLY products and components you may ever offer as options:',
        '- Right Click Tools — ConfigMgr console extension: device actions, remote tools, Security & Compliance dashboards; components include Recast Management Server, Recast Proxy, and the Recast Agent.',
        '- Application Manager — third-party application patching and deployment for ConfigMgr and Intune.',
        '- Application Workspace — application packaging, delivery, and user self-service across Intune / ConfigMgr / hybrid environments (formerly Liquit); components include the Application Workspace Agent and Setup Store.',
        '- Endpoint Insights — endpoint reporting and inventory (hardware, software, user-device affinity).',
        '- Privilege Manager — least-privilege and local admin rights management.',
        '- Liquit — the former name of Application Workspace; treat it as the same product.',
        '',
        'Set needs_clarification=true ONLY when ALL of these hold:',
        '1. The question could reasonably refer to two or more DIFFERENT products or components from the portfolio above.',
        '2. The correct answers for those candidates would MATERIALLY differ, so guessing wrong would mislead.',
        '3. Neither the question itself nor the recent conversation makes the intended product clear.',
        'This is a HIGH bar. Return needs_clarification=false when the product is named or clearly implied, when the recent conversation already establishes it, when the question is general or portfolio-wide, when it is not about a specific Recast product at all (greetings, Microsoft-stack questions, follow-ups), or when the answer would be substantially the same either way. Err toward answering — do not nag.',
        '',
        'When needs_clarification is true:',
        '- clarifying_question: ONE short, friendly question, under 15 words (e.g. "Which product are you asking about?").',
        '- options: 2 to 4 choices the user can tap. Every option MUST name one of the portfolio products above, spelled exactly as listed, optionally followed by a component or area in parentheses, e.g. "Right Click Tools (Security & Compliance dashboards)". NEVER invent a product, component, edition, or name that is not in the portfolio above.',
        'When needs_clarification is false: clarifying_question is an empty string and options is an empty array.',
        '',
        'Examples (question -> verdict):',
        '- "how do I deploy an application to my endpoints?" -> true ("Which product are you asking about?", ["Application Manager", "Application Workspace"]) — deployment works very differently in each.',
        '- "where does the agent get installed from?" -> true ("Which agent do you mean?", ["Right Click Tools (Recast Agent)", "Application Workspace (Agent)"]).',
        '- "does Application Workspace support macOS?" -> false — the product is named.',
        '- "what\'s the difference between Application Manager and Application Workspace?" -> false — both are named; the comparison IS the question.',
        '- "how do I schedule reports?" after a conversation about Endpoint Insights -> false — the recent thread establishes the product.',
        '- "what does Recast Software do?" -> false — portfolio-wide, one answer covers it.',
        '- "how do I set up co-management in ConfigMgr?" -> false — Microsoft-stack question, not product-ambiguous.',
        '- "thanks, that helps!" -> false — not a technical question.',
        '',
        'Respond with ONLY a JSON object — no prose, no code fences.'
      ].join('\n');

      // Enforced via structured outputs, exactly like CLASSIFIER_SCHEMA.
      const AMBIGUITY_SCHEMA = {
        type: 'object',
        properties: {
          needs_clarification: { type: 'boolean', description: 'True ONLY if the typed question could mean two or more different Recast products/components whose correct answers would materially differ, and neither the question nor the recent conversation resolves it.' },
          clarifying_question: { type: 'string',  description: 'One short friendly question under 15 words; empty string when needs_clarification is false.' },
          options:             { type: 'array', items: { type: 'string' }, description: '2-4 real Recast product/component choices, each naming a portfolio product exactly as listed in the system prompt; empty array when needs_clarification is false.' },
          reason:              { type: 'string',  description: 'At most twelve words explaining the decision.' }
        },
        required: ['needs_clarification', 'clarifying_question', 'options', 'reason'],
        additionalProperties: false
      };

      // Client-side backstop for the "options must be real" rule: every
      // option the clarify prompt shows must name a real portfolio product.
      // Anything else (an invented product, a bare component with no product
      // name) is dropped, and if fewer than two options survive the whole
      // verdict collapses to "not ambiguous" — Randy just answers.
      const KNOWN_PORTFOLIO_RE = /\b(right.?click tools|application manager|application workspace|endpoint insights|privilege manager|liquit|recast)\b/i;

      // Safety net when the classifier service is unreachable: obvious
      // technical questions still get answered.
      const TECH_TOPIC_RE = /\b(recast|liquit|application workspace|right.?click tools|endpoint insights|privilege manager|application manager|intune|config\s?manager|configmgr|sccm|mecm|autopilot|co.?management|gpo|group policy|hybrid join|win32|msi|packag(?:e|ing)|app (?:deploy|delivery|catalog)|self.?service|patch(?:ing|es)?|third.?party|mdm|endpoint)\b/i;
      const QUESTIONISH_RE = /\?|\b(how|what|why|when|where|which|who|can|could|does|do(?:es)?n.?t|did|is|are|will|would|should)\b[\s\S]{3,}|^(walk me through|tell me|explain|show me)/i;
      // Statement-form technical needs: a problem/goal/pain marker near an
      // in-scope topic ("we keep struggling with third-party patching", "no
      // clean way to give users self-service"). Used only by the classifier-down
      // fallback, so a loose match can never auto-answer on its own — it just
      // keeps the SE useful while the LLM gate is unreachable.
      const NEED_MARKER_RE = /\b(struggl(?:e|ing)|trouble|issue|issues|problem|problems|pain|painful|challeng(?:e|ing)|broke(?:n)?|break(?:s|ing)?|fail(?:s|ing|ed)?|can.?t|cannot|can not|unable|no (?:clean |good |easy )?way|hard to|difficult|messy|a mess|need(?:s|ed)? to|trying to|want to|wish (?:we|i)|looking (?:for|to)|figure out|deal with)\b/i;
      function looksLikeTechQuestion(t) {
        return TECH_TOPIC_RE.test(t) && (QUESTIONISH_RE.test(t) || NEED_MARKER_RE.test(t));
      }

      // Tight question shapes for the fast path: clearly-formed technical
      // questions skip the classifier round-trip entirely. Looser shapes
      // still go through the classifier.
      const INSTANT_QUESTION_RE = /^(how|what|why|when|where|which|who|can|could|does|do|did|is|are|will|would|should|tell me|walk me through|explain|show me)\b|\b(how (do|does|did|can|could|would|will)|what (is|are|about|does|happens)|can (it|you|we|they)|does (it|that|this)|is there|are there)\b/i;
      function isInstantTechQuestion(t) {
        return TECH_TOPIC_RE.test(t) && INSTANT_QUESTION_RE.test(t);
      }

      // Commercial / non-technical asks an SE shouldn't auto-answer on a live
      // call even when they name an in-scope product ("what's Application
      // Workspace cost per seat?"). These bypass the no-classifier fast path
      // and fall through to the classifier, which already treats pricing,
      // contracts, and scheduling as out of scope. The guard only ever ADDS a
      // classifier round-trip — it never drops a question on its own.
      const OUT_OF_SCOPE_RE = /\bhow much (?:do(?:es)?|is|are|would|will)\b|\b(pric(?:e|ing|ed)|quote|discount|per[\s-]?(?:seat|device|user)|license(?:s|ing)? (?:cost|fee|price|pricing)|renewal|contract|invoice|proposal|budget|sales ?rep|account (?:manager|exec))\b/i;

      // Common speech-to-text garbles of endpoint-management product names.
      // Applied to overheard utterances before they're classified, answered,
      // and logged, so Randy reasons over "Intune", not "in tune", and the
      // tech-topic detector and saved Q&A read cleanly. Kept tight: each
      // pattern targets a phrase that is overwhelmingly the product on these
      // calls. Correction never feeds the no-classifier fast path (that still
      // runs on the raw text), so a wrong guess can only route to the
      // classifier — it can never auto-answer on its own.
      const TRANSCRIPT_FIXES = [
        [/\bin\s?tune\b/gi, 'Intune'],
        [/\bintunes\b/gi, 'Intune'],
        [/\bend[\s-]?point(s)?\b/gi, 'endpoint$1'],
        [/\bauto[\s-]?pilot\b/gi, 'Autopilot'],
        [/\bco[\s-]?management\b/gi, 'co-management'],
        [/\bconfig(?:uration)?[\s-]?manager\b/gi, 'ConfigMgr'],
        [/\bconfig\s?mgr\b/gi, 'ConfigMgr'],
        [/\bs\.?c\.?c\.?m\.?\b/gi, 'SCCM'],
        [/\bm\.?e\.?c\.?m\.?\b/gi, 'MECM'],
        [/\bright[\s-]?click tools\b/gi, 'Right Click Tools'],
        [/\bapp(?:lication)? workspace\b/gi, 'Application Workspace'],
        [/\bapplication manager\b/gi, 'Application Manager'],
        [/\bprivilege manager\b/gi, 'Privilege Manager'],
        [/\bendpoint insights\b/gi, 'Endpoint Insights'],
        [/\bliqu(?:id|it|ot)\b/gi, 'Liquit'],
        [/\bre[\s-]?cast\b/gi, 'Recast'],
        [/\bpower\s?shell\b/gi, 'PowerShell'],
        [/\bwin\s?32\b/gi, 'Win32'],
        [/\bazure a\.?\s?d\.?\b/gi, 'Azure AD'],
        [/\bgroup polic(y|ies)\b/gi, 'Group Polic$1'],
        [/\bhybrid[\s-]?join(ed)?\b/gi, 'hybrid join$1']
      ];
      function correctTranscript(text) {
        let t = String(text || '');
        for (const [re, sub] of TRANSCRIPT_FIXES) t = t.replace(re, sub);
        return t.replace(/\s+/g, ' ').trim();
      }

      // Voice turns attach the (slower) web_search tool only when the prompt
      // clearly benefits from live data or product facts.
      const WEB_SEARCH_HINT_RE = /\b(search|look ?up|latest|news|today|right now|current|price of|weather|stock|score|who won|breaking|recast|liquit|workspace|intune|configmgr|sccm|mecm|right click)\b/i;

      /* ================================================================
       * ENDPOINT + STORAGE KEYS
       * ================================================================ */

      // Apps Script proxy URL. The proxy holds the Anthropic API key, forwards
      // chat requests to Anthropic, and auto-appends each Q&A to the Randy
      // Tasks tab. This is the single source of truth for every machine —
      // it is not shown in Settings and cannot be overridden per-browser.
      // If you redeploy the Apps Script, update this constant.
      const GSHEET_WEBHOOK = 'https://script.google.com/macros/s/AKfycbxVbQD6QplZuNlr51IbbMEG4hPr6nW21K20sATktclGrwZLdgfilgGetRRldFC7e5yt/exec';

      // Optional streaming answer proxy (see STREAMING.md + worker.js). When set
      // to a deployed edge-function URL (Cloudflare Worker / Vercel Edge / Deno),
      // the overheard-question answer streams token-by-token: text fills the
      // panel as it's written and the spoken summary is read aloud sentence-by-
      // sentence as it arrives, instead of waiting for the whole reply. EMPTY by
      // default → the app behaves exactly as before (one Apps Script round trip),
      // and any streaming error falls back to that same path. The classifier,
      // the background Sheet save, and history all stay on Apps Script.
      const STREAM_WEBHOOK = 'https://randy-stream.aadsit7.workers.dev';

      // Q&As are grouped into conversations by session id. "New chat" rotates
      // it, so the next questions land in a fresh History entry.
      function genSessionId() {
        return 'S-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
      }
      let SESSION_ID = genSessionId();

      const SETTINGS_KEY = 'recast_chatbot_settings';
      // Legacy key from when history was cached on disk. Never written
      // anymore — kept only so startup can clear stale data from old builds.
      const HISTORY_KEY  = 'recast_chat_history';

      /* ================================================================
       * IDENTITY — anonymous install id + one-time name capture
       *
       * On first run we mint a random anonymous id (crypto.randomUUID) and store
       * it in chrome.storage.local under "anon_user_id"; every later run reads
       * the same id back, so one install keeps one id forever. The first time the
       * panel opens we also ask once for the user's first/last name and store it
       * under "user_name"; after that the name screen never appears again.
       *
       * chrome.storage is async, so loadIdentity() runs at boot and the rest of
       * the panel waits on it — the anon id is always in hand BEFORE the first
       * API call goes out. Only the opaque id is ever sent to the model
       * (metadata.user_id); the name travels only to the usage sheet, never to
       * the API.
       * ================================================================ */
      const ANON_ID_KEY   = 'anon_user_id';
      const USER_NAME_KEY = 'user_name';
      const IDENTITY = { anonId: null, userName: null, loaded: false };

      // Promise wrappers over chrome.storage.local. Guarded so the panel still
      // runs if it's ever opened outside an extension context (storage no-ops).
      function storageGet(keys) {
        return new Promise(resolve => {
          try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve({});
            chrome.storage.local.get(keys, res => resolve(res || {}));
          } catch { resolve({}); }
        });
      }
      function storageSet(obj) {
        return new Promise(resolve => {
          try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return resolve();
            chrome.storage.local.set(obj, () => resolve());
          } catch { resolve(); }
        });
      }

      function newAnonId() {
        try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
        // Fallback for the (vanishingly rare) case randomUUID is unavailable.
        return 'anon-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }

      // Synchronous (localStorage) mirror of "has this install finished
      // onboarding?". chrome.storage.local is async, so without this hint every
      // reload would have to wait on it before knowing whether to show the tool —
      // flashing a frame and delaying the mic auto-start each time. The hint lets
      // an already-onboarded install render the normal tool and start listening
      // INSTANTLY; chrome.storage stays the source of truth for the real id +
      // name (loaded in the background, always ready before any API call).
      // localStorage is synchronous and available on extension pages.
      const ONBOARDED_HINT_KEY = 'randy_onboarded';
      function readOnboardedHint() {
        try { return localStorage.getItem(ONBOARDED_HINT_KEY) === '1'; } catch { return false; }
      }
      function writeOnboardedHint(done) {
        try {
          if (done) localStorage.setItem(ONBOARDED_HINT_KEY, '1');
          else localStorage.removeItem(ONBOARDED_HINT_KEY);
        } catch {}
      }

      // loadIdentity runs exactly once; everything awaits this shared promise so
      // the anon id is guaranteed present before the first API call.
      let _identityPromise = null;
      function ensureIdentity() {
        if (!_identityPromise) _identityPromise = loadIdentity();
        return _identityPromise;
      }

      // Load the anon id (minting + persisting it once on first run) and any
      // saved name. Always resolves with IDENTITY populated and loaded=true.
      async function loadIdentity() {
        const res = await storageGet([ANON_ID_KEY, USER_NAME_KEY]);
        let anonId = res[ANON_ID_KEY];
        if (!anonId || typeof anonId !== 'string') {
          anonId = newAnonId();
          await storageSet({ [ANON_ID_KEY]: anonId });
        }
        IDENTITY.anonId = anonId;
        const nm = res[USER_NAME_KEY];
        if (nm && typeof nm === 'object' && nm.firstName && nm.lastName) {
          IDENTITY.userName = { firstName: String(nm.firstName), lastName: String(nm.lastName) };
        }
        IDENTITY.loaded = true;
        // Keep the synchronous fast-path hint in step with the source of truth.
        writeOnboardedHint(!!IDENTITY.userName);
        return IDENTITY;
      }

      function onboardingComplete() {
        return !!(IDENTITY.userName && IDENTITY.userName.firstName && IDENTITY.userName.lastName);
      }
      function identityFullName() {
        const n = IDENTITY.userName;
        return n ? (n.firstName + ' ' + n.lastName).trim() : '';
      }

      // Whether to show the normal tool right now. True once onboarding is
      // confirmed, OR — before the async identity load finishes — when the
      // synchronous hint says this install already onboarded. That second clause
      // is what keeps reloads instant and flash-free.
      function shouldShowApp() {
        return onboardingComplete() || (!IDENTITY.loaded && readOnboardedHint());
      }

      // Persist the one-time name and guarantee the anon id exists, then let the
      // normal tool take over. Returns false if either field is blank.
      async function saveUserName(firstName, lastName) {
        firstName = String(firstName || '').trim();
        lastName  = String(lastName  || '').trim();
        if (!firstName || !lastName) return false;
        if (!IDENTITY.anonId) {
          IDENTITY.anonId = newAnonId();
          await storageSet({ [ANON_ID_KEY]: IDENTITY.anonId });
        }
        IDENTITY.userName = { firstName, lastName };
        await storageSet({ [USER_NAME_KEY]: IDENTITY.userName });
        writeOnboardedHint(true);
        return true;
      }

      /* ================================================================
       * STATE
       * ================================================================ */

      function makeSlot() {
        return {
          label: 'Randy',
          prompt: RANDY_PERSONA,        // editable persona core (Settings)
          messages: [],                 // {role, content, kind?, spoken?, sources?}
          inputText: '',
          loading: false,
          // The one big switch. When on, Randy passively hears the microphone
          // and the computer's sound together and answers every technical
          // question he overhears in the chat — no wake word. Always starts
          // off; turning it on needs a click (the mic permission requires one).
          listenOn: false,
          // How Randy captures audio when switched on. Chosen from the
          // "How should Randy listen?" slider each time he's turned on; the
          // last choice is remembered.
          //   'two-way' — microphone + the computer's own audio. The
          //               screen/tab-share picker pops out so the call is
          //               captured digitally, and the mic runs with echo
          //               cancellation OFF so it overhears the speakers too.
          //   'one-way' — microphone only, with echo cancellation / noise
          //               suppression / auto-gain ON so Randy picks up the
          //               user's own voice and NOT the call audio coming
          //               from the speakers. No picker pops out.
          audioMode: 'two-way',
          voiceName: 'Randy',
          voicePersonality: DEFAULT_VOICE_PERSONALITY,
          isListening: false,
          isSpeaking: false,
          abortController: null,        // abort the in-flight proxy fetch
          ttsQueue: null,               // FIFO of sentence TTS utterances
          speakAnswers: false,          // read answers out loud
          allowedDomains: DEFAULT_RESEARCH_DOMAINS.slice(),
          eventDomains: DEFAULT_EVENT_DOMAINS.slice()
        };
      }

      // Settings is gated behind this password (asked once per page load).
      // Note: this is a soft lock against casual clicks, not real security —
      // anyone reading the page source can see it.
      const SETTINGS_PASSWORD = 'recast2026';

      const STATE = {
        activeTab: 'home',
        expandedSlot: null,
        editingSlot: 0,
        historyOpen: false,
        historyConfirmDeleteId: null,
        historyQuery: '',
        // This visit's archived conversations, newest first. MEMORY ONLY by
        // design: any refresh or tab close wipes it, so visitors never see
        // each other's chats. (Q&As still log silently to the sheet.)
        sessionHistory: [],
        composerExpanded: false,
        cardMenuOpen: false,
        // The "How should Randy listen?" chooser shown when turning Randy on.
        audioChooserOpen: false,
        settingsUnlocked: false,
        // While the Settings sheet is open we pause listening (see
        // pauseListenForSettings); this remembers the capture mode to resume
        // in when Settings closes. false = nothing to resume.
        settingsResumeListen: false,
        slots: [makeSlot()]
      };

      let HISTORY_VIEW = { open: null };

      // Floating pop-out chat (Chrome's Document Picture-in-Picture).
      // The pop-out gets its own compact DOM built from STATE — nothing is
      // ever moved out of #app, since render() rebuilds #app's innerHTML
      // constantly and would orphan any adopted nodes.
      const PIP = {
        supported: 'documentPictureInPicture' in window,
        window: null,     // the open PiP window, or null
        slotIdx: null,    // slot the pop-out is pinned to
        opening: false,   // requestWindow() in flight — ignore re-clicks
        lastHtml: '',     // last message-list HTML, to skip no-op rebuilds
        collapsed: false, // minimized to the floating blue "R" icon
        swapping: false,  // mid window-swap — ignore the doomed pagehide
        restoreSize: null,// window size to bring back on expand
        unseen: 0,        // answers that landed while collapsed (badge count)
        flashNext: false, // auto-expanded mid-answer — flash the reply when it lands
        flashNow: false   // flash the newest answer on the next message rebuild
      };

      const VOICE = {
        srSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        ttsSupported: !!window.speechSynthesis,
        recognition: null,        // shared SpeechRecognition instance
        wantRunning: false,       // should the recognizer be running?
        permissionDenied: false,
        toastTimeoutId: null,
        toastMessage: '',
        playingMsg: null,         // {slot, msg} of the message currently being spoken
        interimText: '',          // live partial transcript
        interimSlot: null,
        interimAt: 0,             // when the interim transcript last changed
        lastTtsEndAt: 0,          // for the post-playback echo grace window
        ttsPaused: false,         // legacy guard flag; always false now (no TTS pause)
        recentTtsText: '',        // rolling buffer of spoken text for echo matching
        srRunning: false,         // recognizer actually running (onstart..onend)
        srStartStrikes: 0,        // consecutive watchdog ticks that found the
                                  // recognizer stopped despite trying to start —
                                  // enough strikes means rebuild it outright
        watchdogId: null,         // background-tab restart watchdog interval
        lastSrEventAt: 0,         // last recognizer activity (wedge detection)
        micStream: null,          // held open (echo cancellation OFF) so the
                                  // mic hears the computer's speakers — see
                                  // startListening()
        // Push-to-talk dictation in the pop-out composer. A SEPARATE
        // recognizer from the passive one above: the Web Speech API only
        // runs one recognizer at a time, so while dictation is live the
        // passive recognizer is paused (dictationPaused) and resumed when
        // dictation ends — see startDictation()/stopDictation().
        dictation: null,          // dedicated dictation SpeechRecognition
        dictating: false,         // dictation actively capturing the mic
        dictationPaused: false,   // passive recognizer paused for dictation
        dictationBase: '',        // finalized dictation text staged in the input
        dictationTarget: null     // where dictation writes: {kind:'pip'} or {kind:'home', slot}
      };

      // Best-effort operating-system detection so the audio-setup guidance can
      // speak to each platform accurately. It's advisory only — never a gate on
      // capability — because two facts differ by OS:
      //   1. macOS Chrome can share a browser TAB's audio but not whole-system
      //      audio; Windows Chrome can share system audio as well as a tab.
      //   2. The exact place to change the default input device differs.
      // We read the modern navigator.userAgentData.platform first (present in
      // Chromium) and fall back to navigator.platform / userAgent.
      const PLATFORM = (() => {
        let hint = '';
        try { hint = (navigator.userAgentData && navigator.userAgentData.platform) || ''; } catch {}
        if (!hint) { try { hint = navigator.platform || ''; } catch {} }
        let ua = '';
        try { ua = navigator.userAgent || ''; } catch {}
        const s = (hint + ' ' + ua).toLowerCase();
        if (/mac|iphone|ipad|ipod/.test(s)) return 'mac';
        if (/win/.test(s)) return 'win';
        return 'other';
      })();

      // Where the user changes their default microphone, per OS. Chrome's live
      // speech recognizer always captures the OS default input (it can't be
      // pointed at a specific device from JavaScript), so this is the setting
      // that actually decides what Randy hears.
      function osDefaultMicPath() {
        if (PLATFORM === 'mac') return 'System Settings → Sound → Input';
        if (PLATFORM === 'win') return 'Settings → System → Sound → Input';
        return "your operating system’s sound settings";
      }

      // The exact "share audio" wording the screen-share picker shows, per OS.
      function osShareAudioHint() {
        if (PLATFORM === 'mac') return 'pick the call’s browser tab and tick “Share tab audio” (macOS Chrome can’t share whole-system audio)';
        if (PLATFORM === 'win') return 'tick “Share system audio” (or share the call’s tab and tick “Share tab audio”)';
        return 'tick “Share tab/system audio”';
      }

      // Which microphone Randy opens. '' = the system default device
      // (recommended — and the device Chrome's live speech recognizer always
      // uses); a specific deviceId pins the capture to that input so the user
      // can switch hardware in Settings if the default device misbehaves. The
      // device list fills in lazily: browsers hide input labels until mic
      // permission has been granted at least once.
      const MIC = {
        deviceId: '',             // '' = system default, else a specific deviceId
        devices: []               // cached [{deviceId, label}] of audioinput devices
      };

      // The speaking voice the user picked in Settings, by its
      // SpeechSynthesisVoice.name. '' = automatic (Randy scores the installed
      // voices and picks the most natural — the original behaviour). A chosen
      // voice is honoured only while it's still installed; if it disappears
      // (voice packs change between sessions) Randy silently falls back to the
      // automatic pick so speech never breaks.
      const TTS = {
        chosenName: ''
      };

      // One-tap microphone check in Settings. Opens a SHORT-LIVED capture on
      // the currently selected device and paints a live input-level meter so
      // the user can confirm their mic is actually being picked up before a
      // call. It is a completely SEPARATE, temporary stream — it never touches
      // VOICE.micStream or the recognizer — and its animation loop stops itself
      // the instant the meter leaves the screen, so no navigation path can
      // leave a test capture running.
      const MICTEST = {
        active: false,
        starting: false,   // getUserMedia in flight — ignore re-clicks
        stream: null,
        audioCtx: null,
        analyser: null,
        rafId: 0,
        data: null,
        sawSound: false    // has real sound crossed the bar this run?
      };

      // Re-read the available microphones. Safe to call any time; labels only
      // appear once capture permission has been granted. Drops a pinned device
      // that has been unplugged so listening falls back to the system default.
      async function refreshMicDevices() {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
          const list = await navigator.mediaDevices.enumerateDevices();
          MIC.devices = list
            .filter(d => d.kind === 'audioinput')
            .map(d => ({ deviceId: d.deviceId, label: d.label || '' }));
          // Only prune a pinned device we can trust is really gone. Before mic
          // permission has been granted this session, enumerateDevices() returns
          // entries with blank deviceIds/labels; pruning the pin against that
          // placeholder list would wrongly forget a valid saved device. Require
          // at least one real (non-blank) deviceId before deciding it's missing.
          const haveRealIds = MIC.devices.some(d => d.deviceId);
          if (MIC.deviceId && haveRealIds && !MIC.devices.some(d => d.deviceId === MIC.deviceId)) {
            MIC.deviceId = '';
            try { saveSettings(); } catch {}
          }
          if (STATE.activeTab === 'settings') render();
        } catch {}
      }

      // Keep the device list fresh when mics are plugged in or removed.
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
          navigator.mediaDevices.addEventListener('devicechange', () => { try { refreshMicDevices(); } catch {} });
        }
      } catch {}

      // Open the held keep-alive mic capture on the chosen device, with the
      // audio-processing constraints each listening mode needs. A pinned device
      // that's gone is forgotten and retried on the system default before giving
      // up, so an unplugged mic can never strand listening. Returns 'ok' or a
      // failure code ('denied' | 'no-device' | 'transient'); the caller toasts.
      async function acquireMicStream(twoWay) {
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return 'ok';
        const proc = twoWay
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        const open = (device) => navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: device }, proc) });
        const codeFor = (err) => {
          const name = err && err.name ? err.name : '';
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
          if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no-device';
          return 'transient';
        };
        try {
          VOICE.micStream = await open(MIC.deviceId ? { exact: MIC.deviceId } : { ideal: 'default' });
        } catch (err) {
          const code = codeFor(err);
          if (code === 'no-device' && MIC.deviceId) {
            // The pinned mic is unavailable — drop the pin and fall back to the
            // system default before reporting a hard failure.
            MIC.deviceId = '';
            try { saveSettings(); } catch {}
            try { VOICE.micStream = await open({ ideal: 'default' }); }
            catch (e2) { return codeFor(e2); }
          } else {
            return code;
          }
        }
        VOICE.micStream.getTracks().forEach(t => { t.onended = () => { VOICE.micStream = null; }; });
        // Capture is granted now, so device labels are finally readable.
        refreshMicDevices();
        return 'ok';
      }

      // The label of the device Chrome's speech recognizer actually
      // transcribes — the OS default input. enumerateDevices exposes it as the
      // 'default' pseudo-device on most platforms; we strip the "Default - "
      // prefix browsers add. Returns '' when the OS default can't be named
      // (e.g. before permission, or on platforms without the pseudo-device).
      function osDefaultMicLabel() {
        const def = MIC.devices.find(d => d.deviceId === 'default' && d.label);
        if (def) return def.label.replace(/^Default\s*[-–—]\s*/i, '').trim();
        return '';
      }

      // Start the Settings mic check. Opens its OWN capture on the selected
      // device (processing left on — we only need to show sound is arriving)
      // and kicks off the level-meter loop. Fully independent of listening.
      async function startMicTest() {
        if (MICTEST.active || MICTEST.starting) return;
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
          showToast('This browser can’t open the microphone for a test.');
          return;
        }
        MICTEST.starting = true;
        MICTEST.sawSound = false;
        let stream;
        try {
          const dev = MIC.deviceId ? { exact: MIC.deviceId } : { ideal: 'default' };
          stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev } });
        } catch (err) {
          MICTEST.starting = false;
          const name = (err && err.name) || '';
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') showToast('Allow microphone access to run the test.');
          else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') showToast('That microphone isn’t available — pick another and try again.');
          else showToast('Couldn’t start the microphone test — try again.');
          return;
        }
        // Labels become readable once capture is granted.
        try { refreshMicDevices(); } catch {}
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          MICTEST.audioCtx = new Ctx();
          if (MICTEST.audioCtx.state === 'suspended') { try { await MICTEST.audioCtx.resume(); } catch {} }
          const src = MICTEST.audioCtx.createMediaStreamSource(stream);
          const an = MICTEST.audioCtx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          MICTEST.analyser = an;
          MICTEST.data = new Uint8Array(an.fftSize);
        } catch (err) {
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          if (MICTEST.audioCtx) { try { MICTEST.audioCtx.close(); } catch {} MICTEST.audioCtx = null; }
          MICTEST.starting = false;
          showToast('Couldn’t start the microphone test — try again.');
          return;
        }
        MICTEST.stream = stream;
        MICTEST.active = true;
        MICTEST.starting = false;
        render();          // draw the meter shell
        micTestTick();     // begin the animation loop
      }

      // Self-terminating level-meter loop. Reads the input peak each frame and
      // paints the bar/status by id. If the meter element has left the DOM
      // (user navigated away from Settings, panel closing, a full re-render
      // without the meter), it stops the whole test — so a capture can never
      // outlive the meter that owns it.
      function micTestTick() {
        if (!MICTEST.active || !MICTEST.analyser) return;
        const bar = document.getElementById('mic-test-bar');
        if (!bar) { stopMicTest(); return; }
        MICTEST.analyser.getByteTimeDomainData(MICTEST.data);
        let peak = 0;
        for (let i = 0; i < MICTEST.data.length; i++) {
          const dev = Math.abs(MICTEST.data[i] - 128);
          if (dev > peak) peak = dev;
        }
        const level = Math.min(1, (peak / 128) * 1.6);   // 0..1, lightly boosted for visibility
        bar.style.width = Math.round(level * 100) + '%';
        bar.style.background = level > 0.02 ? '#0F7A3F' : '#cbd5e1';
        if (level > 0.05) MICTEST.sawSound = true;
        const status = document.getElementById('mic-test-status');
        if (status) {
          status.textContent = MICTEST.sawSound
            ? 'Picking up sound ✓ — this microphone is working.'
            : 'Listening… speak now and watch the bar move.';
          status.style.color = MICTEST.sawSound ? '#0F7A3F' : '#64748b';
        }
        MICTEST.rafId = requestAnimationFrame(micTestTick);
      }

      function stopMicTest() {
        const wasActive = MICTEST.active;
        MICTEST.active = false;
        if (MICTEST.rafId) { try { cancelAnimationFrame(MICTEST.rafId); } catch {} MICTEST.rafId = 0; }
        if (MICTEST.stream) { try { MICTEST.stream.getTracks().forEach(t => t.stop()); } catch {} MICTEST.stream = null; }
        if (MICTEST.audioCtx) { try { MICTEST.audioCtx.close(); } catch {} MICTEST.audioCtx = null; }
        MICTEST.analyser = null;
        MICTEST.data = null;
        if (wasActive && STATE.activeTab === 'settings') render();
      }

      // Listening runtime state. Randy hears on two channels: (1) the
      // microphone via the Web Speech recognizer — which also overhears the
      // call on the speakers, but only with echo cancellation / noise
      // suppression / auto-gain disabled (see startListening), and only when
      // the user isn't on headphones; and (2) the computer's audio captured
      // digitally through the share picker and transcribed locally by an
      // in-browser Whisper model (see DESKTOP / startDesktopCapture), which
      // works on headphones too. Both channels feed the same pipeline below.
      const TECH = {
        lastErrorToastAt: 0,      // throttle pipeline-failure toasts
        buffer: '',               // join buffer for ASR fragments
        bufferTimerId: null,
        deferrals: 0,
        pending: false,           // classifier call in flight
        pendingSince: 0,          // when the classifier gate started (wedge detection)
        answerSince: 0,           // when the current overheard answer started (wedge detection)
        classifyController: null, // aborts a wedged classifier round-trip
        classifyGen: 0,           // epoch — a stale classify resolution is ignored
        watchdogId: null,         // self-healing pipeline watchdog interval
        activeText: '',           // utterance currently being analyzed/answered (for the live band)
        questionQueue: [],        // FIFO of questions overheard while Randy was busy
        context: [],              // recent utterances for the classifier
        lastSubmitted: '',
        lastSubmittedAt: 0,
        decisions: [],            // ring buffer {text, accepted, confidence, topic, ts}
        recentPairs: [],          // last assist Q&As — API context that survives chat archiving
        heard: 0,
        answered: 0,
        perf: null                // active latency timeline for the question being answered (instrumentation)
      };

      function listeningOn() { return STATE.slots[0].listenOn; }

      // Desktop/computer-audio capture + fully in-browser transcription.
      //
      // The mic path above can only hear computer sound acoustically (the mic
      // overhearing the speakers), which fails the moment the user wears
      // headphones. This path taps the computer's audio DIGITALLY via the
      // screen/tab-share picker (getDisplayMedia) and transcribes it with a
      // Whisper model that runs locally in the browser (WebGPU, WASM
      // fallback) — no audio ever leaves the machine, no API key, and it
      // works identically on speakers or headphones. Its transcripts feed the
      // exact same answer pipeline the microphone uses (handleVoiceTranscript
      // / updateInterim). Optional: if the user dismisses the picker, Randy
      // falls back to mic-only just like before.
      const DESKTOP = {
        supported: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia &&
                      typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined'),
        on: false,                // is digital computer-audio capture running?
        stream: null,             // getDisplayMedia stream (audio + a stopped video track)
        audioCtx: null,           // 16 kHz context that feeds the transcriber
        sourceNode: null,
        procNode: null,           // ScriptProcessor pulling raw PCM
        worker: null,             // Whisper inference worker (Blob module)
        workerReady: false,
        modelLoading: false,
        device: '',               // 'webgpu' | 'wasm' once known
        statusText: '',           // shown in the live strip
        // Voice-activity segmentation over the incoming PCM.
        seg: [],                  // Float32 chunks of the current utterance
        segLen: 0,                // samples buffered in seg
        speaking: false,
        silenceRun: 0,            // consecutive silent samples
        voicedRun: 0,             // consecutive voiced samples in the open segment
        noiseFloor: 0.002,        // adaptive ambient-noise estimate (EMA while idle)
        preRoll: [],              // ring of recent silent frames (onset pre-roll)
        preRollLen: 0,            // samples buffered in preRoll
        reqId: 0,                 // monotonic id for inference requests
        inFlight: 0,              // outstanding worker jobs (single-flight gate)
        lastInterimAt: 0          // throttle for live partial transcriptions
      };

      // Whisper sample rate, plus VAD/segmentation tuning. Chosen so a normal
      // spoken question finalizes ~0.7 s after the speaker stops, while a long
      // monologue still flushes periodically instead of growing unbounded.
      //
      // Voice activity uses an ADAPTIVE dual-threshold detector (see
      // processDesktopBlock): a noise floor is tracked while the line is quiet
      // and the open/close thresholds ride a little above it. In a silent room
      // the open threshold stays pinned to SILENCE_RMS (so behaviour matches the
      // old fixed detector), but in a noisy room — fans, HVAC, a hot mic on the
      // call — the bar rises so steady background hum no longer trips Whisper
      // into transcribing (and hallucinating over) non-speech. The lower close
      // threshold adds hysteresis so a brief dip mid-word doesn't split one
      // sentence into two, and a short pre-roll keeps the audio just BEFORE the
      // onset so the first word isn't clipped (Whisper mis-reads clipped onsets).
      const ASR = {
        SAMPLE_RATE: 16000,
        SILENCE_RMS: 0.006,       // absolute floor for the OPEN threshold (quiet-room default)
        CLOSE_FLOOR: 0.004,       // absolute floor for the CLOSE threshold (< open ⇒ hysteresis)
        NOISE_OPEN_FACTOR: 1.8,   // open a segment when rms ≥ noiseFloor × this
        NOISE_CLOSE_FACTOR: 1.3,  // keep it open while rms ≥ noiseFloor × this
        NOISE_FLOOR_MAX: 0.012,   // clamp so loud rooms can't raise the bar past real speech
        NOISE_FLOOR_INIT: 0.002,  // starting noise estimate before any audio arrives
        PREROLL_MS: 300,          // audio kept before the onset so the first word survives
        SILENCE_MS: 700,          // trailing silence that ends an utterance
        MIN_VOICED_MS: 250,       // ignore blips shorter than this
        MAX_SEG_MS: 18000,        // hard flush so long talk still transcribes live
        INTERIM_MS: 1400,         // how often to refresh the live partial
        MAX_TAIL_S: 24            // cap the audio sent per inference (seconds)
      };

      /* ================================================================
       * SETTINGS PERSISTENCE
       * ================================================================ */

      function saveSettings() {
        const data = STATE.slots.map(s => ({
          label: s.label,
          prompt: s.prompt,
          voiceName: s.voiceName,
          voicePersonality: s.voicePersonality,
          speakAnswers: !!s.speakAnswers,
          audioMode: s.audioMode === 'one-way' ? 'one-way' : 'two-way',
          micDeviceId: MIC.deviceId || '',
          ttsVoiceName: TTS.chosenName || '',
          allowedDomains: s.allowedDomains,
          eventDomains: s.eventDomains
        }));
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch {}
      }

      // Marker strings unique to previous default prompts. If the stored prompt
      // contains any of these we treat it as an unmodified prior default and
      // refresh to RANDY_PERSONA, so persona updates reach returning users
      // without clobbering anyone who actually customized their prompt.
      const LEGACY_PROMPT_MARKERS = [
        "Recast Software's Application Workspace expert",
        'ABSOLUTE RULE — NO EXCEPTIONS',
        // Distinctive line from the persona default that shipped before the
        // "Honesty About Capabilities" section was added. Returning users have
        // that older default cached; matching it here refreshes them to the
        // current RANDY_PERSONA so the honesty rules actually reach them.
        'Your research process is invisible.'
      ];

      function loadSettings() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (!raw) return;
          const data = JSON.parse(raw);
          data.forEach((d, i) => {
            const s = STATE.slots[i];
            if (!s) return;
            s.label = (d.label && d.label !== 'Recast SE') ? d.label : s.label;
            const storedPrompt = d.prompt || '';
            const isLegacyDefault = storedPrompt && LEGACY_PROMPT_MARKERS.some(m => storedPrompt.includes(m));
            s.prompt = (isLegacyDefault ? '' : storedPrompt) || s.prompt;
            s.voiceName = d.voiceName || s.label;
            s.voicePersonality = d.voicePersonality || DEFAULT_VOICE_PERSONALITY;
            // speakAnswers (migrating the older speakResponses key)
            s.speakAnswers = !!(d.speakAnswers !== undefined ? d.speakAnswers : d.speakResponses);
            if (d.audioMode === 'one-way' || d.audioMode === 'two-way') s.audioMode = d.audioMode;
            if (Array.isArray(d.allowedDomains)) {
              s.allowedDomains = d.allowedDomains.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
            }
            if (Array.isArray(d.eventDomains)) {
              s.eventDomains = d.eventDomains.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
            }
          });
          // The chosen microphone is global, not per-slot — read it off the
          // first record. Validated against the live device list once labels
          // load (refreshMicDevices), so a stale id can't strand listening.
          if (data[0] && typeof data[0].micDeviceId === 'string') MIC.deviceId = data[0].micDeviceId;
          // The chosen speaking voice is also global (one voice for Randy),
          // read off the first record. Validated against the live voice list at
          // speak time (resolveVoice), so a voice that's since been uninstalled
          // just falls back to the automatic pick.
          if (data[0] && typeof data[0].ttsVoiceName === 'string') TTS.chosenName = data[0].ttsVoiceName;
        } catch {}
        // Listening always starts OFF — the screen-share picker needs a click.
        // The proxy URL used to be overridable per-browser, which left some
        // machines pointing at dead deployments. Drop any saved override so
        // every computer uses the hardcoded GSHEET_WEBHOOK.
        try { localStorage.removeItem('recast_gsheet_url'); } catch {}
      }

      /* ================================================================
       * HISTORY (memory-only, this visit only)
       *
       * STATE.sessionHistory is the sole source for the side panel. Nothing
       * is ever fetched back from the sheet and nothing is persisted to
       * disk, so each device/session only ever sees its own conversations
       * and a refresh or tab close starts clean. Q&As still flow UP to the
       * sheet (postChat / postSaveToSheet) as a silent per-session log.
       * ================================================================ */

      // One-time cleanup: older builds cached synced history on disk under
      // HISTORY_KEY. Clear it so returning devices don't keep stale chats.
      try { localStorage.removeItem(HISTORY_KEY); } catch {}

      // Assist answers must open with "**Short answer:**". Models occasionally
      // ad-lib a fake-out first ("Great question! ... Just kidding. Here's
      // the real answer:"). Two passes, both anchored so they can't damage
      // a genuine answer: peel known opener patterns off the start, then if
      // the bolded Short-answer marker still sits past the start, cut to it.
      function sanitizeAssistAnswer(text) {
        let t = String(text || '').trim();
        let prev;
        do {
          prev = t;
          t = t
            .replace(/^\**(?:great|good|excellent|awesome|fantastic) question\b[.!…:]*\**\s*/i, '')
            .replace(/^let me (?:explain|walk you through|break (?:this|that|it) down)\b[^\n.!?]*[.!?…]*\s*/i, '')
            .replace(/^just kidding\b[.!,…]*\s*/i, '')
            .replace(/^(?:here'?s|now for) the (?:real|actual|serious) answer[.!:]*\s*/i, '')
            .trim();
        } while (t !== prev);
        const m = t.match(/\*\*\s*short\s+answer\s*:?\s*\*\*/i);
        if (m && m.index > 0 && m.index < 200) t = t.slice(m.index).trim();
        return t || String(text || '').trim();
      }

      function entryMs(entry) {
        let ts = Number(entry && entry.timestamp) || 0;
        if (!ts && entry && entry.date) {
          const parsed = Date.parse(entry.date);
          if (!isNaN(parsed)) ts = parsed;
        }
        return ts;
      }

      function formatHistoryDate(entry) {
        const ts = entryMs(entry);
        if (!ts) return entry && entry.date ? String(entry.date) : '';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (diff === 0) return 'Today, ' + time;
        if (diff === 1) return 'Yesterday, ' + time;
        if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ', ' + time;
        if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }

      // Compact stamp for the list items: the group header already says
      // "Today"/"Yesterday", so inside those buckets the time alone is enough.
      function formatHistoryTime(entry) {
        const ts = entryMs(entry);
        if (!ts) return entry && entry.date ? String(entry.date) : '';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (diff <= 1) return time;
        if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ', ' + time;
        if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }

      function filterHistory(history, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return history;
        return history.filter(h =>
          (h.preview || '').toLowerCase().includes(q) ||
          h.pairs.some(p =>
            p.question.toLowerCase().includes(q) ||
            p.answer.toLowerCase().includes(q)));
      }

      function historyBucket(entry) {
        const ts = entryMs(entry);
        if (!ts) return 'Earlier';
        const d = new Date(ts);
        const now = new Date();
        const sod = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((sod(now) - sod(d)) / 86400000);
        if (diff <= 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return 'Earlier this week';
        if (diff < 30) return 'Earlier this month';
        if (d.getFullYear() === now.getFullYear()) return 'Earlier this year';
        return 'Older';
      }

      const HISTORY_BUCKET_ORDER = ['Today', 'Yesterday', 'Earlier this week', 'Earlier this month', 'Earlier this year', 'Older'];

      function groupHistoryByBucket(history) {
        const groups = {};
        for (const h of history) {
          const k = historyBucket(h);
          (groups[k] = groups[k] || []).push(h);
        }
        return HISTORY_BUCKET_ORDER
          .filter(k => groups[k] && groups[k].length)
          .map(k => ({ label: k, items: groups[k] }));
      }

      // Newest first; capped so a marathon visit can't grow memory unbounded.
      function addSessionHistoryEntry(entry) {
        STATE.sessionHistory.unshift(entry);
        if (STATE.sessionHistory.length > 50) STATE.sessionHistory.length = 50;
      }

      function collectPairs(slot) {
        const pairs = [];
        for (let i = 0; i < slot.messages.length - 1; i++) {
          const m = slot.messages[i];
          const next = slot.messages[i + 1];
          if (m.role === 'user' && next && next.role === 'assistant' && next.content) {
            pairs.push({ question: String(m.content || ''), answer: String(next.content || '') });
          }
        }
        return pairs;
      }

      // Tuck the current conversation into this visit's History panel and
      // reset the chat to empty. The sheet already has every answered Q&A
      // (the client saves each one in the background), so nothing is lost.
      // Rotating the session id keeps the sheet's grouping in step with the
      // local entry. Returns true when something was actually archived.
      function archiveChatToHistory(slot) {
        const pairs = collectPairs(slot);
        if (!pairs.length) return false;
        const ts = Date.now();
        addSessionHistoryEntry({
          id: SESSION_ID + '-' + ts,
          session_id: SESSION_ID,
          date: new Date(ts).toLocaleDateString('en-US'),
          timestamp: ts,
          pairs,
          preview: pairs[0].question.substring(0, 120)
        });
        slot.messages = [];
        SESSION_ID = genSessionId();
        return true;
      }

      // "New chat": archive and start fresh.
      function newChat() {
        const slot = STATE.slots[0];
        if (slot.abortController) { try { slot.abortController.abort(); } catch {} slot.abortController = null; }
        teardownTtsQueue(0);
        if (slot.isSpeaking) stopSpeaking();
        abortActiveReply();   // cancel any in-flight reply and stop any audio
        slot.loading = false;
        const archived = archiveChatToHistory(slot);
        if (!archived) {
          slot.messages = [];
          SESSION_ID = genSessionId();
        }
        slot.inputText = '';
        showToast(archived ? 'New chat — the old one is saved in History' : 'New chat');
        render();
      }

      // Local-only: removes the entry from this visit's panel. The sheet log
      // is an untouched audit record — no delete request is ever sent.
      function deleteHistoryEntry(id) {
        STATE.sessionHistory = STATE.sessionHistory.filter(h => h.id !== id);
      }

      /* ================================================================
       * PROXY HEALTH
       * ================================================================ */

      const PROXY = { ready: false, hasKey: false, error: null };

      async function loadRemoteConfig() {
        if (!GSHEET_WEBHOOK) return;
        try {
          const resp = await fetch(GSHEET_WEBHOOK + (GSHEET_WEBHOOK.includes('?') ? '&' : '?') + 'action=ping');
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const info = await resp.json();
          PROXY.ready = !!info.ok;
          PROXY.hasKey = !!info.has_api_key;
          PROXY.error = info.ok ? null : (info.error || 'Proxy returned an error');
        } catch (err) {
          PROXY.ready = false;
          PROXY.error = err && err.message ? err.message : 'Proxy unreachable';
          console.warn('Proxy ping failed:', err);
        }
      }

      // Keep the Apps Script proxy warm while Randy is listening. Apps Script
      // spins its instance down after a few idle minutes; the next request then
      // pays a 0.5–2 s cold start — and on a live call that tax lands on the
      // FIRST overheard question, exactly when it's most noticeable. A cheap
      // periodic GET to the lightweight ping endpoint keeps the instance warm so
      // the first real answer doesn't eat it. Fire-and-forget: it never mutates
      // PROXY readiness state, so a transient blip can't flip the UI.
      let proxyWarmId = null;
      function pingProxyWarm() {
        if (!GSHEET_WEBHOOK) return;
        const url = GSHEET_WEBHOOK + (GSHEET_WEBHOOK.includes('?') ? '&' : '?') + 'action=ping';
        fetch(url, { method: 'GET' }).catch(() => {});
      }
      function startProxyWarmup() {
        if (proxyWarmId || !GSHEET_WEBHOOK) return;
        pingProxyWarm(); // warm immediately, then on a cadence below the spindown window
        proxyWarmId = setInterval(pingProxyWarm, ASSIST.PROXY_WARM_MS);
      }
      function stopProxyWarmup() {
        if (proxyWarmId) { clearInterval(proxyWarmId); proxyWarmId = null; }
      }

      /* ================================================================
       * LATENCY INSTRUMENTATION (overheard question → spoken answer)
       *
       * "You can't shave milliseconds you can't see." Each finalized question
       * gets a timeline; stage durations and the answer call's prompt-cache
       * usage are logged to the console and kept in a small ring buffer at
       * window.__randyPerf for ad-hoc inspection. This is pure measurement — it
       * never changes behaviour, the answer, or the pipeline's control flow.
       *
       * Cache health: the ~2K-token persona/style prefix is wrapped for
       * Anthropic prompt caching (systemBlocks). On a warm call the answer's
       * usage should show cache_read_input_tokens ≫ cache_creation_input_tokens;
       * if reads stay 0 across calls, the cache isn't hitting and the persona is
       * being reprocessed every time (wasted input-processing latency).
       * ================================================================ */
      const PERF = { enabled: true, log: [], KEEP: 20 };
      function perfStart(question) {
        if (!PERF.enabled) return null;
        return { question: truncate(question, 80), t0: performance.now(), marks: {}, cache: {} };
      }
      function perfMark(t, name) {
        if (t && t.marks[name] == null) t.marks[name] = performance.now();
      }
      function perfCache(t, usage, label) {
        if (!t || !usage) return;
        t.cache[label] = {
          read: usage.cache_read_input_tokens || 0,
          created: usage.cache_creation_input_tokens || 0,
          input: usage.input_tokens || 0
        };
      }
      function perfFinish(t, status) {
        if (!t || t._done) return;
        t._done = true;
        const m = t.marks;
        const seg = (a, b) => (m[a] != null && m[b] != null) ? Math.round(m[b] - m[a]) : null;
        const endRef = m.firstAudio != null ? m.firstAudio : (m.answerEnd != null ? m.answerEnd : performance.now());
        const ans = t.cache && t.cache.answer;
        const summary = {
          status: status || 'done',
          total_ms: Math.round(endRef - t.t0),
          classify_ms: seg('classifyStart', 'classifyEnd'),
          answer_ms: seg('answerStart', 'answerEnd'),
          to_first_audio_ms: m.firstAudio != null ? Math.round(m.firstAudio - t.t0) : null,
          cache_hit: ans ? (ans.read > 0) : null,
          cache: t.cache,
          question: t.question
        };
        PERF.log.push(summary);
        while (PERF.log.length > PERF.KEEP) PERF.log.shift();
        try { window.__randyPerf = PERF.log; } catch {}
        const parts = ['[perf] ' + summary.status, 'total=' + summary.total_ms + 'ms'];
        if (summary.classify_ms != null) parts.push('classify=' + summary.classify_ms + 'ms');
        if (summary.answer_ms != null) parts.push('answer=' + summary.answer_ms + 'ms');
        if (summary.to_first_audio_ms != null) parts.push('→firstAudio=' + summary.to_first_audio_ms + 'ms');
        if (ans) parts.push('cache:read=' + ans.read + '/created=' + ans.created);
        console.info(parts.join(' ') + ' — "' + summary.question + '"');
        if (TECH.perf === t) TECH.perf = null;
      }

      loadSettings();

      /* ================================================================
       * TEXT HELPERS + SAFE MARKDOWN RENDERER
       * ================================================================ */

      function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
      function truncate(s, n) {
        s = String(s || '');
        return s.length > n ? s.substring(0, n - 1) + '…' : s;
      }

      // Minimal, safe markdown → HTML for assist answers. All input is
      // HTML-escaped first; only a small whitelist of constructs is then
      // re-introduced (bold, inline code, http(s) links, bullet/numbered
      // lists, mini headers). No raw HTML ever passes through.
      function mdInline(escaped) {
        return escaped
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      }

      function mdToHtml(raw) {
        const lines = String(raw || '').split('\n');
        const out = [];
        let list = null; // 'ul' | 'ol' | null
        const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
        for (const lineRaw of lines) {
          const line = lineRaw.trim();
          if (!line) { closeList(); continue; }
          const esc = mdInline(escHtml(line.replace(/^#{1,4}\s+(.*)$/, '$1')));
          const bullet = line.match(/^[-*•]\s+(.*)$/);
          const num = line.match(/^\d+[.)]\s+(.*)$/);
          if (bullet) {
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push('<li>' + mdInline(escHtml(bullet[1])) + '</li>');
          } else if (num) {
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push('<li>' + mdInline(escHtml(num[1])) + '</li>');
          } else if (/^#{1,4}\s+/.test(line)) {
            closeList();
            out.push('<div class="md-h">' + esc + '</div>');
          } else {
            closeList();
            out.push('<p>' + esc + '</p>');
          }
        }
        closeList();
        return out.join('');
      }

      // Split an assist reply into the visible answer and the spoken summary.
      function splitSpoken(reply) {
        const parts = String(reply || '').split(/\n?=+\s*SPOKEN\s*=+\s*\n?/i);
        const main = (parts[0] || '').trim();
        let spoken = (parts[1] || '').trim();
        if (!spoken) spoken = extractSummary(stripMarkdown(main));
        return { main, spoken };
      }

      function stripMarkdown(text) {
        return String(text)
          .replace(/```[\s\S]*?```/g, ' ')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/__([^_]+)__/g, '$1')
          .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
          .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/^\s*[-*+•]\s+/gm, '')
          .replace(/^\s*\d+[.)]\s+/gm, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
          .replace(/^\s*>\s?/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      // Split a rendered answer into the TL;DR sentence and the detail body
      // for the answer card. The assist prompt opens every reply with
      // "**Short answer:** …" on its own line; that line becomes the card's
      // TL;DR strip and everything after it becomes the detail bullets.
      // Replies that arrive without the marker (model drift, older history)
      // fall back to the first sentence, so the strip is never empty and no
      // text is ever dropped — every character lands in one zone or the other.
      function splitAnswerParts(content) {
        const text = String(content || '').trim();
        const marker = text.match(/^\*\*\s*short\s+answer\s*:?\s*\*\*[:\s]*/i);
        if (marker) {
          const rest = text.slice(marker[0].length);
          const nl = rest.indexOf('\n');
          if (nl === -1) return { short: rest.trim(), detail: '' };
          return { short: rest.slice(0, nl).trim(), detail: rest.slice(nl + 1).trim() };
        }
        const nl = text.indexOf('\n');
        const firstLine = (nl === -1 ? text : text.slice(0, nl)).replace(/^[-*•]\s+/, '');
        const sm = firstLine.match(/^.*?[.!?](?=\s|$)/);
        const short = (sm ? sm[0] : firstLine).trim();
        const lineRest = sm ? firstLine.slice(sm[0].length).trim() : '';
        const tail = nl === -1 ? '' : text.slice(nl + 1).trim();
        return { short, detail: [lineRest, tail].filter(Boolean).join('\n') };
      }

      // First ~2 sentences (max 300 chars) of a plain-text blob, for TTS.
      function extractSummary(text) {
        const clean = String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        const m = clean.match(/^.*?[.!?](?:\s+.*?[.!?])?/);
        const s = m ? m[0] : clean;
        return s.substring(0, 300);
      }

      // Copy text to the clipboard with a toast + brief "copied" state on btn.
      function copyTextToClipboard(text, btn) {
        const done = () => {
          showToast('Answer copied');
          if (btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1200);
          }
        };
        const fail = () => showToast('Copy failed');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fail);
        } else {
          try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            done();
          } catch { fail(); }
        }
      }

      // Silently copy a finished answer to the clipboard the moment it's
      // shown, so the user can paste it straight into an email without ever
      // clicking the copy button. Unlike copyTextToClipboard this stays quiet
      // — no toast, no button highlight — because it fires automatically on
      // every answer (including overheard ones mid-call) and shouldn't nag.
      // The manual copy button still gives explicit feedback when used.
      function autoCopyAnswer(text) {
        const t = String(text || '').trim();
        if (!t) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).catch(() => {
            // Clipboard may reject without focus/permission; the copy button
            // remains available as the explicit fallback. Stay silent.
          });
          return;
        }
        try {
          const ta = document.createElement('textarea');
          ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch { /* best-effort; manual copy button still works */ }
      }

      function hostnameOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
      }

      // Turn a source URL into a readable, distinguishing chip label derived
      // purely from the URL string (no network). Falls back to hostnameOf on
      // any parse failure so behavior degrades to the old site-name label.
      function sourceLabelOf(url) {
        let u;
        try { u = new URL(url); } catch { return hostnameOf(url); }

        const host = u.hostname.replace(/^www\./, '');
        let category;
        switch (host) {
          case 'docs.recastsoftware.com': category = 'Recast Docs'; break;
          case 'recastsoftware.com':      category = 'Recast'; break;
          case 'docs.liquit.com':         category = 'Liquit Docs'; break;
          case 'learn.microsoft.com':     category = 'Microsoft Learn'; break;
          default:                        category = hostnameOf(url);
        }

        // Build a page name from the path's last meaningful segment.
        const segs = u.pathname.split('/').filter(Boolean);
        let seg = segs.pop() || '';
        if (!seg || /^(index|#)/i.test(seg)) seg = segs.pop() || '';
        seg = seg.replace(/\.(html?|aspx)$/i, '');

        let pageName = '';
        try { pageName = decodeURIComponent(seg); } catch { pageName = seg; }
        pageName = pageName
          .replace(/[-_]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1));

        if (pageName) {
          const label = `${category} · ${pageName}`;
          return label.length > 80 ? label.slice(0, 80) : label;
        }
        return category;
      }

      // Only http(s) URLs are safe in an href. Source URLs arrive from the model/
      // proxy (web_search results), so a stray javascript:/data: scheme could in
      // theory become a clickable source chip that runs script in the panel.
      // Anything that isn't plainly http(s) collapses to an inert '#'.
      function safeHref(url) {
        const s = String(url || '').trim();
        return /^https?:\/\//i.test(s) ? s : '#';
      }

      /* ================================================================
       * TOAST
       * ================================================================ */

      function showToast(msg) {
        VOICE.toastMessage = msg;
        render();
        if (VOICE.toastTimeoutId) clearTimeout(VOICE.toastTimeoutId);
        VOICE.toastTimeoutId = setTimeout(() => {
          VOICE.toastMessage = '';
          render();
        }, 3500);
      }

      /* ================================================================
       * "Ask about highlighted text" — arm a capture mode. Once armed, any
       * text the user highlights on the current page (mouse-up) flows straight
       * into the active composer and sends, exactly like typing it + Enter.
       * A small watcher is injected into the page; it messages the panel back
       * over chrome.runtime, and handleCapturedSelection() does the send.
       * ================================================================ */
      const SELECTION_CAPTURE = { armed: false, slotIdx: 0, lastText: '', tabFollow: false };

      // Runs INSIDE the page (isolated world). Installs a one-time mouse-up
      // watcher that reports the current selection to the extension, and
      // returns whatever is selected right now so arming also catches a
      // selection the user made before clicking the button.
      function installRandySelectionWatcher() {
        // Read whatever is selected right now. window.getSelection() only sees
        // selections in the normal document — it returns "" for text selected
        // inside a focused <input> or <textarea> (e.g. a search box), so check
        // the active form field first and fall back to the page selection.
        function currentSelection() {
          let text = '';
          try {
            const el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
                typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' &&
                el.selectionEnd > el.selectionStart) {
              text = (el.value || '').substring(el.selectionStart, el.selectionEnd);
            }
          } catch (e) {}
          if (!text) {
            try { text = window.getSelection().toString(); } catch (e) {}
          }
          return (text || '').trim();
        }
        if (!window.__randySelWatcher) {
          window.__randySelWatcher = true;
          let last = '';
          const report = () => {
            // Let the browser finalize the selection before we read it.
            setTimeout(() => {
              const text = currentSelection();
              if (!text) { last = ''; return; }      // deselect → allow re-sending the same text later
              if (text === last) return;             // ignore the duplicate selectionchange/mouseup pair
              last = text;
              try { chrome.runtime.sendMessage({ type: 'randy-selection', text }); } catch (e) {}
            }, 0);
          };
          // Fire at the end of a highlight gesture (drag, double-click word,
          // triple-click). One send per finished selection, de-duped above.
          document.addEventListener('mouseup', report, true);
        }
        return currentSelection();
      }

      async function injectSelectionListener(tabId) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: installRandySelectionWatcher,
          });
          return ((results && results[0] && results[0].result) || '').trim();
        } catch (err) {
          // chrome://, the Web Store, the Extensions page, etc. are blocked for
          // every extension — nothing we can read there. Signal the caller.
          return null;
        }
      }

      // Single shared send path for captured text — used both when arming (an
      // already-highlighted selection) and for every later mouse-up message.
      function handleCapturedSelection(rawText) {
        if (!SELECTION_CAPTURE.armed) return;
        const text = (rawText || '').trim();
        if (!text || text === SELECTION_CAPTURE.lastText) return;
        const slotIdx = SELECTION_CAPTURE.slotIdx;
        const slot = STATE.slots[slotIdx];
        if (!slot) return;
        // If Randy is mid-answer, sendMessage() would no-op and the highlight
        // would be lost. Don't record it as lastText so the user can re-highlight
        // once the answer lands; just let them know.
        if (slot.loading) { showToast('Randy is still answering — highlight again in a moment.'); return; }
        SELECTION_CAPTURE.lastText = text;
        // Drop it into the active composer and fire the normal send path, so the
        // behaviour is identical to typing the text and pressing Enter.
        slot.inputText = text;
        const live = document.getElementById('home-input-' + slotIdx);
        if (live) live.value = text;
        sendMessage(slotIdx);
      }

      // Keep capturing when the user switches tabs or navigates — re-inject the
      // watcher into whatever tab is now active. The in-page guard makes
      // re-injection a no-op on tabs that already have it.
      function onCaptureTabActivated(info) {
        if (SELECTION_CAPTURE.armed && info && info.tabId != null) injectSelectionListener(info.tabId);
      }
      function onCaptureTabUpdated(tabId, changeInfo, tab) {
        if (SELECTION_CAPTURE.armed && changeInfo.status === 'complete' && tab && tab.active) {
          injectSelectionListener(tabId);
        }
      }
      function armTabFollow() {
        if (SELECTION_CAPTURE.tabFollow) return;
        SELECTION_CAPTURE.tabFollow = true;
        try {
          chrome.tabs.onActivated.addListener(onCaptureTabActivated);
          chrome.tabs.onUpdated.addListener(onCaptureTabUpdated);
        } catch (e) {}
      }

      function disarmSelectionCapture() {
        SELECTION_CAPTURE.armed = false;
        SELECTION_CAPTURE.lastText = '';
        // The tab-follow listeners stay registered but no-op while disarmed, and
        // any in-page watchers go quiet because handleCapturedSelection() gates
        // on `armed`. Nothing to tear down.
      }

      async function toggleSelectionCapture(idx) {
        const slotIdx = idx !== null && idx !== undefined ? idx : 0;
        if (SELECTION_CAPTURE.armed) {
          disarmSelectionCapture();
          showToast('Highlight capture off.');
          render();
          return;
        }
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || tab.id == null) { showToast("Can't read this page."); return; }

          // Arm before injecting so a pre-existing selection (returned by the
          // inject call) is accepted by handleCapturedSelection().
          SELECTION_CAPTURE.armed = true;
          SELECTION_CAPTURE.slotIdx = slotIdx;
          SELECTION_CAPTURE.lastText = '';

          const current = await injectSelectionListener(tab.id);
          if (current === null) {            // page we can never read
            disarmSelectionCapture();
            showToast("Can't read this page.");
            render();
            return;
          }
          armTabFollow();
          if (current) {
            handleCapturedSelection(current); // already had text highlighted → send it now
          } else {
            showToast('Highlight text on the page — it goes straight to Randy.');
          }
          render();
        } catch (err) {
          disarmSelectionCapture();
          showToast("Can't read this page.");
          render();
        }
      }

      // Auto-arm highlight capture at launch, so highlighting any text on the
      // page goes straight to Randy without first clicking the button — the
      // user can still toggle it off with the button. Silent + resilient: an
      // unreadable active tab (chrome://, Web Store, etc.) just leaves it armed,
      // and the tab-follow listeners inject the watcher the moment the user
      // lands on a readable page.
      async function autoArmSelectionCapture() {
        if (SELECTION_CAPTURE.armed) return;
        SELECTION_CAPTURE.armed = true;
        SELECTION_CAPTURE.slotIdx = 0;
        SELECTION_CAPTURE.lastText = '';
        armTabFollow();
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id != null) {
            // Install the in-page watcher only — unlike the button, don't send
            // whatever was already highlighted before launch (that would fire a
            // surprising message on open). Only fresh mouse-up highlights count.
            // An unreadable page returns null; stay armed and let tab-follow
            // inject on the next readable page. No toast at launch.
            await injectSelectionListener(tab.id);
          }
        } catch (e) {}
        render();
      }

      // Receive selections reported by the in-page watcher. Registered once.
      if (!globalThis.__randySelMsgWired) {
        globalThis.__randySelMsgWired = true;
        try {
          chrome.runtime.onMessage.addListener((msg) => {
            if (msg && msg.type === 'randy-selection') handleCapturedSelection(msg.text);
          });
        } catch (e) {}
      }

      /* ================================================================
       * TTS — streaming sentence queue + echo protection
       * ================================================================ */

      const TTS_STATE = { speakingSlot: null };

      // Rank voices by how human they sound. Modern neural voices ("Natural",
      // "Online", Google's hosted voices) beat the legacy desktop synths by a
      // mile, so quality outranks gender — a natural-sounding voice that isn't
      // deep still sounds far less robotic than a deep legacy one.
      function scoreVoice(v) {
        let s = 0;
        if (/\b(natural|neural)\b/i.test(v.name)) s += 16;
        if (/\b(premium|enhanced|plus)\b/i.test(v.name)) s += 10;
        if (/\bonline\b/i.test(v.name)) s += 6;
        if (/google/i.test(v.name)) s += 6;
        if (/\b(andrew|brian|christopher|guy|davis|roger|steffan|ryan|aaron|david|daniel|alex|tom|mark|eric|fred|george|james)\b/i.test(v.name)) s += 3;
        if (/male/i.test(v.name) && !/female/i.test(v.name)) s += 3;
        if (/female|\b(zira|susan|hazel|samantha|victoria|karen|moira|tessa|fiona|jenny|aria|michelle|sonia|libby|emma|ava|clara|ana)\b/i.test(v.name)) s -= 4;
        if (/^en[-_]us/i.test(v.lang)) s += 2;
        if (/desktop/i.test(v.name)) s -= 2;
        return s;
      }

      function pickDeepVoice() {
        if (!VOICE.ttsSupported) return null;
        const voices = window.speechSynthesis.getVoices() || [];
        if (voices.length === 0) return null;
        const enVoices = voices.filter(v => /^en(-|_|$)/i.test(v.lang));
        const pool = enVoices.length ? enVoices : voices;
        return pool.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0];
      }

      // The voice Randy actually speaks with. Honours the user's explicit
      // choice from Settings when that voice is still installed; otherwise
      // (no choice, or the chosen voice is gone) falls back to the automatic
      // pick. This is the single resolver every speak path calls, so the
      // choice and the auto-pick can never drift apart.
      function resolveVoice() {
        if (!VOICE.ttsSupported) return null;
        if (TTS.chosenName) {
          const voices = window.speechSynthesis.getVoices() || [];
          const match = voices.find(v => v.name === TTS.chosenName);
          if (match) return match;
        }
        return pickDeepVoice();
      }

      // Pronunciation lexicon — a substitution dictionary applied before text
      // reaches the speech engine. Three kinds of entries:
      //   - expansions the field actually says ("ConfigMgr" → "Config Manager",
      //     "Win32" → "win thirty-two", "v6.2" → "version 6 point 2")
      //   - letter-by-letter acronyms, spaced out so the engine spells them
      //   - phonetic respellings for names engines mangle ("Liquit" → "Lickit")
      // Order matters: specific forms before their prefixes (MSIX before MSI,
      // "TCP 443" before bare TCP). All-caps acronyms are deliberately
      // case-SENSITIVE so "IT pros" becomes "I T pros" but "it" never does.
      // "Azure" is left alone on purpose: engines already say the real word
      // correctly ("AZH-er"), and a respelling would gamble on worse.
      const TTS_LEXICON = [
        // Expansions and spoken phrasings
        [/\bConfigMgr\b/gi, 'Config Manager'],          // never read literally
        [/\b(?:W365|Windows\s*365)\b/gi, 'Windows three sixty-five'],
        [/\bWin32\b/gi, 'win thirty-two'],              // never "win three two"
        [/\bmacOS\b/gi, 'mack oh ess'],                 // never "may-coss"
        [/\bv(\d+(?:\.\d+)+)\b/g, (m, ver) => 'version ' + ver.split('.').join(' point ')],
        [/\bSOC\s*2\b/g, 'sock two'],
        [/\bISO\s*27001\b/gi, 'eye-so twenty-seven thousand one'],
        [/\bEntra\s+ID\b/gi, 'Entra eye-dee'],
        [/\bco-management\b/gi, 'co management'],       // pause at the hyphen, not "comanagement"
        [/\bring-based\b/gi, 'ring based'],
        [/\bTCP\s+443\b/g, 'T C P four forty-three'],   // IT pros say "four forty-three"
        // Letter-by-letter acronyms
        [/\bSCCM\b/g, 'S C C M'],                       // engines say "seck-em"
        [/\bMECM\b/g, 'M E C M'],
        [/\bMSIX\b/g, 'M S I X'],
        [/\bMSI\b/g, 'M S I'],
        [/\bAVD\b/g, 'A V D'],
        [/\bVDI\b/g, 'V D I'],
        [/\bRDS\b/g, 'R D S'],
        [/\bSSO\b/g, 'S S O'],
        [/\bMFA\b/g, 'M F A'],
        [/\bAPIs\b/g, "A P I's"],
        [/\bAPI\b/g, 'A P I'],
        [/\bTCP\b/g, 'T C P'],
        [/\bOS\b/g, 'O S'],
        [/\bIT\b/g, 'I T'],
        // Hybrids and words engines tend to mangle
        [/\bRBAC\b/g, 'R-back'],
        [/\bLDAP\b/g, 'L-dap'],
        [/\bCSAT\b/g, 'see-sat'],
        [/\bIntune\b/gi, 'Intoon'],                     // two syllables, never "in-tune-ee"
        [/\bLiquit\b/gi, 'Lickit'],
        [/\bOmnissa\b/gi, 'om-nissa'],
        [/\bNerdio\b/gi, 'nerd-ee-oh'],
        [/\bOkta\b/gi, 'Octa'],
        [/\bCitrix\b/gi, 'sit-ricks'],
        [/\bWinget\b/gi, 'win-get'],
        [/\bJumpCloud\b/gi, 'jump cloud'],
        [/\bChocolatey\b/gi, 'chocolate-ee'],
        [/\bKubernetes\b/gi, 'koo-ber-net-eez']
      ];

      // Rewrites text the way a person would actually say it, so the speech
      // engine doesn't trip over notation it reads literally or mispronounces.
      function prepareForSpeech(text) {
        let t = String(text || '')
          .replace(/https?:\/\/([^\s\/]+)\S*/gi, '$1'); // out loud, a URL is just its hostname
        for (const [re, sub] of TTS_LEXICON) t = t.replace(re, sub);
        return t
          .replace(/\be\.g\.,?\s*/gi, 'for example, ')
          .replace(/\bi\.e\.,?\s*/gi, 'that is, ')
          .replace(/\betc\.(\s|$)/gi, 'and so on$1')
          .replace(/\bvs\.?(\s|$)/gi, 'versus$1')
          .replace(/(\w)\s*\/\s*(\w)/g, '$1 or $2')     // "Intune/ConfigMgr"
          .replace(/\s*&\s*/g, ' and ')
          .replace(/\s+[—–]\s+/g, ', ')                 // dashes don't pause; commas do
          .replace(/\s*\(\s*/g, ', ')
          .replace(/\s*\)\s*([.,;:!?])?/g, (m, p) => (p || ',') + ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }

      // True while Randy is speaking OR within the tail window after speech
      // ends — the speaker keeps producing audio briefly after onend fires.
      const TTS_ECHO_GRACE_MS = 1200;
      // Echo text-matching only applies while Randy's audio is playing or
      // shortly after it stops (speaker → mic → ASR adds a few seconds of
      // lag). Beyond that, overlap with shared vocabulary — product names
      // come up in every question — must not swallow genuine speech.
      const TTS_ECHO_TEXT_WINDOW_MS = 8000;
      // The fuzzy word-overlap echo test only runs while Randy's audio is
      // playing or just stopped. On a technical call the NEXT question
      // naturally reuses the vocabulary of the answer Randy just gave, so a
      // long fuzzy window makes him deaf to follow-ups — exactly the
      // "doesn't hear the question" failure. Exact-substring matches keep
      // the full TTS_ECHO_TEXT_WINDOW_MS (real echo lags a few seconds).
      const TTS_ECHO_FUZZY_WINDOW_MS = 2500;
      function ttsEchoActive() {
        if (STATE.slots.some(s => s.isSpeaking)) return true;
        if (VOICE.ttsPaused) return true;
        return (Date.now() - VOICE.lastTtsEndAt) < TTS_ECHO_GRACE_MS;
      }
      function markTtsEnded() { VOICE.lastTtsEndAt = Date.now(); }

      function normalizeForEcho(text) {
        return String(text || '').toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function appendRecentTts(text) {
        const n = normalizeForEcho(text);
        if (!n) return;
        VOICE.recentTtsText = (VOICE.recentTtsText + ' ' + n).slice(-2000);
      }

      // True if `text` looks like an echo of something Randy just spoke.
      function isLikelyEcho(text) {
        const n = normalizeForEcho(text);
        if (!n || n.length < 4) return false;
        if (!VOICE.recentTtsText) return false;
        if (!ttsEchoActive() && (Date.now() - VOICE.lastTtsEndAt) > TTS_ECHO_TEXT_WINDOW_MS) return false;
        if (VOICE.recentTtsText.indexOf(n) !== -1) return true;
        // Shared-vocabulary (fuzzy) matching is only trustworthy while the
        // audio is actually playing — past that, treat it as real speech.
        if (!ttsEchoActive() && (Date.now() - VOICE.lastTtsEndAt) > TTS_ECHO_FUZZY_WINDOW_MS) return false;
        const words = n.split(' ').filter(w => w.length >= 3);
        if (words.length < 2) return false;
        const ttsWords = new Set(VOICE.recentTtsText.split(' '));
        let matches = 0;
        for (const w of words) if (ttsWords.has(w)) matches++;
        return (matches / words.length) >= 0.7;
      }

      // The recognizer now stays live during TTS — there's no conversation-mode
      // pause anymore. Randy keeps hearing the call while he reads an answer
      // aloud; mic echo cancellation plus the isLikelyEcho() text guard keep
      // his own voice from being picked up as a new question. markTtsEnded()
      // is called wherever speech stops so the echo grace window still works.

      function initTtsQueue(idx, signal, msgIdx) {
        const slot = STATE.slots[idx];
        teardownTtsQueue(idx);
        slot.ttsQueue = {
          sentences: [],
          processing: false,
          signal,
          msgIdx,
          done: false,
          currentUtter: null
        };
      }

      function teardownTtsQueue(idx) {
        const slot = STATE.slots[idx];
        const q = slot && slot.ttsQueue;
        if (!q) return;
        const wasActive = q.processing || q.sentences.length > 0 || !!q.currentUtter;
        try {
          if (q.currentUtter && VOICE.ttsSupported) {
            window.speechSynthesis.cancel();
          }
        } catch {}
        slot.ttsQueue = null;
        if (TTS_STATE.speakingSlot === idx) TTS_STATE.speakingSlot = null;
        slot.isSpeaking = false;
        VOICE.playingMsg = null;
        if (wasActive) markTtsEnded();
      }

      function enqueueTtsSentence(idx, text) {
        const slot = STATE.slots[idx];
        const q = slot && slot.ttsQueue;
        if (!q) return;
        if (q.signal && q.signal.aborted) return;
        q.sentences.push(text);
        processTtsQueue(idx);
      }

      async function processTtsQueue(idx) {
        const slot = STATE.slots[idx];
        const q = slot && slot.ttsQueue;
        if (!q || q.processing) return;
        q.processing = true;
        try {
          while (slot.ttsQueue === q && q.sentences.length > 0 && !(q.signal && q.signal.aborted)) {
            const text = q.sentences.shift();
            await playTtsChunk(idx, q, text);
          }
        } catch (err) {
          if (err && err.name !== 'AbortError') console.warn('TTS queue error:', err);
        } finally {
          q.processing = false;
          if (slot.ttsQueue === q && q.done && q.sentences.length === 0) {
            slot.isSpeaking = false;
            if (TTS_STATE.speakingSlot === idx) TTS_STATE.speakingSlot = null;
            VOICE.playingMsg = null;
            markTtsEnded();
            render();
          }
        }
      }

      function playTtsChunk(idx, q, text) {
        const raw = stripMarkdown(text);
        const clean = prepareForSpeech(raw);
        if (!clean) return Promise.resolve();
        if (!VOICE.ttsSupported) return Promise.resolve();
        return new Promise((resolve) => {
          if (q.signal && q.signal.aborted) return resolve();
          const slot = STATE.slots[idx];
          const u = new SpeechSynthesisUtterance(clean);
          const v = resolveVoice();
          if (v) u.voice = v;
          // Neural voices are tuned at their defaults; bending pitch is what
          // made the old output sound synthetic. A whisper-faster rate reads
          // as engaged rather than narrated.
          u.pitch = 1.0;
          u.rate = 1.04;
          // Echo-match against BOTH the spoken respelling (what the synth says)
          // AND the original words. The mic/desktop tap re-transcribes the real
          // words ("SCCM", "Intune"), not the lexicon respelling ("S C C M",
          // "Intoon"), so storing only `clean` let acronym-heavy answers slip
          // back in as spurious questions — feed the raw text too.
          appendRecentTts(clean);
          appendRecentTts(raw);
          slot.isSpeaking = true;
          TTS_STATE.speakingSlot = idx;
          VOICE.playingMsg = { slot: idx, msg: q.msgIdx };
          q.currentUtter = u;
          render();
          const done = () => {
            if (q.currentUtter === u) q.currentUtter = null;
            resolve();
          };
          u.onend = done;
          u.onerror = done;
          if (q.signal) q.signal.addEventListener('abort', () => {
            try { window.speechSynthesis.cancel(); } catch {}
            done();
          }, { once: true });
          try { window.speechSynthesis.speak(u); } catch { done(); }
        });
      }

      function speakText(text, idx, msgIdx) {
        if (!VOICE.ttsSupported) return;
        const raw = stripMarkdown(text);
        const clean = prepareForSpeech(raw);
        if (!clean) return;
        STATE.slots.forEach((_, i) => teardownTtsQueue(i));
        try { window.speechSynthesis.cancel(); } catch {}
        // Store both the respelling and the raw words — the mic re-hears the raw
        // words, so echo-matching needs them (see playTtsChunk).
        appendRecentTts(clean);
        appendRecentTts(raw);
        const u = new SpeechSynthesisUtterance(clean);
        const v = resolveVoice();
        if (v) u.voice = v;
        u.pitch = 1.0;
        u.rate = 1.04;
        u.onstart = () => {
          STATE.slots[idx].isSpeaking = true;
          TTS_STATE.speakingSlot = idx;
          if (typeof msgIdx === 'number') VOICE.playingMsg = { slot: idx, msg: msgIdx };
          render();
        };
        u.onend = () => {
          STATE.slots[idx].isSpeaking = false;
          if (TTS_STATE.speakingSlot === idx) TTS_STATE.speakingSlot = null;
          VOICE.playingMsg = null;
          markTtsEnded();
          render();
        };
        u.onerror = u.onend;
        try { window.speechSynthesis.speak(u); }
        catch {
          STATE.slots[idx].isSpeaking = false;
          if (TTS_STATE.speakingSlot === idx) TTS_STATE.speakingSlot = null;
          VOICE.playingMsg = null;
          markTtsEnded();
          render();
        }
      }

      function stopSpeaking() {
        STATE.slots.forEach((_, i) => teardownTtsQueue(i));
        if (VOICE.ttsSupported) {
          try { window.speechSynthesis.cancel(); } catch {}
        }
        STATE.slots.forEach(s => { s.isSpeaking = false; });
        TTS_STATE.speakingSlot = null;
        VOICE.playingMsg = null;
        markTtsEnded();
        render();
      }

      /* ================================================================
       * SPEECH RECOGNITION — one engine, default microphone only
       * (the recognizer can't accept a custom stream; computer/desktop
       *  sound reaches it acoustically via the un-processed mic capture)
       * ================================================================ */

      function recognitionWanted() { return listeningOn(); }

      function ensureRecognition() {
        if (!VOICE.srSupported) return null;
        if (VOICE.recognition) return VOICE.recognition;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r = new SR();
        r.continuous = true;
        r.interimResults = true;
        r.lang = 'en-US';
        // Note: no phrase biasing here on purpose. Chrome only supports it
        // for on-device recognition; on cloud recognition it can error the
        // recognizer into a silent restart loop ("phrases-not-supported").
        r.onresult = (e) => {
          VOICE.lastSrEventAt = Date.now();
          let interim = '';
          let finalChunk = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const t = res[0] && res[0].transcript ? res[0].transcript : '';
            if (res.isFinal) finalChunk += t + ' ';
            else interim += t;
          }
          if (finalChunk) {
            clearInterim();
            handleVoiceTranscript(finalChunk);
          } else if (interim) {
            updateInterim(interim);
          }
        };
        r.onerror = (e) => {
          VOICE.lastSrEventAt = Date.now();
          if (e.error === 'not-allowed') {
            VOICE.permissionDenied = true;
            stopListening({ silent: true });
            showToast('Randy needs microphone access — allow the mic and try again');
            return;
          }
          if (e.error === 'service-not-allowed') {
            // Usually a transient hiccup in Chrome's cloud speech service (a
            // network blip, another tab grabbing the recognizer) — NOT a real,
            // permanent block. Killing listening here is what left Randy frozen
            // after a momentary glitch. Rebuild the recognizer and keep going.
            if (VOICE.wantRunning && recognitionWanted()) {
              setTimeout(() => { try { hardResetRecognition(); } catch {} }, 400);
            }
            return;
          }
          if (e.error === 'phrases-not-supported') {
            try { r.phrases = []; } catch {}
            return; // onend restarts cleanly
          }
          if (e.error === 'audio-capture') {
            stopListening({ silent: true });
            showToast("Randy couldn't use the microphone — check that one is plugged in");
            return;
          }
          // Transient errors (no-speech, aborted, network) fall through to
          // onend, which restarts as needed.
        };
        r.onstart = () => { VOICE.srRunning = true; VOICE.srStartStrikes = 0; VOICE.lastSrEventAt = Date.now(); };
        r.onend = () => {
          VOICE.srRunning = false;
          VOICE.lastSrEventAt = Date.now();
          if (VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (!VOICE.wantRunning || !recognitionWanted()) return;
          // start() can throw InvalidStateError while the previous session is
          // still shutting down — retry with backoff.
          const tryStart = (attempt) => {
            if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
            try { startRecognitionNow(); }
            catch (err) {
              if (attempt < 4) setTimeout(() => tryStart(attempt + 1), 250 * (attempt + 1));
            }
          };
          tryStart(0);
        };
        VOICE.recognition = r;
        return r;
      }

      // Low-level start. Throws on InvalidStateError (caller handles retry).
      function startRecognitionNow() {
        const r = ensureRecognition();
        if (!r) return;
        r.start();
      }

      function startRecognition() {
        const r = ensureRecognition();
        if (!r) return;
        VOICE.wantRunning = true;
        try { startRecognitionNow(); }
        catch (e) { /* already started — ignore */ }
        startRecognitionWatchdog();
      }

      // Last-resort recovery for a hard-wedged recognizer. A SpeechRecognition
      // instance can get stuck so badly that it stops firing events, abort()
      // no longer triggers onend, and start() is a silent no-op — the soft
      // restart path can never revive it, and the listener stays frozen. The
      // only reliable escape is to throw the instance away and build a new one.
      // The dead instance's handlers are detached first so a late event from it
      // can't fight the replacement (its onend would otherwise try to spin up a
      // second recognizer).
      function hardResetRecognition() {
        const old = VOICE.recognition;
        VOICE.recognition = null;
        VOICE.srRunning = false;
        VOICE.srStartStrikes = 0;
        if (old) {
          try { old.onresult = old.onerror = old.onstart = old.onend = null; } catch {}
          try { old.abort(); } catch {}
          try { old.stop(); } catch {}
        }
        if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
        const tryStart = (attempt) => {
          if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (VOICE.srRunning) return;   // a fresh instance already came up
          try { startRecognitionNow(); }
          catch (err) {
            if (attempt < 5) setTimeout(() => tryStart(attempt + 1), 200 * (attempt + 1));
          }
        };
        tryStart(0);
      }

      // How long the recognizer may sit "running" with zero events before
      // it's presumed wedged. Chrome's cloud recognizer occasionally stops
      // delivering results without firing onend during long sessions; an
      // abort() + restart costs under a second and un-sticks it.
      const SR_STALL_MS = 15000;

      // Background-tab insurance. Chrome throttles timers in hidden tabs
      // (e.g. while the user works beside the pop-out chat), so the onend
      // retry chain can run out of attempts and strand the recognizer in a
      // dead state after a long silence. This notices "should be listening
      // but isn't" and kicks it. The mic stream held by startListening()
      // keeps the tab exempt from intensive throttling, so the interval
      // still fires while hidden. It also catches a recognizer that is
      // nominally running but silently wedged (no events for SR_STALL_MS).
      function startRecognitionWatchdog() {
        if (VOICE.watchdogId) return;
        VOICE.watchdogId = setInterval(() => {
          if (!VOICE.wantRunning || !recognitionWanted() || VOICE.ttsPaused || VOICE.dictationPaused) return;
          if (!VOICE.srRunning) {
            // Should be running but isn't. Try the cheap restart, but if the
            // instance keeps refusing to come up (onstart never fires) across a
            // few ticks, it's wedged shut — rebuild it from scratch.
            VOICE.srStartStrikes = (VOICE.srStartStrikes || 0) + 1;
            if (VOICE.srStartStrikes >= 3) { hardResetRecognition(); return; }
            try { startRecognitionNow(); } catch {}
            return;
          }
          VOICE.srStartStrikes = 0;
          if (Date.now() - VOICE.lastSrEventAt > SR_STALL_MS) {
            // Running but silent for too long. First try the cheap path —
            // abort() should fire onend, which restarts cleanly. But a hard
            // wedge ignores abort() and never fires onend, so if the SAME
            // instance is still "running" and still silent shortly after,
            // rebuild it outright instead of aborting a corpse forever.
            const wedged = VOICE.recognition;
            try { wedged && wedged.abort(); } catch {}
            setTimeout(() => {
              if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused &&
                  VOICE.recognition === wedged && VOICE.srRunning &&
                  Date.now() - VOICE.lastSrEventAt > SR_STALL_MS) {
                hardResetRecognition();
              }
            }, 1500);
          }
        }, 5000);
      }

      function stopRecognitionWatchdog() {
        if (VOICE.watchdogId) { clearInterval(VOICE.watchdogId); VOICE.watchdogId = null; }
      }

      // Coming back to the foreground is a free chance to revive a
      // recognizer that died while the tab was throttled in the background.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused && !VOICE.srRunning) {
          try { startRecognitionNow(); } catch {}
        }
        // Also a free chance to un-stick a pipeline that wedged while the tab
        // was throttled in the background, so a heard question isn't left
        // frozen on "Analyzing"/"Researching" after the user returns.
        if (listeningOn()) { try { assistWatchdogTick(); } catch {} }
      });

      // Force a clean recognizer restart. abort() triggers onend, which
      // restarts a fresh recognition session.
      function restartRecognition() {
        VOICE.wantRunning = true;
        const r = ensureRecognition();
        if (!r) return;
        try { r.abort(); } catch {}
        // If onend doesn't fire (recognizer was idle), kick it directly.
        setTimeout(() => {
          if (VOICE.wantRunning && recognitionWanted() && !VOICE.ttsPaused && !VOICE.dictationPaused) {
            try { startRecognitionNow(); } catch {}
          }
        }, 150);
      }

      function stopRecognition() {
        VOICE.wantRunning = false;
        stopRecognitionWatchdog();
        if (VOICE.recognition) {
          try { VOICE.recognition.stop(); } catch {}
        }
        VOICE.ttsPaused = false;
        VOICE.interimText = '';
        VOICE.interimSlot = null;
        VOICE.recentTtsText = '';
        STATE.slots.forEach(s => { s.isListening = false; });
      }

      /* ================================================================
       * DICTATION — push-to-talk voice typing in the pop-out composer
       *
       * A SECOND, independent recognizer. The Web Speech API only runs one
       * recognizer at a time, so while dictation captures the mic Randy's
       * passive listener is paused (VOICE.dictationPaused) and resumed the
       * moment dictation stops. Dictation never auto-sends — it streams the
       * transcript into #pip-input — and it never cuts the user off: Chrome
       * silently ends a recognition session after a pause, so onend restarts
       * it for as long as the user keeps dictating.
       * ================================================================ */

      // Is dictation currently typing into this home composer slot?
      function isHomeDictating(slotIdx) {
        const t = VOICE.dictationTarget;
        return !!(VOICE.dictating && t && t.kind === 'home' && t.slot === slotIdx);
      }

      // Resolve the live input element dictation is currently writing into —
      // either the pop-out composer or a home composer slot. Never throws.
      function dictationInputEl() {
        const t = VOICE.dictationTarget;
        if (!t) return null;
        if (t.kind === 'home') {
          return document.getElementById('home-input-' + t.slot);
        }
        // Default / 'pip': the pop-out window's input (a separate document).
        const w = PIP.window;
        if (!w || w.closed) return null;
        try { return w.document.getElementById('pip-input'); } catch { return null; }
      }

      // Write the staged dictation text (+ optional live interim) into the
      // active input. Never throws — the pop-out window can vanish mid-write.
      function syncDictationInput(interim) {
        const input = dictationInputEl();
        if (!input) return;
        const base = VOICE.dictationBase || '';
        const it = (interim || '').trim();
        const val = it ? (base ? base.replace(/\s+$/, '') + ' ' + it : it) : base;
        try {
          input.value = val;
          input.selectionStart = input.selectionEnd = val.length;
          input.scrollLeft = input.scrollWidth;
        } catch {}
        // A home composer write fires no 'input' event, so keep STATE and the
        // send button's disabled state in sync by hand (the pop-out has its own).
        const t = VOICE.dictationTarget;
        if (t && t.kind === 'home' && STATE.slots[t.slot]) {
          STATE.slots[t.slot].inputText = val;
          const sendBtn = document.querySelector('[data-action="send-home"][data-idx="' + t.slot + '"]');
          if (sendBtn) {
            const dis = !!STATE.slots[t.slot].loading || !val.trim();
            if (sendBtn.disabled !== dis) sendBtn.disabled = dis;
          }
        }
      }

      // Fold a finalized chunk into the staged dictation text with sane spacing.
      function appendDictationFinal(chunk) {
        const add = (chunk || '').trim();
        if (!add) return;
        const base = VOICE.dictationBase || '';
        VOICE.dictationBase = base ? base.replace(/\s+$/, '') + ' ' + add : add;
      }

      function ensureDictationRecognition() {
        if (!VOICE.srSupported) return null;
        if (VOICE.dictation) return VOICE.dictation;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r = new SR();
        r.continuous = true;
        r.interimResults = true;
        r.lang = 'en-US';
        r.onresult = (e) => {
          let interim = '';
          let finalChunk = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const t = res[0] && res[0].transcript ? res[0].transcript : '';
            if (res.isFinal) finalChunk += t + ' ';
            else interim += t;
          }
          if (finalChunk) appendDictationFinal(finalChunk);
          syncDictationInput(interim);
        };
        r.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            showToast('Randy needs microphone access — allow the mic and try again');
            stopDictation();
            return;
          }
          if (e.error === 'audio-capture') {
            showToast("Randy couldn't use the microphone — check that one is plugged in");
            stopDictation();
            return;
          }
          // Transient errors (no-speech, aborted, network) fall through to
          // onend, which restarts while the user is still dictating.
        };
        r.onend = () => {
          if (VOICE.dictating) {
            // Chrome ended the session after a pause but the user hasn't
            // stopped — restart so a long answer is never cut off. start()
            // can throw while the old session tears down; retry with backoff.
            const tryStart = (attempt) => {
              if (!VOICE.dictating) return;
              try { r.start(); }
              catch (err) {
                if (attempt < 4) setTimeout(() => tryStart(attempt + 1), 250 * (attempt + 1));
              }
            };
            tryStart(0);
            return;
          }
          // Dictation finished — settle the input to the finalized text
          // (drop any dangling interim) and bring Randy's listener back.
          syncDictationInput('');
          resumePassiveAfterDictation();
        };
        VOICE.dictation = r;
        return r;
      }

      // Bring Randy's passive listener back after dictation, if it was on.
      function resumePassiveAfterDictation() {
        if (!VOICE.dictationPaused) return;
        VOICE.dictationPaused = false;
        if (!VOICE.wantRunning || !recognitionWanted()) return;
        const tryStart = (attempt) => {
          if (!VOICE.wantRunning || !recognitionWanted() || VOICE.dictationPaused) return;
          try { startRecognitionNow(); }
          catch (err) {
            if (attempt < 4) setTimeout(() => tryStart(attempt + 1), 250 * (attempt + 1));
          }
        };
        tryStart(0);
      }

      function toggleDictation(target) {
        if (!VOICE.srSupported) { showToast('Voice typing needs Chrome or Edge'); return; }
        if (VOICE.dictating) stopDictation();
        else startDictation(target);
      }

      function startDictation(target) {
        if (!VOICE.srSupported || VOICE.dictating) return;
        const r = ensureDictationRecognition();
        if (!r) return;
        VOICE.dictating = true;
        // Default to the pop-out composer for back-compat with its mic button.
        VOICE.dictationTarget = target || { kind: 'pip' };

        // Seed the staged text from whatever the user already typed, so
        // dictation appends rather than overwrites.
        let existing = '';
        try { existing = (dictationInputEl() || {}).value || ''; } catch {}
        VOICE.dictationBase = existing.trim();

        // Pause Randy's passive listener so the two recognizers don't fight
        // over the mic. Keep VOICE.wantRunning intact so resume knows to
        // restart it. abort() releases the mic fastest; its onend bails out
        // immediately because dictationPaused is set.
        if (VOICE.wantRunning && recognitionWanted()) {
          VOICE.dictationPaused = true;
          try { VOICE.recognition && VOICE.recognition.abort(); } catch {}
        }

        // Start the dictation recognizer. The passive recognizer may still be
        // releasing the mic, so retry with backoff on InvalidStateError.
        const tryStart = (attempt) => {
          if (!VOICE.dictating) return;
          try { r.start(); }
          catch (err) {
            if (attempt < 6) setTimeout(() => tryStart(attempt + 1), 200 * (attempt + 1));
            // Dictation never managed to start. Don't leave the passive
            // listener stuck paused (dictationPaused === true would freeze it
            // forever) — give up on dictation and bring Randy back.
            else { VOICE.dictating = false; resumePassiveAfterDictation(); render(); }
          }
        };
        tryStart(0);

        // Reflect the live mic in the UI first (render() rebuilds the home
        // composer), then put focus back on the freshly-built input.
        render();
        try { const el = dictationInputEl(); if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); } } catch {}
      }

      function stopDictation() {
        if (!VOICE.dictating) {
          // Already stopped, but make sure the listener isn't stuck paused.
          resumePassiveAfterDictation();
          return;
        }
        VOICE.dictating = false;       // onend won't restart now
        if (VOICE.dictation) {
          try { VOICE.dictation.stop(); } catch {}
        } else {
          // No recognizer to fire onend — resume the listener directly.
          syncDictationInput('');
          resumePassiveAfterDictation();
        }
        render();
      }

      /* ================================================================
       * PASSIVE LISTENING TEARDOWN
       * ================================================================ */

      // Abort any in-flight reply and stop any audio. Called by stopListening()
      // and newChat() to cleanly cancel whatever Randy is doing right now.
      function abortActiveReply() {
        STATE.slots.forEach((s, i) => {
          if (s.abortController) { try { s.abortController.abort(); } catch {} s.abortController = null; }
          teardownTtsQueue(i);
          s.loading = false;
          s.isListening = false;
        });
        stopSpeaking();
        clearInterim();
      }

      // One passive path. Once listening is on, every finalized utterance goes
      // straight to the technical-question pipeline — no wake word, no
      // conversation mode, no turn-taking. The only filter is dropping
      // re-transcriptions of Randy's own read-aloud voice. This keeps working
      // even while Randy is talking, because the call on the computer keeps
      // going (mic echo cancellation + isLikelyEcho() guard his own voice out).
      function handleVoiceTranscript(raw) {
        const text = String(raw).trim();
        if (!text) return;
        // Drop re-transcriptions of Randy's own voice.
        if (isLikelyEcho(text)) return;
        // Two transcribers can hear the same words — the mic (Web Speech) and
        // the digital computer-audio tap (Whisper). On speakers especially,
        // the mic also overhears the call, so the same utterance can arrive
        // from both. Collapse those so a question isn't answered twice.
        if (isDuplicateUtterance(text)) return;
        if (listeningOn()) assistIngest(text);
      }

      // Cross-source de-dupe for finalized utterances. Holds a short rolling
      // window of recent finals (from either transcriber) and rejects a new
      // one that repeats it — exact match, containment, or high token overlap
      // (ASR wording varies slightly between the two engines).
      const RECENT_FINALS = [];
      function isDuplicateUtterance(text) {
        const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!norm) return false;
        const now = Date.now();
        while (RECENT_FINALS.length && now - RECENT_FINALS[0].at > 8000) RECENT_FINALS.shift();
        const tokens = new Set(norm.split(' '));
        for (const e of RECENT_FINALS) {
          if (e.norm === norm) { e.at = now; return true; }
          const shorter = e.norm.length <= norm.length ? e.norm : norm;
          const longer  = e.norm.length <= norm.length ? norm : e.norm;
          if (shorter.length >= 12 && longer.indexOf(shorter) !== -1) { e.at = now; return true; }
          let inter = 0; e.tokens.forEach(w => { if (tokens.has(w)) inter++; });
          const uni = new Set([...e.tokens, ...tokens]).size;
          if (uni > 0 && inter / uni >= 0.8 && Math.min(e.tokens.size, tokens.size) >= 3) { e.at = now; return true; }
        }
        RECENT_FINALS.push({ norm, tokens, at: now });
        return false;
      }

      /* ================================================================
       * INTERIM TRANSCRIPT (live "Hearing live" panel on the voice stage)
       * ================================================================ */

      function interimTargetSlot() {
        return listeningOn() ? 0 : null;
      }

      // Patch the stage panel's transcript text in place when it's mounted;
      // fall back to a render only when it isn't (e.g. listening just turned
      // on). Returns true when the cheap path worked.
      function patchLiveTranscript(text) {
        const wrap = document.getElementById('live-transcript');
        const span = document.getElementById('live-transcript-text');
        if (!wrap || !span) return false;
        span.textContent = text;
        wrap.classList.toggle('hearing', !!text);
        // Teleprompter: as the transcript grows, keep the latest words in view
        // by pinning the scroll position to the bottom of the column.
        wrap.scrollTop = wrap.scrollHeight;
        return true;
      }

      function updateInterim(text) {
        const trimmed = String(text || '').trim();
        if (trimmed.length < 2) { clearInterim(); return; }
        // Don't flash Randy's own voice back onscreen.
        if (isLikelyEcho(trimmed)) { clearInterim(); return; }
        const target = interimTargetSlot();
        if (target === null) { clearInterim(); return; }

        // Show the corrected wording in the live band so product names read
        // right as they stream ("Intune", not "in tune"). Echo/dedupe above and
        // the answer pipeline still run on the raw transcript — this is a
        // display-only polish on the partial.
        const display = correctTranscript(trimmed) || trimmed;

        const prevText = VOICE.interimText;
        const prevSlot = VOICE.interimSlot;
        VOICE.interimText = display;
        VOICE.interimSlot = target;
        VOICE.interimAt = Date.now();

        // Stream into the pop-out's live band too — patchLiveTranscript()
        // below can short-circuit the main render, which would otherwise
        // leave the pop-out transcript stale.
        if (PIP.window) updatePipLive(STATE.slots[PIP.slotIdx]);

        if (patchLiveTranscript(display)) return;
        // One render to mount the node — but never while the user is typing,
        // since render() rebuilds the DOM and would steal composer focus.
        if (prevText !== display || prevSlot !== target) {
          if (!isComposerFocused()) render();
        }
      }

      function isComposerFocused() {
        const el = document.activeElement;
        if (!el || !el.id) return false;
        return el.id === 'expanded-input' || el.id === 'history-search' || el.id.startsWith('home-input-');
      }

      function clearInterim() {
        if (!VOICE.interimText && VOICE.interimSlot === null) return;
        VOICE.interimText = '';
        VOICE.interimSlot = null;
        if (PIP.window) updatePipLive(STATE.slots[PIP.slotIdx]);
        if (patchLiveTranscript('')) return;
        if (!isComposerFocused()) render();
      }



      /* ================================================================
       * LISTENING — one switch: mic + optional digital computer-audio tap
       * ================================================================ */

      // The big mic button. OFF→ON: open the "How should Randy listen?"
      // chooser; the chosen mode then drives startListening — one-way
      // (microphone only) or two-way (microphone + the computer's audio via
      // the share picker, exactly as before). ON→OFF: stop.
      async function toggleListening() {
        const slot = STATE.slots[0];
        if (!VOICE.srSupported) { showToast('Randy needs Chrome or Edge to listen'); return; }
        if (slot.listenOn) { stopListening(); return; }
        // No chooser — start with the saved capture mode. One-way (mic only)
        // can auto-start; two-way's screen-share picker rides this click's user
        // activation. The mode is chosen in Settings.
        startListening(slot.audioMode === 'two-way' ? 'two-way' : 'one-way');
      }

      // render() rebuilds #app wholesale, so focus has to be reapplied once the
      // new DOM exists (mirrors the composer-focus pattern elsewhere).
      function focusAfterRender(sel) {
        setTimeout(() => { try { document.querySelector(sel)?.focus(); } catch {} }, 40);
      }

      // One polite live region kept OUTSIDE #app (so render() never wipes it)
      // lets screen readers hear the selected mode and its description as the
      // slider moves — the full-rebuild render can't announce in place.
      function announceLive(msg) {
        let el = document.getElementById('randy-live');
        if (!el) {
          el = document.createElement('div');
          el.id = 'randy-live';
          el.className = 'sr-only';
          el.setAttribute('aria-live', 'polite');
          el.setAttribute('aria-atomic', 'true');
          document.body.appendChild(el);
        }
        // Clear first so re-selecting the same value still re-announces.
        el.textContent = '';
        setTimeout(() => { el.textContent = msg; }, 30);
      }

      // Open the "How should Randy listen?" slider. Pre-selects the last mode
      // and moves focus into the dialog for keyboard / screen-reader users.
      function openAudioChooser() {
        const slot = STATE.slots[0];
        if (!VOICE.srSupported) { showToast('Randy needs Chrome or Edge to listen'); return; }
        if (slot.listenOn) return;
        if (slot.audioMode !== 'one-way' && slot.audioMode !== 'two-way') slot.audioMode = 'two-way';
        STATE.audioChooserOpen = true;
        render();
        focusAfterRender('.ac-modal');
      }

      // Close the chooser without starting (X / backdrop / Escape) and return
      // focus to the voice control that opened it.
      function closeAudioChooser() {
        if (!STATE.audioChooserOpen) return;
        STATE.audioChooserOpen = false;
        render();
        focusAfterRender('.vp');
      }

      async function startListening(mode, { auto = false } = {}) {
        const slot = STATE.slots[0];
        if (slot.listenOn) return 'ok';
        const r = ensureRecognition();
        if (!r) { if (!auto) showToast('Randy needs Chrome or Edge to listen'); return 'unsupported'; }

        // Resolve the capture mode chosen in the "How should Randy listen?"
        // slider, falling back to the remembered preference, then two-way.
        const audioMode = (mode === 'one-way' || mode === 'two-way') ? mode
          : (slot.audioMode === 'one-way' ? 'one-way' : 'two-way');
        // Persist the mode only for an explicit user choice. The auto-start path
        // ALWAYS runs one-way (its screen-share picker can't open without a
        // click), so it must not overwrite a saved two-way preference — on disk
        // or in memory — or every panel open would silently downgrade a two-way
        // user to one-way and their next manual toggle would start one-way too.
        if (!auto) {
          slot.audioMode = audioMode;
          saveSettings();
        }
        const twoWay = audioMode === 'two-way';

        // TWO-WAY ONLY: offer the digital computer-audio tap FIRST, while the
        // click's transient activation is still fresh — getDisplayMedia
        // requires it, and the mic getUserMedia await below would otherwise
        // consume it. This resolves whether or not the user actually shares
        // audio; if they dismiss the picker we continue mic-only.
        // One-way mode never taps the computer's audio at all.
        if (twoWay && DESKTOP.supported) {
          try { await startDesktopCapture(); } catch {}
        }

        // Ask for the mic up front so a denial fails loudly here, with a
        // clear message, instead of dying quietly inside the recognizer.
        // The stream is HELD for the whole listening session, not stopped:
        // an active capture exempts the tab from Chrome's intensive timer
        // throttling, which is what keeps the restart watchdog alive while
        // the user works beside the docked pop-out with this tab hidden.
        //
        // Mic capture. This held stream is the keep-alive capture (it exempts
        // the tab from background timer throttling so the watchdog keeps
        // firing) AND the mic-permission gate. The Web Speech recognizer opens
        // its OWN capture on the system default device, so these constraints
        // shape the held stream — and, on machines where both share the default
        // device, influence what the recognizer overhears acoustically.
        //
        //   TWO-WAY — audio processing is turned OFF on purpose. Randy must
        //     transcribe BOTH the user's voice and the call playing on the
        //     speakers, and the only source the recognizer can use is the
        //     system default microphone, so the computer's sound reaches it
        //     acoustically: the mic physically hears the speakers.
        //       echoCancellation subtracts your own speaker output from the
        //         mic — but that output IS the call audio we want — so it's
        //         OFF. Its aggressiveness varies by machine/OS/driver, which is
        //         why acoustic capture worked on one computer (weak AEC) but
        //         not another (strong AEC stripped the computer sound).
        //       noiseSuppression treats the steady call audio as background and
        //         attenuates it — OFF.
        //       autoGainControl rides toward the loudest source (the local
        //         speaker), ducking everything else — OFF.
        //     All three off so desktop/call sound survives to the recognizer
        //     the same way on every machine. (TTS self-echo is handled in
        //     software via VOICE.recentTtsText matching.)
        //
        //   ONE-WAY — the exact opposite. The user asked Randy to pick up ONLY
        //     their own voice and NOT what anyone else is saying, so the
        //     standard processing is turned ON: echo cancellation removes the
        //     call audio leaking from the speakers, while noise suppression and
        //     auto-gain keep the focus on the person at the mic. Combined with
        //     never starting the computer-audio tap above, this keeps the
        //     "only what you're saying" promise honest.
        // The device is MIC.deviceId when the user pinned one in Settings,
        // otherwise the system default ('default' as a soft `ideal` so it never
        // OverconstrainedErrors on browsers without a virtual "default" device).
        // acquireMicStream handles a pinned-but-unplugged device by falling back
        // to the default, so a stale choice can never strand listening.
        const micStatus = await acquireMicStream(twoWay);
        if (micStatus !== 'ok') {
          if (micStatus === 'denied') {
            // A genuine denial — stop auto-retrying and tell the user how to
            // fix it. A later open starts a fresh context and tries again.
            VOICE.permissionDenied = true;
            showToast('Randy needs the microphone. Click Allow and try again.');
          } else if (micStatus === 'no-device') {
            if (!auto) showToast("Randy couldn't find a microphone — check that one is connected.");
          } else {
            // Transient: the device is momentarily busy or the capture stack is
            // still warming up in the instant the panel opens. Stay quiet on the
            // auto path so the retry loop can recover without toast spam; the
            // manual path keeps its original feedback.
            if (!auto) showToast('Randy needs the microphone. Click Allow and try again.');
          }
          // Two-way opened the computer-audio share BEFORE this mic prompt (the
          // share picker needs the click's fresh activation). A mic failure here
          // leaves slot.listenOn false, so no listening session exists and
          // nothing will ever call stopListening() — that would strand the live
          // screen/tab share, its AudioContext, and the Whisper worker running
          // invisibly until the panel closes. Tear the tap down now.
          if (twoWay) stopDesktopCapture();
          render();
          return micStatus;
        }

        slot.listenOn = true;
        TECH.heard = 0;
        TECH.answered = 0;
        TECH.decisions = [];
        startRecognition();
        startAssistWatchdog();
        startProxyWarmup();   // keep the proxy hot so the first answer skips the cold start
        // Warn right away if the answer service is unreachable, so "hears
        // but never answers" can't happen silently.
        loadRemoteConfig().then(() => {
          if (!PROXY.ready) showToast('⚠ Randy cannot reach his answer service — open Settings');
          else if (!PROXY.hasKey) showToast('⚠ The answer service has no API key — open Settings');
        });
        showToast(twoWay ? 'Randy is listening — your mic and computer audio' : 'Randy is listening to your microphone');
        render();
        return 'ok';
      }

      // Reliable auto-start. The side panel reloads into a fresh context on
      // every open, and the mic capture can transiently fail in the instant the
      // panel appears (device momentarily busy, capture stack still warming up).
      // A single attempt that quit on that error would leave Randy silent until
      // the user taps the orb — so keep retrying with backoff until listening
      // actually sticks, stopping only on success, a real mic denial, an
      // unsupported browser, or no microphone present.
      function autoStartListening(attempt = 0) {
        if (STATE.slots[0].listenOn) return;                       // already listening
        if (!VOICE.srSupported || VOICE.permissionDenied) return;  // can't / user said no
        const retry = () => {
          if (STATE.slots[0].listenOn || VOICE.permissionDenied) return;
          if (attempt < 12) setTimeout(() => autoStartListening(attempt + 1), Math.min(2000, 300 + attempt * 250));
        };
        Promise.resolve()
          .then(() => startListening('one-way', { auto: true }))
          .then((status) => {
            if (STATE.slots[0].listenOn) return;                   // it stuck — done
            // Terminal outcomes don't get retried; everything else (transient
            // capture failures) does.
            if (status === 'denied' || status === 'unsupported' || status === 'no-device') return;
            retry();
          })
          .catch(retry);
      }

      function stopListening({ silent = false } = {}) {
        const slot = STATE.slots[0];
        const wasOn = slot.listenOn;
        slot.listenOn = false;
        if (VOICE.micStream) {
          try { VOICE.micStream.getTracks().forEach(t => t.stop()); } catch {}
          VOICE.micStream = null;
        }
        clearAssistBuffer();
        stopAssistWatchdog();
        stopProxyWarmup();
        // Cancel any in-flight classifier round-trip and bump the epoch so a
        // late resolution after teardown is ignored.
        TECH.classifyGen++;
        if (TECH.classifyController) { try { TECH.classifyController.abort(); } catch {} TECH.classifyController = null; }
        TECH.pending = false;
        TECH.pendingSince = 0;
        TECH.answerSince = 0;
        abortActiveReply();   // aborts in-flight replies and any TTS
        stopRecognition();
        stopDesktopCapture();
        if (!silent && wasOn) showToast('Randy stopped listening');
        render();
      }

      // Opening Settings while Randy is listening used to glitch the sheet: the
      // live-transcript pipeline calls render() constantly, and render()
      // rebuilds the Settings sheet (it lives inside #app), so inputs lost
      // focus and the page jumped. Pause listening on the way in and remember
      // the mode so we can resume it on the way out. No-op when Randy is
      // already off — which is exactly why the glitch never happened from the
      // "Randy is off" state. Silent so the user doesn't get a "stopped
      // listening" toast just for opening Settings.
      function pauseListenForSettings() {
        const slot = STATE.slots[0];
        if (!slot.listenOn) { STATE.settingsResumeListen = false; return; }
        STATE.settingsResumeListen = slot.audioMode === 'two-way' ? 'two-way' : 'one-way';
        stopListening({ silent: true });
      }

      // Leaving Settings — resume the listening paused on the way in, in the
      // same mode. Runs inside the closing click so two-way's screen-share
      // picker still has the user activation it needs. No-op if we weren't
      // listening when Settings opened.
      function resumeListenAfterSettings() {
        const mode = STATE.settingsResumeListen;
        STATE.settingsResumeListen = false;
        if (mode) startListening(mode);
      }

      /* ================================================================
       * DESKTOP / COMPUTER AUDIO — digital tap + in-browser Whisper
       *
       * getDisplayMedia (the tab/screen-share picker, "share audio" ticked)
       * gives us the call's real audio, even on headphones. We can't hand
       * that stream to the Web Speech recognizer, so we transcribe it locally
       * with a Whisper model running in a Web Worker (WebGPU, WASM fallback).
       * Nothing is uploaded; the audio never leaves the browser. Finalized
       * utterances go to handleVoiceTranscript() — the same pipeline the mic
       * feeds — so answers happen the same way regardless of source.
       * ================================================================ */

      // PCM tap that runs OFF the main thread. The old ScriptProcessorNode
      // fired its callback on the main thread, so every audio block competed
      // with rendering and made the page lag while computer-audio capture was
      // running. This AudioWorklet does the same job on the audio thread and
      // batches samples into 4096-frame blocks so the main-thread VAD math in
      // processDesktopBlock() stays identical. Loaded from a Blob URL to keep
      // the app single-file. NOTE: keep this free of ${...} — it's a template.
      const PCM_WORKLET_SRC = `
        class RandyPCM extends AudioWorkletProcessor {
          constructor() { super(); this._buf = new Float32Array(4096); this._n = 0; }
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch) {
              for (let i = 0; i < ch.length; i++) {
                this._buf[this._n++] = ch[i];
                if (this._n === this._buf.length) {
                  this.port.postMessage(this._buf.slice(0));
                  this._n = 0;
                }
              }
            }
            return true;
          }
        }
        registerProcessor('randy-pcm', RandyPCM);
      `;

      // The transcription worker now lives in its own bundled file,
      // whisper-worker.js, which imports the vendored Transformers.js + ONNX
      // Runtime locally (no CDN) so it runs under the MV3 CSP. See
      // startWhisperWorker() below and the header comment in that file. Only the
      // model weights download at runtime; audio never leaves the machine.

      // Reflect capture state in the live strip without a full re-render.
      function setDesktopStatus(text) {
        DESKTOP.statusText = text || '';
        const el = document.getElementById('desktop-status');
        if (el) { el.textContent = DESKTOP.statusText; el.classList.toggle('on', !!DESKTOP.statusText); }
      }

      async function startDesktopCapture() {
        if (DESKTOP.on || !DESKTOP.supported) return;
        let stream;
        try {
          // We only ever want the AUDIO from this share — the video track is
          // stopped immediately below. Requesting a full-res/full-framerate
          // screen capture just to discard it is what makes the UI freeze the
          // moment you pick a surface in the picker, so constrain the video to
          // a tiny 1 fps stream: the capture pipeline becomes nearly free while
          // the picker still offers the same "share tab/system audio" choices.
          // The picker hints keep surface-switching available and stop the
          // captured audio from being echoed back out of the local speakers.
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 1, max: 1 }, width: { max: 640 }, height: { max: 360 } },
            audio: true,
            selfBrowserSurface: 'include',
            surfaceSwitching: 'include',
            systemAudio: 'include',
            suppressLocalAudioPlayback: false
          });
        } catch (err) {
          // Picker dismissed or permission denied — continue mic-only.
          return;
        }
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          // Shared a window/screen but didn't tick "share audio". The video is
          // useless to us, so drop the whole share and stay on the mic.
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          showToast('No computer audio shared — re-share and ' + osShareAudioHint() + '. Using mic only.');
          return;
        }
        // Audio only — stop the video track so we aren't grabbing the screen.
        stream.getVideoTracks().forEach(t => { try { t.stop(); } catch {} });

        DESKTOP.stream = stream;
        DESKTOP.on = true;
        // If the user clicks Chrome's "Stop sharing", tear this path down.
        audioTracks[0].addEventListener('ended', () => { stopDesktopCapture(); render(); });

        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          DESKTOP.audioCtx = new Ctx({ sampleRate: ASR.SAMPLE_RATE });
          if (DESKTOP.audioCtx.state === 'suspended') { try { await DESKTOP.audioCtx.resume(); } catch {} }
          DESKTOP.sourceNode = DESKTOP.audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));

          // A silent gain → destination "pulls" the graph so the tap keeps
          // running without echoing the captured audio back to the speakers.
          const sink = DESKTOP.audioCtx.createGain();
          sink.gain.value = 0;
          sink.connect(DESKTOP.audioCtx.destination);

          // Prefer the AudioWorklet (off the main thread → no UI lag). Fall
          // back to the deprecated ScriptProcessor only where it's missing.
          let usingWorklet = false;
          if (DESKTOP.audioCtx.audioWorklet) {
            try {
              if (!DESKTOP.workletUrl) {
                DESKTOP.workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: 'text/javascript' }));
              }
              await DESKTOP.audioCtx.audioWorklet.addModule(DESKTOP.workletUrl);
              const node = new AudioWorkletNode(DESKTOP.audioCtx, 'randy-pcm');
              node.port.onmessage = (e) => processDesktopBlock(e.data);
              DESKTOP.sourceNode.connect(node);
              node.connect(sink);
              DESKTOP.procNode = node;
              usingWorklet = true;
            } catch (e) {
              console.warn('AudioWorklet unavailable — using ScriptProcessor fallback:', (e && e.message) || e);
            }
          }
          if (!usingWorklet) {
            const proc = DESKTOP.audioCtx.createScriptProcessor(4096, 1, 1);
            proc.onaudioprocess = (e) => { processDesktopBlock(e.inputBuffer.getChannelData(0)); };
            DESKTOP.sourceNode.connect(proc);
            proc.connect(sink);
            DESKTOP.procNode = proc;
          }
        } catch (err) {
          showToast('Randy could not set up computer-audio capture — using mic only.');
          stopDesktopCapture();
          return;
        }

        startWhisperWorker();
        setDesktopStatus('Computer audio: loading transcriber…');
        showToast('Randy is capturing computer audio');
      }

      function startWhisperWorker() {
        if (DESKTOP.worker) return;
        try {
          // The transcriber is a REAL bundled file (whisper-worker.js) that
          // imports the vendored Transformers.js + ONNX Runtime locally — no
          // CDN, so the MV3 CSP (script-src 'self') permits it. Resolve its URL
          // through chrome.runtime so it's the extension origin; fall back to a
          // relative path only when that API is somehow absent.
          const workerUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('whisper-worker.js')
            : 'whisper-worker.js';
          DESKTOP.worker = new Worker(workerUrl, { type: 'module' });
          DESKTOP.modelLoading = true;
          DESKTOP.worker.onmessage = onWhisperMessage;
          DESKTOP.worker.onerror = (e) => {
            // Graceful, silent fallback: the mic path still works, so don't
            // show an alarming banner/toast. Tear down the now-useless capture
            // graph (share + AudioContext + worker) instead of just clearing
            // the status — otherwise a headless computer-audio tap keeps running
            // idle for the rest of the session.
            console.warn('desktop transcriber failed to load — using mic only:', (e && e.message) || '');
            stopDesktopCapture();
          };
          DESKTOP.worker.postMessage({ type: 'init' });
        } catch (err) {
          // Browser can't spin up the module worker — Randy stays on the mic.
          // Silent fallback, no confusing notification.
          console.warn('in-page transcriber unavailable — using mic only:', (err && err.message) || err);
          setDesktopStatus('');
        }
      }

      // Whisper invents canned phrases when it's fed near-silence, music, or
      // room tone — "Thank you.", "you", "Thanks for watching" — and Web Speech
      // never produces these, so they're a reliable tell for a non-speech
      // segment. It also occasionally loops a word or short clause. Both corrupt
      // the question pipeline (a hallucinated "Thank you." can debounce-flush as
      // a real utterance), so scrub them before a transcript is treated as
      // speech. Only ever drops an output that is ENTIRELY a known hallucination
      // — real questions containing these words pass through untouched.
      const ASR_HALLUCINATIONS = new Set([
        'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
        'thank you for watching', 'thanks for listening', 'please subscribe',
        'like and subscribe', 'subscribe', 'bye', 'goodbye', 'okay', 'ok', 'so',
        'the end', 'music', 'applause', 'silence', 'foreign', 'yeah', 'mm', 'mhm',
        'uh', 'um', 'huh', 'hmm'
      ]);

      function sanitizeAsrText(text) {
        let t = String(text || '').trim();
        if (!t) return '';
        // Collapse an immediately repeated word: "the the the call" → "the call".
        t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
        // Collapse a short clause looped 3+ times ("no clean way no clean way
        // no clean way" → one copy) — Whisper's other repetition shape.
        t = t.replace(/\b(\w+(?:\s+\w+){0,3})(?:\s+\1\b){2,}/gi, '$1');
        t = t.replace(/\s+/g, ' ').trim();
        // Drop if what's left is nothing but a known silence hallucination.
        const norm = t.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
        if (!norm || ASR_HALLUCINATIONS.has(norm)) return '';
        return t;
      }

      function onWhisperMessage(ev) {
        const d = ev.data || {};
        if (d.type === 'ready') {
          DESKTOP.workerReady = true;
          DESKTOP.modelLoading = false;
          DESKTOP.device = d.device || '';
          setDesktopStatus('Computer audio: on' + (d.device === 'wasm' ? ' (CPU)' : ''));
          return;
        }
        if (d.type === 'error') {
          DESKTOP.modelLoading = false;
          // The in-browser transcriber couldn't start (WebGPU/WASM/model load).
          // Randy keeps working on the microphone, so this is not something the
          // user needs to see or act on — surfacing "transcriber unavailable"
          // only confuses people. Fall back to mic-only silently; the detail is
          // left in the console for debugging.
          console.warn('desktop transcriber unavailable — using mic only:', d.error || '');
          // The transcriber can't run, so the computer-audio tap can never
          // produce text — tear the whole graph down rather than leave the
          // share/AudioContext/worker running idle for the rest of the session.
          stopDesktopCapture();
          return;
        }
        if (d.type === 'result') {
          DESKTOP.inFlight = Math.max(0, DESKTOP.inFlight - 1);
          const text = sanitizeAsrText(d.text);
          if (!text) return;
          if (d.final) handleVoiceTranscript(text);
          else updateInterim(text);
        }
      }

      // Adaptive voice-activity segmentation over the 16 kHz PCM. Builds up one
      // utterance, finalizes it after a trailing pause (or a hard length cap),
      // and refreshes a live partial in between.
      //
      // Dual-threshold + adaptive noise floor: while the line is quiet the noise
      // floor tracks the ambient level, and a segment OPENS only when the block
      // clearly exceeds it (or the fixed SILENCE_RMS floor, whichever is higher)
      // and stays open until it drops below a lower CLOSE threshold. The gap
      // between the two gives hysteresis (a brief dip mid-word won't split the
      // sentence), and a short pre-roll of pre-onset audio is prepended so the
      // first word isn't clipped — both directly improve what Whisper hears.
      function processDesktopBlock(frame) {
        if (!DESKTOP.on) return;
        const n = frame.length;
        const blockMs = (n / ASR.SAMPLE_RATE) * 1000;
        let sum = 0;
        for (let i = 0; i < n; i++) { const s = frame[i]; sum += s * s; }
        const rms = Math.sqrt(sum / n);

        const nf = DESKTOP.noiseFloor;
        const openThr = Math.max(ASR.SILENCE_RMS, nf * ASR.NOISE_OPEN_FACTOR);
        const closeThr = Math.max(ASR.CLOSE_FLOOR, nf * ASR.NOISE_CLOSE_FACTOR);

        if (!DESKTOP.speaking) {
          // Idle: let the ambient estimate drift toward the current level so the
          // bar rises in a noisy room and relaxes again when it goes quiet.
          DESKTOP.noiseFloor = Math.min(
            ASR.NOISE_FLOOR_MAX,
            Math.max(0.0005, nf * 0.97 + rms * 0.03)
          );
          if (rms >= openThr) {
            DESKTOP.speaking = true;
            DESKTOP.silenceRun = 0;
            DESKTOP.voicedRun = blockMs;
            seedSegFromPreRoll();   // recover the word onset captured before this block
            appendSeg(frame);
          } else {
            pushPreRoll(frame);     // keep rolling silent context for the next onset
          }
        } else {
          appendSeg(frame); // keep trailing audio for a clean cutoff
          if (rms >= closeThr) {
            DESKTOP.silenceRun = 0;
            DESKTOP.voicedRun += blockMs;
          } else {
            DESKTOP.silenceRun += blockMs;
            if (DESKTOP.silenceRun >= ASR.SILENCE_MS) { flushSegment(); return; }
          }
          if ((DESKTOP.segLen / ASR.SAMPLE_RATE) * 1000 >= ASR.MAX_SEG_MS) {
            flushSegment();
            return;
          }
        }
        maybeInterim();
      }

      // Rolling buffer of recent silent frames so the audio just BEFORE a word's
      // onset can be prepended to the segment (Whisper mis-reads clipped starts).
      function pushPreRoll(frame) {
        DESKTOP.preRoll.push(new Float32Array(frame));
        DESKTOP.preRollLen += frame.length;
        const cap = Math.round((ASR.PREROLL_MS / 1000) * ASR.SAMPLE_RATE);
        // Keep at least one prior block regardless of cap (one block already
        // carries ~0.25 s of onset context).
        while (DESKTOP.preRoll.length > 1 && DESKTOP.preRollLen - DESKTOP.preRoll[0].length >= cap) {
          DESKTOP.preRollLen -= DESKTOP.preRoll.shift().length;
        }
      }

      // Move the buffered pre-roll into the front of the open segment. The
      // frames are already owned copies, so no re-copy is needed.
      function seedSegFromPreRoll() {
        for (const c of DESKTOP.preRoll) { DESKTOP.seg.push(c); DESKTOP.segLen += c.length; }
        DESKTOP.preRoll = [];
        DESKTOP.preRollLen = 0;
      }

      function appendSeg(frame) {
        DESKTOP.seg.push(new Float32Array(frame)); // ScriptProcessor reuses its buffer — copy
        DESKTOP.segLen += frame.length;
        const cap = ASR.MAX_TAIL_S * ASR.SAMPLE_RATE;
        while (DESKTOP.segLen > cap && DESKTOP.seg.length > 1) {
          DESKTOP.segLen -= DESKTOP.seg.shift().length;
        }
      }

      function concatSeg() {
        const out = new Float32Array(DESKTOP.segLen);
        let off = 0;
        for (const c of DESKTOP.seg) { out.set(c, off); off += c.length; }
        return out;
      }

      function flushSegment() {
        const voiced = DESKTOP.voicedRun;
        const audio = DESKTOP.segLen ? concatSeg() : null;
        DESKTOP.seg = [];
        DESKTOP.segLen = 0;
        DESKTOP.speaking = false;
        DESKTOP.silenceRun = 0;
        DESKTOP.voicedRun = 0;
        if (!audio || voiced < ASR.MIN_VOICED_MS) return; // too short — likely a noise blip
        if (!DESKTOP.workerReady || !DESKTOP.worker) return;
        DESKTOP.reqId++;
        DESKTOP.inFlight++;
        DESKTOP.worker.postMessage({ type: 'transcribe', id: DESKTOP.reqId, final: true, audio }, [audio.buffer]);
      }

      // Throttled live partial: transcribe the open segment so the strip shows
      // words as they're spoken. Single-flight so inference can't pile up.
      function maybeInterim() {
        if (!DESKTOP.workerReady || !DESKTOP.worker || !DESKTOP.speaking) return;
        if (DESKTOP.inFlight > 0) return;
        if (DESKTOP.voicedRun < 400) return;
        const now = Date.now();
        if (now - DESKTOP.lastInterimAt < ASR.INTERIM_MS) return;
        DESKTOP.lastInterimAt = now;
        const audio = concatSeg();
        DESKTOP.reqId++;
        DESKTOP.inFlight++;
        DESKTOP.worker.postMessage({ type: 'transcribe', id: DESKTOP.reqId, final: false, audio }, [audio.buffer]);
      }

      function stopDesktopCapture() {
        if (DESKTOP.procNode) {
          try {
            DESKTOP.procNode.disconnect();
            if (DESKTOP.procNode.port) DESKTOP.procNode.port.onmessage = null; // AudioWorkletNode
            DESKTOP.procNode.onaudioprocess = null;                            // ScriptProcessorNode
          } catch {}
          DESKTOP.procNode = null;
        }
        if (DESKTOP.sourceNode) { try { DESKTOP.sourceNode.disconnect(); } catch {} DESKTOP.sourceNode = null; }
        if (DESKTOP.audioCtx) { try { DESKTOP.audioCtx.close(); } catch {} DESKTOP.audioCtx = null; }
        if (DESKTOP.stream) { try { DESKTOP.stream.getTracks().forEach(t => t.stop()); } catch {} DESKTOP.stream = null; }
        if (DESKTOP.worker) { try { DESKTOP.worker.terminate(); } catch {} DESKTOP.worker = null; }
        if (DESKTOP.workerUrl) { try { URL.revokeObjectURL(DESKTOP.workerUrl); } catch {} DESKTOP.workerUrl = null; }
        if (DESKTOP.workletUrl) { try { URL.revokeObjectURL(DESKTOP.workletUrl); } catch {} DESKTOP.workletUrl = null; }
        DESKTOP.on = false;
        DESKTOP.workerReady = false;
        DESKTOP.modelLoading = false;
        DESKTOP.seg = [];
        DESKTOP.segLen = 0;
        DESKTOP.speaking = false;
        DESKTOP.silenceRun = 0;
        DESKTOP.voicedRun = 0;
        DESKTOP.noiseFloor = ASR.NOISE_FLOOR_INIT;
        DESKTOP.preRoll = [];
        DESKTOP.preRollLen = 0;
        DESKTOP.inFlight = 0;
        DESKTOP.device = '';
        setDesktopStatus('');
      }

      /* ---------- utterance buffering + classification ---------- */

      function clearAssistBuffer() {
        TECH.buffer = '';
        TECH.deferrals = 0;
        TECH.questionQueue = [];
        if (TECH.bufferTimerId) { clearTimeout(TECH.bufferTimerId); TECH.bufferTimerId = null; }
      }

      // ASR finalizes mid-sentence constantly. Join fragments and classify
      // only after a quiet gap, so "so how does application workspace" +
      // "handle third party patching" lands as one question.
      function assistIngest(text) {
        const t = String(text || '').trim();
        if (!t) return;
        TECH.buffer = (TECH.buffer + ' ' + t).trim().slice(-ASSIST.MAX_BUFFER_CHARS);
        if (TECH.bufferTimerId) clearTimeout(TECH.bufferTimerId);
        // Complete-looking questions get a shorter quiet-gap before firing.
        const delay = isInstantTechQuestion(TECH.buffer) ? ASSIST.DEBOUNCE_FAST_MS : ASSIST.DEBOUNCE_MS;
        TECH.bufferTimerId = setTimeout(flushAssistBuffer, delay);
      }

      function flushAssistBuffer() {
        TECH.bufferTimerId = null;
        const slot = STATE.slots[0];
        if (!slot.listenOn) { clearAssistBuffer(); return; }
        const candidate = TECH.buffer.trim();

        // The speaker is still mid-sentence (fresh interim words are
        // arriving) — hold the flush so the question isn't cut off halfway.
        // The final transcript re-arms the timer when it lands; bounded so
        // a stale interim can't stall the pipeline.
        if (VOICE.interimText &&
            Date.now() - VOICE.interimAt < ASSIST.INTERIM_FRESH_MS &&
            TECH.deferrals < ASSIST.MAX_DEFERRALS) {
          TECH.deferrals++;
          TECH.bufferTimerId = setTimeout(flushAssistBuffer, ASSIST.INTERIM_RECHECK_MS);
          return;
        }

        // Reset the join buffer now so any new speech accumulates separately,
        // whether this candidate is answered immediately or queued.
        TECH.buffer = '';
        TECH.deferrals = 0;
        if (!candidate) return;

        // Busy with a previous classify/answer — queue the finalized question
        // so it's answered in turn instead of being merged into the next
        // utterance or silently dropped. The queue drains when Randy frees up.
        if (TECH.pending || slot.loading) {
          enqueueQuestion(candidate);
          return;
        }

        processAssistCandidate(candidate);
      }

      // Push an overheard question onto the FIFO queue, dropping the oldest
      // (with a visible notice) if the queue is over its cap.
      function enqueueQuestion(candidate) {
        TECH.questionQueue.push(candidate);
        if (TECH.questionQueue.length > ASSIST.MAX_QUEUE) {
          const dropped = TECH.questionQueue.shift();
          showToast('Randy is backed up — skipped: "' + truncate(dropped, 40) + '"');
        }
        renderAssistStatus();
      }

      // Randy just freed up: answer the next queued question, if any. Each
      // dequeued item runs through the same processing path as a fresh one
      // (dedupe → fast-path/classifier → runAssistAnswer).
      function drainQuestionQueue() {
        if (TECH.pending) return;
        const slot = STATE.slots[0];
        if (slot.loading) return;
        if (!slot.listenOn) { TECH.questionQueue = []; return; }
        if (!TECH.questionQueue.length) return;
        const next = TECH.questionQueue.shift();
        renderAssistStatus();
        processAssistCandidate(next);
      }

      // Self-healing watchdog — the backstop behind the per-call timeouts, and
      // the reason a heard question can NEVER leave Randy frozen on "Analyzing"
      // or "Researching." It mirrors the recognizer's startRecognitionWatchdog:
      // every few seconds it looks for a stage that has been busy far longer
      // than its own timeout should ever allow and un-sticks it. The mic stream
      // held by startListening keeps this interval firing even in a background
      // tab. In normal operation it never acts — the per-call timeouts settle
      // everything first; this only earns its keep if something slips past them.
      function startAssistWatchdog() {
        if (TECH.watchdogId) return;
        TECH.watchdogId = setInterval(assistWatchdogTick, ASSIST.WATCHDOG_MS);
      }

      function stopAssistWatchdog() {
        if (TECH.watchdogId) { clearInterval(TECH.watchdogId); TECH.watchdogId = null; }
      }

      function assistWatchdogTick() {
        const slot = STATE.slots[0];
        if (!slot || !slot.listenOn) return;
        const now = Date.now();

        // Classifier wedged: the gate has shown "Analyzing" far longer than the
        // classify timeout permits. Bump the epoch so the original promise
        // can't double-fire if it ever wakes, abort the round-trip, and recover
        // through the shared fallback so an obvious question still gets answered.
        if (TECH.pending && TECH.pendingSince && now - TECH.pendingSince > ASSIST.PENDING_WEDGE_MS) {
          console.warn('assist watchdog: classifier wedged — recovering');
          TECH.classifyGen++;
          if (TECH.classifyController) { try { TECH.classifyController.abort(); } catch {} }
          TECH.classifyController = null;
          TECH.pending = false;
          TECH.pendingSince = 0;
          const stuck = TECH.activeText || '';
          if (stuck && !slot.loading) assistFallbackDecision(stuck);
          else { renderAssistStatus(); drainQuestionQueue(); }
          return;
        }

        // Answer wedged: "Researching" has been up longer than even a retrying
        // answer could take. Abort the in-flight fetch — runAssistAnswer's own
        // catch then frees the slot and drains the queue. If the controller is
        // somehow gone, free the slot directly so the queue can never stall.
        if (slot.loading && TECH.answerSince && now - TECH.answerSince > ASSIST.ANSWER_WEDGE_MS) {
          console.warn('assist watchdog: answer wedged — recovering');
          if (slot.abortController) {
            try { slot.abortController.abort(); } catch {}
          } else {
            slot.loading = false;
            TECH.answerSince = 0;
            render();
            drainQuestionQueue();
          }
        }
      }

      // Classify (or fast-path) a finalized candidate and answer it when it
      // clears the gate. Non-answering paths drain the next queued question so
      // a skip never strands the rest of the queue.
      function processAssistCandidate(candidate) {
        const words = candidate.split(/\s+/).filter(Boolean);
        if (candidate.length < ASSIST.MIN_CHARS || words.length < ASSIST.MIN_WORDS) {
          recordAssistDecision(candidate, false, 0, 'too short');
          renderAssistStatus();
          drainQuestionQueue();
          return;
        }
        // Repair common ASR garbles of product names ("in tune" → "Intune")
        // so detection, the answer, and the saved log all read the real
        // term. The fast-path test below still runs on the RAW candidate, so
        // a correction can only ever route to the classifier, never create a
        // new auto-answer.
        const corrected = correctTranscript(candidate);

        const now = Date.now();
        if (TECH.lastSubmitted && now - TECH.lastSubmittedAt < ASSIST.DEDUPE_MS && fuzzyEqual(corrected, TECH.lastSubmitted)) {
          drainQuestionQueue();
          return;
        }

        pushAssistContext(corrected);

        // Start the latency timeline for this question (t0 = finalized question
        // entered the pipeline). runAssistAnswer / the rejection paths finish it.
        TECH.perf = perfStart(corrected);

        // Fast path: an obvious technical question goes straight to the
        // answer — no classifier round-trip (saves a couple of seconds). The
        // out-of-scope guard keeps pricing/contract asks about in-scope
        // products off the fast path; they fall to the classifier, which
        // correctly declines them.
        if (isInstantTechQuestion(candidate) && !OUT_OF_SCOPE_RE.test(candidate)) {
          recordAssistDecision(corrected, true, 0.85, 'instant');
          TECH.lastSubmitted = corrected;
          TECH.lastSubmittedAt = Date.now();
          runAssistAnswer(0, corrected);
          return;
        }

        TECH.pending = true;
        TECH.pendingSince = Date.now();
        TECH.activeText = corrected;   // surfaced in the live "Analyzing question" band
        // New classify cycle. The epoch lets a late resolution be ignored if
        // the watchdog already gave up on this one and recovered the pipeline,
        // so a question can never be answered twice. The controller lets the
        // watchdog abort a wedged round-trip.
        const gen = ++TECH.classifyGen;
        const classifyCtl = new AbortController();
        TECH.classifyController = classifyCtl;
        const perf = TECH.perf;
        perfMark(perf, 'classifyStart');
        renderAssistStatus();
        classifyUtterance(corrected, TECH.context.slice(0, -1), classifyCtl.signal)
          .then(decision => {
            if (gen !== TECH.classifyGen) return;   // superseded by the watchdog — ignore
            perfMark(perf, 'classifyEnd');
            TECH.pending = false;
            TECH.pendingSince = 0;
            TECH.classifyController = null;
            // The reply came back but we couldn't read a verdict from it (proxy
            // didn't forward structured output, or returned prose/empty). Don't
            // drop an obvious technical question over a format glitch — fall
            // back to answering, the same net the network-error path uses.
            if (decision.parsed === false) { assistFallbackDecision(corrected); return; }
            const conf = typeof decision.confidence === 'number' ? decision.confidence : 0;
            const accepted =
              decision.needs_answer === true &&
              decision.in_scope !== false &&
              conf >= ASSIST.CONF_THRESHOLD;
            // Near-miss: a flagged need that landed just under the bar. Logged
            // so the live strip can offer a one-tap "answer this?" chip.
            const nearMiss = !accepted && decision.needs_answer === true &&
              decision.in_scope !== false && conf >= 0.4 && conf < ASSIST.CONF_THRESHOLD;
            recordAssistDecision(corrected, accepted, conf, decision.topic || '', nearMiss);
            if (!accepted) { perfFinish(perf, 'rejected'); renderAssistStatus(); drainQuestionQueue(); return; }
            // Answer the classifier's clean rewrite when it produced one: it
            // turns a statement-form need into an explicit question and
            // resolves garble/follow-up references. Fall back to the corrected
            // transcript if the rewrite is missing or implausibly short.
            const nq = decision.normalized_question || '';
            const toAnswer = nq.length >= ASSIST.MIN_CHARS ? nq : corrected;
            TECH.lastSubmitted = corrected;
            TECH.lastSubmittedAt = Date.now();
            runAssistAnswer(0, toAnswer);
          })
          .catch(err => {
            if (gen !== TECH.classifyGen) return;   // superseded by the watchdog — ignore
            TECH.pending = false;
            TECH.pendingSince = 0;
            TECH.classifyController = null;
            console.error('classifier failed:', err);
            toastPipelineError("Randy couldn't check a question", err);
            // Keep the SE alive: obvious technical questions are answered even
            // when the classifier times out or its service is unreachable.
            assistFallbackDecision(corrected);
          });
      }

      // Classifier unusable — it timed out, its service is down, or the reply
      // couldn't be read as a verdict. Keep the SE alive instead of dropping
      // the utterance: an obvious technical question still gets answered, and
      // anything else is logged so the queue moves on. Shared by the
      // parse-failure, network-error, and watchdog paths so a dead or garbled
      // gate can never strand a question Randy already heard.
      function assistFallbackDecision(text) {
        if (looksLikeTechQuestion(text)) {
          recordAssistDecision(text, true, 0.7, 'fallback match');
          TECH.lastSubmitted = text;
          TECH.lastSubmittedAt = Date.now();
          runAssistAnswer(0, text);
        } else {
          recordAssistDecision(text, false, 0, 'check unavailable');
          perfFinish(TECH.perf, 'dropped');
          renderAssistStatus();
          drainQuestionQueue();
        }
      }

      function pushAssistContext(text) {
        TECH.context.push(text);
        while (TECH.context.length > ASSIST.CONTEXT_LEN) TECH.context.shift();
      }

      function recordAssistDecision(text, accepted, confidence, topic, nearMiss) {
        TECH.heard++;
        TECH.decisions.push({ text, accepted: !!accepted, confidence: Number(confidence) || 0, topic: topic || '', nearMiss: !!nearMiss, ts: Date.now() });
        while (TECH.decisions.length > ASSIST.DECISIONS_KEEP) TECH.decisions.shift();
      }

      // One pipeline-failure toast per 30s — loud, but not spammy.
      function toastPipelineError(prefix, err) {
        const now = Date.now();
        if (now - TECH.lastErrorToastAt < 30000) return;
        TECH.lastErrorToastAt = now;
        showToast(prefix + ' — ' + (err && err.message ? err.message : err));
      }

      function fuzzyEqual(a, b) {
        const n = s => String(s).toLowerCase().replace(/[^\w]+/g, ' ').trim();
        return n(a) === n(b);
      }

      // Status-only refresh that respects composer focus (a full render would
      // steal the caret mid-typing; in that case skip — the next natural
      // render catches up).
      function renderAssistStatus() {
        if (!isComposerFocused()) render();
      }

      async function classifyUtterance(text, contextArr, signal) {
        if (!GSHEET_WEBHOOK) return { needs_answer: false, confidence: 0, parsed: true };
        const ctxLines = (contextArr || []).map((u, i) => (i + 1) + '. ' + u).join('\n');
        const userContent =
          (ctxLines ? 'Recent context (older first):\n' + ctxLines + '\n\n' : '') +
          'Latest utterance:\n' + text;
        const data = await postChat({
          model: MODELS.classifier,
          max_tokens: 200,
          system: CLASSIFIER_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          output_config: { format: { type: 'json_schema', schema: CLASSIFIER_SCHEMA } },
          save: false // keep classifier churn out of the history sheet
        }, signal, ASSIST.CLASSIFY_TIMEOUT_MS);
        return parseClassifierReply(String(data.reply || ''));
      }

      // Structured outputs guarantee valid JSON, but parse defensively anyway
      // (older proxy deployments may not forward output_config). Stays
      // backward-compatible with the old schema: a reply that only carries the
      // legacy is_question field still produces a usable needs_answer verdict.
      // parsed:false flags a reply we could not read as a verdict (no JSON, or
      // JSON that didn't parse) — distinct from a genuine needs_answer:false.
      // The caller uses it to fall back to answering an obvious technical
      // question instead of silently dropping it over a format glitch.
      function parseClassifierReply(reply) {
        const m = reply.match(/\{[\s\S]*\}/);
        if (!m) return { needs_answer: false, confidence: 0, parsed: false };
        try {
          const j = JSON.parse(m[0]);
          const needs = typeof j.needs_answer === 'boolean' ? j.needs_answer : !!j.is_question;
          return {
            needs_answer: needs,
            is_question: typeof j.is_question === 'boolean' ? j.is_question : needs,
            in_scope: typeof j.in_scope === 'boolean' ? j.in_scope : true,
            normalized_question: typeof j.normalized_question === 'string' ? j.normalized_question.trim() : '',
            confidence: typeof j.confidence === 'number' ? j.confidence : 0,
            topic: j.topic || '',
            reason: j.reason || '',
            parsed: true
          };
        } catch {
          return { needs_answer: false, confidence: 0, parsed: false };
        }
      }

      // Typed-question ambiguity gate (see AMBIGUITY_SYSTEM). Mirrors
      // classifyUtterance exactly: same fast model, same proxy helper, same
      // hard timeout, same defensive parsing, save:false. Callers treat ANY
      // failure (unreachable, timeout, unparseable) as "not ambiguous" — a
      // glitch in this pre-check must never block or delay an answer.
      async function checkAmbiguity(question, recentThread, signal) {
        if (!GSHEET_WEBHOOK) return { needs_clarification: false, clarifying_question: '', options: [], reason: '' };
        const userContent =
          (recentThread ? 'Recent conversation (older first):\n' + recentThread + '\n\n' : '') +
          'Typed question:\n' + question;
        const data = await postChat({
          model: MODELS.classifier,
          max_tokens: 300,
          system: AMBIGUITY_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          output_config: { format: { type: 'json_schema', schema: AMBIGUITY_SCHEMA } },
          save: false // keep pre-check churn out of the history sheet
        }, signal, ASSIST.CLASSIFY_TIMEOUT_MS);
        return parseAmbiguityReply(String(data.reply || ''));
      }

      // Parse defensively, like parseClassifierReply. Anything unreadable
      // collapses to "not ambiguous". Options are validated against the real
      // portfolio (KNOWN_PORTFOLIO_RE) and deduped; if fewer than two real
      // options survive — or the clarifying question is missing — there is
      // nothing usable to ask, so the verdict is "just answer".
      function parseAmbiguityReply(reply) {
        const notAmbiguous = { needs_clarification: false, clarifying_question: '', options: [], reason: '' };
        const m = reply.match(/\{[\s\S]*\}/);
        if (!m) return notAmbiguous;
        try {
          const j = JSON.parse(m[0]);
          if (j.needs_clarification !== true) return notAmbiguous;
          const q = typeof j.clarifying_question === 'string' ? j.clarifying_question.trim() : '';
          const opts = [];
          for (const o of (Array.isArray(j.options) ? j.options : [])) {
            const t = typeof o === 'string' ? o.trim() : '';
            if (t && t.length <= 80 && KNOWN_PORTFOLIO_RE.test(t) && !opts.some(x => fuzzyEqual(x, t))) opts.push(t);
          }
          if (!q || opts.length < 2) return notAmbiguous;
          return {
            needs_clarification: true,
            clarifying_question: q,
            options: opts.slice(0, 4),
            reason: typeof j.reason === 'string' ? j.reason : ''
          };
        } catch {
          return notAmbiguous;
        }
      }

      /* ================================================================
       * API LAYER
       * ================================================================ */

      // One POST to the Apps Script proxy. text/plain avoids the CORS
      // preflight Apps Script can't answer.
      //
      // Every call is bounded by a hard timeout. A fetch with no timeout can
      // hang indefinitely — a slow Apps Script cold-start, a connection that
      // stalls without ever erroring, the tab being backgrounded mid-request.
      // Left unbounded, a hung classifier call would freeze the whole assist
      // pipeline forever (its promise never settles, so TECH.pending never
      // clears and no further question is ever answered). The timeout aborts
      // the request so the promise ALWAYS settles; it composes with any
      // caller-supplied signal so user-initiated cancel still works. A timeout
      // surfaces as a TimeoutError (not AbortError), so callers treat it as a
      // real failure to retry/fall back rather than a silent user cancel.
      async function postChat(body, signal, timeoutMs) {
        if (!GSHEET_WEBHOOK) {
          throw new Error('Answer service is not configured.');
        }
        // Make sure the anon id is loaded before attaching metadata.user_id. It
        // resolves long before any real call, so this never adds latency.
        try { await ensureIdentity(); } catch {}
        const payload = Object.assign({ action: 'chat', session_id: SESSION_ID }, body);
        // Tag the model call with the opaque anonymous install id (metadata
        // .user_id) — never the name or any other personal info. The proxy
        // forwards this through to the Anthropic request.
        if (IDENTITY.anonId) {
          payload.metadata = Object.assign({}, payload.metadata, { user_id: IDENTITY.anonId });
        }
        const timer = new AbortController();
        const ms = timeoutMs || ASSIST.ANSWER_TIMEOUT_MS;
        const timeoutId = setTimeout(
          () => { try { timer.abort(new DOMException('Request timed out', 'TimeoutError')); } catch { timer.abort(); } },
          ms
        );
        const onAbort = () => { try { timer.abort(signal.reason); } catch { timer.abort(); } };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          const resp = await fetch(GSHEET_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: timer.signal
          });
          if (!resp.ok) throw new Error('Proxy HTTP ' + resp.status);
          const data = await resp.json();
          if (!data || data.ok === false) {
            throw new Error((data && data.error) || 'Proxy returned an error');
          }
          return data;
        } finally {
          clearTimeout(timeoutId);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }

      // Fire-and-forget Q&A save (the proxy's legacy save action). Chat calls
      // send save:false so the proxy skips its synchronous sheet append —
      // that append cost ~0.5-2s of SpreadsheetApp time on every answer's
      // critical path. Saving from here instead happens after the answer is
      // already on screen. This is the silent per-session log: rows go UP to
      // the sheet tagged with session_id, and nothing is ever read back.
      function postSaveToSheet({ question, answer, sources, model, sessionId }) {
        if (!GSHEET_WEBHOOK || !question || !answer) return Promise.resolve();
        return fetch(GSHEET_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            question: question,
            answer: answer,
            sources: Array.isArray(sources) ? sources.join(', ') : String(sources || ''),
            model: model || '',
            session_id: sessionId || '',
            // Usage log only (NOT the model call): pair each inquiry with the
            // anonymous id AND the captured name so rows in the sheet can be
            // traced back to a user. (The API request above gets the id alone.)
            user_id: IDENTITY.anonId || '',
            user_name: identityFullName(),
            first_name: IDENTITY.userName ? IDENTITY.userName.firstName : '',
            last_name: IDENTITY.userName ? IDENTITY.userName.lastName : ''
          })
        }).catch(err => console.warn('Background save failed:', err));
      }

      // System prompt as a block array so the stable persona prefix is
      // eligible for Anthropic prompt caching.
      function systemBlocks(text) {
        return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
      }

      function conversationPayloadMessages(slot, cap) {
        return slot.messages
          .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
          .slice(-cap)
          .map(m => ({ role: m.role, content: m.content }));
      }

      /* ---------- conversational sends (typed input) ---------- */

      async function sendMessage(idx, opts) {
        const slot = STATE.slots[idx];
        // Claim the slot synchronously so near-simultaneous callers (voice
        // finalization + Enter key) can't double-send.
        if (slot.loading) return;
        const text = slot.inputText.trim();
        if (!text) return;
        // If the user was voice-typing into this composer, end dictation so the
        // mic is freed and Randy's passive listener resumes.
        if (isHomeDictating(idx)) stopDictation();
        slot.loading = true;

        // Ambiguity pre-check guard — one clarifying round maximum, never a
        // loop. Skip the check when this send was produced by a clarify pick
        // (opts.skipClarify), or when the message being sent is itself the
        // user's typed reply to a clarify prompt (the most recent assistant
        // message is kind:'clarify' — the thread now carries the
        // clarification, so just answer).
        const lastAssistant = slot.messages.filter(m => m.role === 'assistant').pop();
        const skipClarify = !!(opts && opts.skipClarify) || !!(lastAssistant && lastAssistant.kind === 'clarify');

        slot.messages.push({ role: 'user', content: text });
        slot.inputText = '';

        const controller = new AbortController();
        slot.abortController = controller;

        slot.messages.push({ role: 'assistant', content: '' });
        const assistantMsgIdx = slot.messages.length - 1;

        // If the pop-out is sitting collapsed, a new question should bring
        // it back so the reply is visible.
        pipAutoExpand();
        render();
        scrollChat();

        try {
          // Quick ambiguity gate (TYPED path only — runAssistAnswer never
          // does this): before spending an answer call, ask the fast
          // classifier model whether the question genuinely needs one
          // product-disambiguation question first. Bounded and best-effort —
          // any failure here falls straight through to a normal answer.
          if (!skipClarify) {
            let verdict = null;
            try {
              const recentThread = slot.messages.slice(0, assistantMsgIdx - 1)
                .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
                .slice(-4)
                .map(m => (m.role === 'user' ? 'User: ' : 'Randy: ') + stripMarkdown(String(m.content)).slice(0, 300))
                .join('\n');
              verdict = await checkAmbiguity(text, recentThread, controller.signal);
            } catch (err) {
              // A user cancel must still cancel; anything else means the
              // pre-check is unavailable — never let that block the answer.
              if (err && err.name === 'AbortError') throw err;
              console.warn('ambiguity pre-check failed — answering directly:', err);
            }
            if (verdict && verdict.needs_clarification) {
              // Ask instead of answering: swap the placeholder for a
              // clarify message. content carries a plain-text rendition so
              // the exchange reads correctly in the model context if the
              // user types a free-text reply (and in the pop-out); the
              // dedicated fields drive the tappable UI. Not a final answer,
              // so no autoCopyAnswer and no postSaveToSheet.
              slot.messages[assistantMsgIdx] = {
                role: 'assistant',
                content: verdict.clarifying_question + ' (' + verdict.options.join(' / ') + ')',
                kind: 'clarify',
                clarifyQuestion: verdict.clarifying_question,
                clarifyOptions: verdict.options,
                pendingQuestion: text
              };
              if (slot.abortController === controller) {
                slot.loading = false;
                slot.abortController = null;
              }
              render();
              scrollChat();
              return;
            }
          }

          // Typed chat answers use the exact same recipe as the overheard
          // voice path (ASSIST_STYLE, same effort, same search config, same
          // reply parsing) so the format and sources are identical no matter
          // how the question arrived. Two differences: typed chat keeps the
          // full multi-turn thread for follow-ups, and it answers in one shot
          // rather than streaming token-by-token the way the voice path does.
          const sessionIdAtSend = SESSION_ID;

          // Strictly source only from the approved doc URLs. Without this,
          // chat web_search ran against the open web and could surface facts
          // from unvetted sites — the cause of inaccurate answers. Mirror the
          // technical-assist path: restrict to the allow-list, and fall back to
          // the default research domains so a wiped Settings box can never
          // silently re-open the whole web.
          const domains = (slot.allowedDomains || []).filter(Boolean);
          const allowed = domains.length ? domains : DEFAULT_RESEARCH_DOMAINS.slice();
          const tool = { type: SEARCH_TOOL, name: 'web_search', max_uses: ASSIST.SEARCH_MAX_USES, allowed_domains: allowed };

          // The empty assistant placeholder is already excluded by the
          // content filter inside conversationPayloadMessages.
          const baseBody = {
            model: MODELS.chat,
            max_tokens: 1100,
            // Match the voice path's reasoning effort so identical questions
            // get identical answers. (Older proxy deployments drop this
            // field harmlessly.)
            output_config: { effort: 'medium' },
            system: systemBlocks(slot.prompt + '\n\n' + ASSIST_STYLE),
            messages: conversationPayloadMessages(slot, 20),
            // Skip the proxy's synchronous sheet append; saved from the
            // client below, off the answer's critical path.
            save: false
          };
          let data;
          // Preferred path: stream the typed/highlight answer through the edge
          // proxy when one is configured, exactly as the voice path does — the
          // reply fills the panel live instead of appearing only once fully
          // generated. Any transport failure (not a user cancel) falls through
          // to the non-streaming Apps Script path below, so configuring
          // STREAM_WEBHOOK can never make Randy worse. perfMark tolerates a null
          // perf, so no timeline is needed here.
          if (STREAM_WEBHOOK) {
            try {
              const r = await streamAssistReply(Object.assign({ tools: [tool] }, baseBody), controller.signal, idx, assistantMsgIdx, null);
              data = { reply: r.reply, sources: r.sources, usage: r.usage };
            } catch (err) {
              if (err && err.name === 'AbortError') throw err;
              console.warn('streaming answer failed — falling back to non-streaming proxy:', err);
            }
          }
          if (!data) {
            try {
              data = await postChat(Object.assign({ tools: [tool] }, baseBody), controller.signal);
            } catch (err) {
              if (err && err.name === 'AbortError') throw err;
              // Web search failed (tool rejected, timeout, transient error) —
              // answer from knowledge rather than staying silent. Same fallback
              // the voice path uses.
              console.error('search-enabled answer failed, retrying without tools:', err);
              data = await postChat(baseBody, controller.signal);
            }
          }

          // Parse exactly like the voice path: strip any false-start preamble,
          // split off the spoken summary so Read aloud speaks the short version.
          const { main, spoken } = splitSpoken(String(data.reply || ''));
          const msg = slot.messages[assistantMsgIdx];
          msg.content = sanitizeAssistAnswer(main) || 'No response.';
          msg.spoken = spoken;
          if (Array.isArray(data.sources) && data.sources.length) {
            msg.sources = data.sources.slice(0, 6);
          }
          // Remember what was asked so the answer can offer the "upcoming
          // Recast sessions on this topic?" follow-up (see eventsOfferEligible).
          msg.topicSeed = text;
          // Auto-copy the answer so it's ready to paste — same text the manual
          // copy button would put on the clipboard (stripMarkdown of content).
          autoCopyAnswer(stripMarkdown(msg.content));
          notePipAnswerArrived();

          // Background save (the proxy only saved non-empty replies; mirror that).
          postSaveToSheet({
            question: text,
            answer: String(data.reply || ''),
            sources: data.sources,
            model: MODELS.chat,
            sessionId: sessionIdAtSend
          });
        } catch (err) {
          if (err && err.name === 'AbortError') {
            const placeholder = slot.messages[assistantMsgIdx];
            if (placeholder && placeholder.role === 'assistant' && !placeholder.content) {
              slot.messages.splice(assistantMsgIdx, 1);
            }
          } else {
            const placeholder = slot.messages[assistantMsgIdx];
            const errMsg = '⚠️ ' + (err.message || 'Connection failed. Check your internet connection and try again.');
            if (placeholder && placeholder.role === 'assistant') placeholder.content = errMsg;
            else slot.messages.push({ role: 'assistant', content: errMsg });
            notePipAnswerArrived();
          }
        }

        if (slot.abortController === controller) {
          slot.loading = false;
          slot.abortController = null;
        }
        render();
        scrollChat();
      }

      /* ================================================================
       * STREAMING ANSWER CLIENT (optional — see STREAMING.md / worker.js)
       *
       * Reads the edge function's simple SSE protocol — one event per line:
       *   data: {"type":"text","text":"…"}    incremental answer text
       *   data: {"type":"sources","sources":[…]}
       *   data: {"type":"usage","usage":{…}}   (prompt-cache verification)
       *   data: {"type":"error","error":"…"}
       *   data: {"type":"done"}
       * As text arrives it fills the chat panel live (throttled render) and the
       * spoken summary after ===SPOKEN=== is fed to the EXISTING TTS sentence
       * queue one finished sentence at a time. Returns the same shape postChat
       * does ({reply, sources, usage}) so the rest of runAssistAnswer is
       * unchanged. Throws on transport error so the caller falls back to the
       * non-streaming Apps Script path.
       * ================================================================ */

      const SPOKEN_MARKER_RE = /\n?=+\s*SPOKEN\s*=+\s*\n?/i;

      // Split a (possibly partial) reply into the visible answer and the start
      // index of the spoken portion. While the marker is still forming at the
      // tail, hide it so a half-typed "===SPOK" never flashes on screen.
      function streamSpokenSplit(reply) {
        const m = reply.match(SPOKEN_MARKER_RE);
        if (m) return { visible: reply.slice(0, m.index), spokenStart: m.index + m[0].length };
        return { visible: reply.replace(/\n?=+[\sA-Za-z]*$/i, ''), spokenStart: -1 };
      }

      // Pull whole sentences off the front of `text`, leaving any trailing
      // partial sentence for the next delta. A '.'/'!'/'?' only ends a sentence
      // when whitespace follows, so decimals like "3.5" aren't split mid-number.
      function takeCompleteSentences(text) {
        const sentences = [];
        let start = 0;
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (c === '.' || c === '!' || c === '?') {
            const next = text[i + 1];
            if (next === undefined) break;            // maybe mid-stream — wait for more
            if (/\s/.test(next)) {
              const s = text.slice(start, i + 1).trim();
              if (s.length >= 2) sentences.push(s);
              start = i + 1;
            }
          }
        }
        return { sentences, consumed: start };
      }

      async function streamAssistReply(body, signal, idx, msgIdx, perf) {
        const slot = STATE.slots[idx];
        try { await ensureIdentity(); } catch {}
        const payload = Object.assign({ action: 'chat', session_id: SESSION_ID }, body, { stream: true });
        // Same as postChat: carry only the opaque anonymous id to the model,
        // never the name. The edge proxy forwards it to the Anthropic request.
        if (IDENTITY.anonId) {
          payload.metadata = Object.assign({}, payload.metadata, { user_id: IDENTITY.anonId });
        }

        // Bound the whole stream like postChat does, composing with the caller's
        // signal so a user cancel / watchdog abort still cuts it.
        const timer = new AbortController();
        const timeoutId = setTimeout(
          () => { try { timer.abort(new DOMException('Request timed out', 'TimeoutError')); } catch { timer.abort(); } },
          ASSIST.ANSWER_TIMEOUT_MS
        );
        const onAbort = () => { try { timer.abort(signal.reason); } catch { timer.abort(); } };
        if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }

        const speakOn = !!slot.speakAnswers;
        let ttsInit = false, streamedTts = false, gotText = false;
        let reply = '', sources = [], usage = null;
        let spokenEmitted = 0, lastRender = 0;

        const onText = (chunk) => {
          reply += chunk;
          if (!gotText) { gotText = true; perfMark(perf, 'firstToken'); }
          const { visible, spokenStart } = streamSpokenSplit(reply);
          const m = slot.messages[msgIdx];
          if (m && m.role === 'assistant') m.content = sanitizeAssistAnswer(visible) || '';
          const now = performance.now();
          if (now - lastRender > 110) { lastRender = now; if (!isComposerFocused()) render(); }
          // Feed finished spoken sentences to the TTS queue as they land.
          if (speakOn && spokenStart !== -1) {
            const ready = reply.slice(spokenStart + spokenEmitted);
            const { sentences, consumed } = takeCompleteSentences(ready);
            if (sentences.length) {
              if (!ttsInit) { initTtsQueue(idx, signal, msgIdx); ttsInit = true; }
              for (const s of sentences) {
                if (!streamedTts) { streamedTts = true; perfMark(perf, 'firstAudio'); }
                enqueueTtsSentence(idx, s);
              }
              spokenEmitted += consumed;
            }
          }
        };

        try {
          const resp = await fetch(STREAM_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: timer.signal
          });
          if (!resp.ok || !resp.body) throw new Error('Stream HTTP ' + resp.status);
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const js = line.slice(5).trim();
              if (!js) continue;
              let ev; try { ev = JSON.parse(js); } catch { continue; }
              if (ev.type === 'text' && ev.text) onText(ev.text);
              else if (ev.type === 'sources') sources = Array.isArray(ev.sources) ? ev.sources : sources;
              else if (ev.type === 'usage') usage = ev.usage || usage;
              else if (ev.type === 'error') throw new Error(ev.error || 'stream error');
            }
          }
        } finally {
          clearTimeout(timeoutId);
          if (signal) signal.removeEventListener('abort', onAbort);
        }

        // Flush a trailing spoken sentence with no terminal whitespace, then mark
        // the queue done so it stops once the last sentence has been spoken.
        if (speakOn && ttsInit) {
          const { spokenStart } = streamSpokenSplit(reply);
          if (spokenStart !== -1) {
            const tail = reply.slice(spokenStart + spokenEmitted).trim();
            if (tail.length >= 2) enqueueTtsSentence(idx, tail);
          }
          if (slot.ttsQueue) { slot.ttsQueue.done = true; processTtsQueue(idx); }
        }
        return { reply, sources, usage, streamedTts };
      }

      /* ---------- technical-assist answers ---------- */

      async function runAssistAnswer(idx, question) {
        const slot = STATE.slots[idx];
        // Busy with another answer — don't drop this question on the floor.
        // Re-queue it so it's answered the moment the slot frees (drainQueue
        // pulls it then). A bare `return` here used to strand both this
        // question and the queue behind it.
        if (slot.loading) { enqueueQuestion(question); return; }
        slot.loading = true;
        TECH.answerSince = Date.now();
        const perf = TECH.perf;   // timeline opened by processAssistCandidate
        let answerStatus = 'answered';

        // Every auto-answered question starts a visually fresh chat: the
        // previous Q&A slides into Saved Conversations so the panel always
        // shows just the question being answered now. Follow-up context is
        // preserved separately in TECH.recentPairs.
        if (collectPairs(slot).length) {
          if (slot.isSpeaking) stopSpeaking();
          archiveChatToHistory(slot);
        }

        slot.messages.push({ role: 'user', content: question, kind: 'assist-q' });
        const controller = new AbortController();
        slot.abortController = controller;
        slot.messages.push({ role: 'assistant', content: '', kind: 'assist' });
        const assistantMsgIdx = slot.messages.length - 1;

        // A question was overheard — bring the collapsed pop-out icon back
        // so the user watches the answer arrive.
        pipAutoExpand();
        render();
        scrollChat();

        try {
          // Context: the last few assist Q&A pairs keep follow-up questions
          // coherent ("and what about Intune?") without dragging latency.
          // Pulled from TECH.recentPairs, not the chat — the chat is archived
          // to History before each new question.
          const prior = [];
          for (const p of TECH.recentPairs.slice(-ASSIST.HISTORY_PAIRS)) {
            prior.push({ role: 'user', content: p.question });
            prior.push({ role: 'assistant', content: p.answer });
          }

          // Strictly source only from the approved doc URLs. Fall back to the
          // default research domains when the Settings box is empty so a wiped
          // allow-list can never silently re-open the whole web — same hard
          // enforcement the chat/voice path uses.
          const domains = (slot.allowedDomains || []).filter(Boolean);
          const allowed = domains.length ? domains : DEFAULT_RESEARCH_DOMAINS.slice();
          const tool = { type: SEARCH_TOOL, name: 'web_search', max_uses: ASSIST.SEARCH_MAX_USES, allowed_domains: allowed };

          const sessionIdAtSend = SESSION_ID;
          const baseBody = {
            model: MODELS.assist,
            max_tokens: 1100,
            // Medium effort trades a sliver of depth for noticeably faster
            // answers — right for a live call. (Older proxy deployments drop
            // this field harmlessly.)
            output_config: { effort: 'medium' },
            system: systemBlocks(slot.prompt + '\n\n' + ASSIST_STYLE),
            messages: prior.concat([{ role: 'user', content: question }]),
            // The proxy's synchronous sheet append would sit on the answer's
            // critical path — skip it and save from the client afterwards.
            save: false
          };
          let data, streamedTts = false;
          perfMark(perf, 'answerStart');
          // Preferred path: stream the answer through the edge proxy when one is
          // configured. The reply fills the panel live and the spoken summary is
          // read aloud sentence-by-sentence as it arrives. Any transport failure
          // (not a user cancel) falls through to the non-streaming Apps Script
          // path below, so configuring STREAM_WEBHOOK can never make Randy worse.
          if (STREAM_WEBHOOK) {
            try {
              const r = await streamAssistReply(Object.assign({ tools: [tool] }, baseBody), controller.signal, idx, assistantMsgIdx, perf);
              data = { reply: r.reply, sources: r.sources, usage: r.usage };
              streamedTts = r.streamedTts;
            } catch (err) {
              if (err && err.name === 'AbortError') throw err;
              console.warn('streaming answer failed — falling back to non-streaming proxy:', err);
            }
          }
          if (!data) {
            try {
              data = await postChat(Object.assign({ tools: [tool] }, baseBody), controller.signal);
            } catch (err) {
              if (err && err.name === 'AbortError') throw err;
              // Web search failed (tool rejected, timeout, transient error) —
              // answer from knowledge rather than staying silent.
              console.error('search-enabled answer failed, retrying without tools:', err);
              data = await postChat(baseBody, controller.signal);
            }
          }
          perfMark(perf, 'answerEnd');
          perfCache(perf, data.usage, 'answer');   // verify the persona prefix is cache-hitting

          const { main, spoken } = splitSpoken(String(data.reply || ''));
          const msg = slot.messages[assistantMsgIdx];
          msg.content = sanitizeAssistAnswer(main) || 'No response.';
          msg.spoken = spoken;
          if (Array.isArray(data.sources) && data.sources.length) {
            msg.sources = data.sources.slice(0, 6);
          }
          // Remember what was asked so the answer can offer the "upcoming
          // Recast sessions on this topic?" follow-up (see eventsOfferEligible).
          msg.topicSeed = question;
          // Auto-copy the answer so it's ready to paste — same text the manual
          // copy button would put on the clipboard (stripMarkdown of content).
          autoCopyAnswer(stripMarkdown(msg.content));

          // Streaming already spoke the summary sentence-by-sentence; only the
          // non-streaming path needs the one-shot read here.
          if (!streamedTts && slot.speakAnswers && spoken) {
            perfMark(perf, 'firstAudio');   // spoken summary handed to TTS
            speakText(spoken, idx, assistantMsgIdx);
          }
          notePipAnswerArrived();
          TECH.answered++;
          TECH.recentPairs.push({ question, answer: msg.content });
          while (TECH.recentPairs.length > ASSIST.HISTORY_PAIRS) TECH.recentPairs.shift();

          // Save the raw reply (same text the proxy used to append) in the
          // background.
          postSaveToSheet({
            question,
            answer: String(data.reply || ''),
            sources: data.sources,
            model: MODELS.assist,
            sessionId: sessionIdAtSend
          });
        } catch (err) {
          if (err && err.name === 'AbortError') {
            answerStatus = 'aborted';
            const placeholder = slot.messages[assistantMsgIdx];
            if (placeholder && placeholder.role === 'assistant' && !placeholder.content) {
              slot.messages.splice(assistantMsgIdx, 1);
            }
          } else {
            answerStatus = 'error';
            console.error('assist answer failed:', err);
            toastPipelineError("Randy couldn't answer", err);
            const placeholder = slot.messages[assistantMsgIdx];
            const errMsg = '⚠️ ' + (err.message || 'Connection failed. Check your internet connection and try again.');
            if (placeholder && placeholder.role === 'assistant') placeholder.content = errMsg;
            notePipAnswerArrived();
          }
        }

        perfFinish(perf, answerStatus);
        if (slot.abortController === controller) {
          slot.loading = false;
          slot.abortController = null;
          TECH.answerSince = 0;
        }
        render();
        scrollChat();
        // Randy is free again — answer the next overheard question, if any.
        drainQuestionQueue();
      }

      /* ================================================================
       * "UPCOMING SESSIONS" FOLLOW-UP
       *
       * After a successful answer (typed or overheard) the message carries
       * topicSeed — the original question. renderBotMessage() offers a
       * follow-up ("Want to see upcoming Recast sessions on this topic?");
       * accepting it runs ONE web_search through the SAME proxy path the
       * answers use, restricted to the hostnames of slot.eventDomains, and
       * the result lands as a kind:'events' assistant message. Event data is
       * never invented client-side: an empty/unparseable reply falls back to
       * a single link to the first configured events page.
       * ================================================================ */

      // Only real answers earn the follow-up offer — not errors, not the
      // empty-reply placeholder, and not the persona's honest "I'm not sure"
      // fallback (suggesting a webinar about a question Randy couldn't answer
      // would read as deflection).
      function eventsOfferEligible(m) {
        if (!m || m.role !== 'assistant' || m.kind === 'events') return false;
        if (!m.topicSeed || m.eventsDismissed || m.eventsRequested) return false;
        const t = String(m.content || '').trim();
        if (!t) return false;
        if (t.startsWith('⚠️')) return false;
        if (/^no response\.?$/i.test(t)) return false;
        if (/\bnot sure about that\b/i.test(t.slice(0, 200))) return false;
        return true;
      }

      // The configured event pages, falling back to the defaults when the
      // Settings box is empty — same hard fallback allowedDomains uses, so a
      // wiped box can never widen the search.
      function eventPagesOf(slot) {
        const configured = ((slot && slot.eventDomains) || [])
          .filter(x => typeof x === 'string' && x.trim())
          .map(x => x.trim());
        return configured.length ? configured : DEFAULT_EVENT_DOMAINS.slice();
      }

      // allowed_domains wants bare hostnames; the Settings box holds full page
      // URLs. Strip protocol and path (string-wise, so entries without a
      // protocol survive too) and dedupe.
      function eventSearchHostnames(pages) {
        const hosts = [];
        for (const u of pages) {
          const h = String(u).trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].trim();
          if (h && !hosts.includes(h)) hosts.push(h);
        }
        // Unparseable entries must never leave allowed_domains empty (which
        // would un-restrict the search) — fall back to the defaults' hosts.
        return hosts.length ? hosts : eventSearchHostnames(DEFAULT_EVENT_DOMAINS);
      }

      // Parse the model's strict-JSON events reply defensively: tolerate stray
      // fences/prose around the array, and keep only entries with a real title
      // and an http(s) URL. Anything unparseable is simply "no events".
      function parseEventsReply(reply) {
        let t = String(reply || '').trim();
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const start = t.indexOf('[');
        const end = t.lastIndexOf(']');
        if (start === -1 || end <= start) return [];
        try {
          const arr = JSON.parse(t.slice(start, end + 1));
          if (!Array.isArray(arr)) return [];
          return arr
            .filter(e => e && typeof e === 'object')
            .map(e => ({
              title: String(e.title || '').trim(),
              description: String(e.description || '').trim(),
              url: String(e.url || '').trim()
            }))
            .filter(e => e.title && /^https?:\/\//i.test(e.url))
            .slice(0, 3);
        } catch {
          return [];
        }
      }

      const EVENTS_SEARCH_SYSTEM = [
        'You find real, currently listed Recast Software webinars, trainings, and events using web search.',
        'Reply with STRICT JSON only — a JSON array, no prose, no markdown fences, no commentary.',
        'Each element: {"title": "...", "description": "one short sentence", "url": "https://..."}.',
        'Only include sessions you actually found in the search results, with their real URLs — never invent titles, dates, or URLs.',
        'If you find nothing relevant, reply with exactly [].'
      ].join('\n');

      // One bounded search through the existing proxy (postChat) with the
      // existing tool shape — no new endpoints, keys, or permissions. Mutates
      // the already-rendered kind:'events' placeholder message in place, so a
      // "New chat" mid-search just orphans it harmlessly.
      async function fetchUpcomingEvents(slotIdx, srcMsg, eventsMsg) {
        const slot = STATE.slots[slotIdx];
        const pages = eventPagesOf(slot);
        eventsMsg.eventsFallback = pages[0];
        try {
          const tool = { type: SEARCH_TOOL, name: 'web_search', max_uses: ASSIST.SEARCH_MAX_USES, allowed_domains: eventSearchHostnames(pages) };
          const topic = String(srcMsg.topicSeed || '').slice(0, 300);
          const data = await postChat({
            model: MODELS.chat,
            max_tokens: 700,
            output_config: { effort: 'medium' },
            system: systemBlocks(EVENTS_SEARCH_SYSTEM),
            messages: [{
              role: 'user',
              content: 'Find up to 3 upcoming or relevant Recast Software webinars, trainings, or events related to this topic:\n\n"' + topic + '"\n\nPrefer sessions listed on these pages:\n' + pages.join('\n') + '\n\nReply with the strict JSON array only.'
            }],
            tools: [tool],
            save: false
          }, null);
          eventsMsg.events = parseEventsReply(data && data.reply);
        } catch (err) {
          // Any failure (offline, proxy error, timeout) degrades to the
          // fallback link — the card never blocks and never invents sessions.
          console.warn('upcoming-sessions search failed:', err);
          eventsMsg.events = [];
        }
        eventsMsg.eventsLoading = false;
        render();
        scrollChat();
      }

      function scrollChat() {
        setTimeout(() => {
          const el = document.getElementById('chat-scroll');
          if (el) el.scrollTop = el.scrollHeight;
          for (let i = 0; i < STATE.slots.length; i++) {
            const h = document.getElementById('home-scroll-' + i);
            if (h) h.scrollTop = 0;
          }
        }, 50);
      }

      function clearChat(idx) {
        if (VOICE.playingMsg && VOICE.playingMsg.slot === idx) stopSpeaking();
        STATE.slots[idx].messages = [];
        STATE.slots[idx].inputText = '';
        STATE.slots[idx].loading = false;
        render();
      }

      /* ================================================================
       * RENDER
       * ================================================================ */

      // render() rebuilds the whole DOM, which would reset every scroll
      // container to the top. Capture positions first and restore after:
      // if the user was at (or near) the bottom, stick to the bottom so the
      // newest answer stays in view; otherwise put them back where they were.
      const SCROLL_IDS = ['home-scroll-0', 'chat-scroll'];

      function captureScroll() {
        const state = {};
        for (const id of SCROLL_IDS) {
          const el = document.getElementById(id);
          if (!el) continue;
          state[id] = {
            top: el.scrollTop,
            atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 48
          };
        }
        return state;
      }

      function restoreScroll(state) {
        for (const id in state) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.scrollTop = (state[id].atBottom && id !== 'home-scroll-0')
            ? el.scrollHeight
            : Math.min(state[id].top, el.scrollHeight);
        }
      }

      // render() rebuilds #app wholesale, which drops focus from whatever field
      // the user was typing in. Background renders fire constantly during a call
      // (an overheard answer landing, a toast, a live-status refresh), so without
      // this a user typing in the composer — or searching History — loses the
      // caret every few seconds. Capture the focused input/textarea and its caret
      // before the rebuild and restore both after. Only same-page fields with a
      // stable id qualify; if nothing is focused it's a no-op.
      function captureFocus() {
        const el = document.activeElement;
        if (!el || !el.id) return null;
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return null;
        let start = null, end = null;
        try { start = el.selectionStart; end = el.selectionEnd; } catch {}
        return { id: el.id, start, end };
      }

      function restoreFocus(state) {
        if (!state) return;
        const el = document.getElementById(state.id);
        if (!el || el === document.activeElement) return;
        try {
          el.focus();
          if (state.start != null && el.setSelectionRange) {
            el.setSelectionRange(state.start, state.end);
          }
        } catch {}
      }

      // One-time onboarding screen: ask for first + last name, then hand off to
      // the normal tool. Reuses the global click/keydown handlers (the Save
      // button is data-action="save-onboarding"). The name is read straight off
      // the inputs on Save, so no per-keystroke render steals the caret.
      function renderOnboarding(root) {
        if (!IDENTITY.loaded) {
          // Identity still loading and no fast-path hint — paint a blank panel in
          // the app's own background colour (no card, no text) so the few-ms wait
          // is invisible instead of a flash of UI.
          root.innerHTML = '<div class="onb-blank"></div>';
          return;
        }
        const f = IDENTITY.userName ? escAttr(IDENTITY.userName.firstName) : '';
        const l = IDENTITY.userName ? escAttr(IDENTITY.userName.lastName) : '';
        root.innerHTML = `
          <div class="onb-wrap">
            <div class="onb-card" role="dialog" aria-label="Welcome to Randy">
              <div class="onb-logo"><i data-lucide="sparkles" class="w-6 h-6"></i></div>
              <h1 class="onb-title">Welcome to Randy</h1>
              <p class="onb-sub">Before we start, what should we call you? We only ask this once.</p>
              <label class="onb-label" for="onb-first">First name</label>
              <input id="onb-first" class="onb-input" type="text" autocomplete="given-name" placeholder="First name" value="${f}" />
              <label class="onb-label" for="onb-last">Last name</label>
              <input id="onb-last" class="onb-input" type="text" autocomplete="family-name" placeholder="Last name" value="${l}" />
              <div id="onb-error" class="onb-error" role="alert" aria-live="polite"></div>
              <button class="onb-save" data-action="save-onboarding">Save &amp; continue</button>
            </div>
          </div>`;
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
        bindEvents();
        setTimeout(() => { try { document.getElementById('onb-first')?.focus(); } catch {} }, 30);
      }

      function render() {
        const root = document.getElementById('app');
        if (!root) return;
        // Identity gate: until a name is saved for this install, the panel shows
        // ONLY the one-time onboarding screen — never the normal tool. Once a
        // name exists (this install, ever) this branch is skipped for good. The
        // synchronous hint inside shouldShowApp() keeps reloads instant.
        if (!shouldShowApp()) {
          renderOnboarding(root);
          return;
        }
        const scroll = captureScroll();
        const focus = captureFocus();
        root.innerHTML = `
          <div class="app-frame">
            ${renderSidebar()}
            <div class="sidebar-scrim ${STATE.historyOpen ? 'show' : ''}" data-action="toggle-history"></div>
            <main class="main-col" data-screen-label="${STATE.activeTab === 'settings' ? 'Settings' : (HISTORY_VIEW.open ? 'Saved conversation' : 'Chat')}">
              ${renderMain()}
            </main>
          </div>
          ${STATE.activeTab === 'settings' ? renderSettingsSheet() : ''}
          ${renderAudioChooser()}
          ${renderToast()}
        `;
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
        restoreScroll(scroll);
        restoreFocus(focus);
        bindEvents();
        if (PIP.window) renderPip();
      }

      /* ---------- voice state machine (shared by hero orb + header pill) ---------- */

      function voiceModel(slot, idx) {
        const on = !!slot.listenOn;
        const isSpeaking = !!slot.isSpeaking;
        const loading = !!slot.loading;
        const sr = VOICE.srSupported;

        if (!sr) return {
          orbClass: 'off', orbInner: '<i data-lucide="mic-off" class="w-8 h-8"></i>',
          action: 'noop', title: 'Randy needs Chrome or Edge', disabled: true, live: false,
          statusText: 'Use Chrome or Edge to talk to Randy', statusClass: 'off',
          pill: 'off', pillLabel: 'Voice needs Chrome', pillIcon: '<i data-lucide="mic-off" class="w-4 h-4"></i>'
        };
        if (isSpeaking) return {
          orbClass: 'speaking', orbInner: '<span class="sound-wave"><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span></span>',
          action: 'stop-speaking', title: 'Click to stop Randy talking', disabled: false, live: false,
          statusText: 'Talking…', statusClass: 'speaking',
          pill: 'speak', pillLabel: 'Stop talking', pillIcon: '<span class="sound-wave vp-wave"><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span></span>'
        };
        if (loading) return {
          orbClass: 'thinking', orbInner: '<span class="orb-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span>',
          action: 'cancel-reply', title: 'Click to cancel', disabled: false, live: false,
          statusText: 'Thinking…', statusClass: '',
          pill: 'think', pillLabel: 'Thinking…', pillIcon: '<i data-lucide="loader-circle" class="w-4 h-4 vp-spin"></i>'
        };
        if (on) return {
          orbClass: 'monitor', orbInner: '<i data-lucide="mic" class="w-8 h-8"></i>',
          action: 'toggle-listen', title: 'Randy is on — click to turn him off', disabled: false, live: true,
          statusText: 'Listening for questions…', statusClass: 'listening',
          pill: 'on', pillLabel: 'Listening', pillIcon: '<span class="vp-dot"></span>'
        };
        return {
          orbClass: 'off', orbInner: '<i data-lucide="mic" class="w-8 h-8"></i>',
          action: 'toggle-listen', title: 'Click to turn Randy on', disabled: false, live: false,
          statusText: 'Off — click the mic to start', statusClass: 'off',
          pill: 'go', pillLabel: 'Turn on Randy', pillIcon: '<i data-lucide="mic" class="w-4 h-4"></i>'
        };
      }

      /* ---------- sidebar ---------- */

      function renderSidebarItem(h) {
        const confirming = STATE.historyConfirmDeleteId === h.id;
        const active = HISTORY_VIEW.open === h.id;
        return `
          <div class="sb-item ${active ? 'active' : ''}${confirming ? ' confirming' : ''}" role="button" tabindex="0" data-action="${confirming ? 'noop' : 'view-history'}" data-id="${escAttr(h.id)}" title="Open saved conversation">
            <div class="sb-item-body">
              <div class="sb-item-title">${escHtml(h.preview || 'Untitled conversation')}</div>
              <div class="sb-item-meta">${escHtml(formatHistoryTime(h))}${h.pairs.length > 1 ? ' · ' + h.pairs.length + ' Q&amp;As' : ''}</div>
              ${confirming ? `
                <div class="sb-confirm">
                  <span>Delete this conversation?</span>
                  <button class="no" data-action="cancel-delete-history" data-id="${escAttr(h.id)}">Cancel</button>
                  <button class="ok" data-action="confirm-delete-history-yes" data-id="${escAttr(h.id)}">Delete</button>
                </div>
              ` : ''}
            </div>
            ${confirming ? '' : `
              <div class="sb-item-actions">
                <button data-action="load-history" data-id="${escAttr(h.id)}" title="Continue in chat" aria-label="Continue in chat">
                  <i data-lucide="message-circle-plus" class="w-3.5 h-3.5"></i>
                </button>
                <button class="danger" data-action="confirm-delete-history" data-id="${escAttr(h.id)}" title="Delete" aria-label="Delete">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            `}
          </div>`;
      }

      function renderSidebar() {
        const history = STATE.sessionHistory;
        const filtered = filterHistory(history, STATE.historyQuery);
        const slot = STATE.slots[0];
        return `
          <aside class="sidebar ${STATE.historyOpen ? 'open' : ''}" data-screen-label="Sidebar">
            <div class="sb-brand">
              <span class="sb-logo"><span class="lg-re">Re</span>cast</span>
              <span class="sb-tagline">SE Assistant</span>
              <button class="sb-close" data-action="toggle-history" title="Close menu" aria-label="Close menu">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
            <div class="sb-controls">
              <div class="sb-label">Options</div>
              <button class="sb-ctl" data-action="toggle-speak-answers" title="${slot.speakAnswers ? 'Randy reads each answer out loud' : 'Answers show in the chat only'}">
                <i data-lucide="${slot.speakAnswers ? 'volume-2' : 'volume-x'}" class="w-4 h-4"></i>
                <span class="sb-ctl-label">Read answers aloud</span>
                <span class="sb-switch ${slot.speakAnswers ? 'on' : ''}" role="switch" aria-checked="${!!slot.speakAnswers}" tabindex="0" data-action="toggle-speak-answers" aria-label="Read answers aloud"></span>
              </button>
              <button class="sb-ctl danger" data-action="clear-chat" data-idx="0" ${slot.messages.length === 0 ? 'disabled' : ''} title="Clear the current chat">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
                <span class="sb-ctl-label">Clear chat</span>
              </button>
            </div>
            <div class="sb-divider"></div>
            ${history.length > 0 ? `
              <div class="sb-search">
                <i data-lucide="search" class="sb-search-ic w-3.5 h-3.5"></i>
                <input type="text" id="history-search" placeholder="Search conversations" value="${escAttr(STATE.historyQuery)}" autocomplete="off" aria-label="Search saved conversations" />
                ${STATE.historyQuery ? `
                  <button class="sb-search-clear" data-action="clear-history-search" title="Clear search" aria-label="Clear search">
                    <i data-lucide="x" class="w-3 h-3"></i>
                  </button>
                ` : ''}
              </div>
            ` : ''}
            <div class="sb-label">Conversations</div>
            <div class="sb-list history-panel-open">
              ${history.length === 0 ? `
                <div class="sb-empty">Finished chats from this visit show up here.<br>History clears when the page closes.</div>
              ` : filtered.length === 0 ? `
                <div class="sb-empty">No conversations match &ldquo;${escHtml(truncate(STATE.historyQuery.trim(), 30))}&rdquo;.</div>
              ` : groupHistoryByBucket(filtered).map(g => `
                <div class="sb-group">
                  <div class="sb-group-head">${escHtml(g.label)}</div>
                  ${g.items.map(h => renderSidebarItem(h)).join('')}
                </div>
              `).join('')}
            </div>
          </aside>`;
      }

      /* ---------- main column ---------- */

      function renderMain() {
        if (HISTORY_VIEW.open) {
          const entry = STATE.sessionHistory.find(h => h.id === HISTORY_VIEW.open);
          if (entry) return renderSavedView(entry);
        }
        return renderChat(STATE.slots[0], 0);
      }

      function renderVoicePill(vm, idx) {
        return `
          <button class="vp ${vm.pill}" data-action="${vm.action}" data-idx="${idx}" title="${escAttr(vm.title)}" ${vm.disabled ? 'disabled' : ''}>
            ${vm.pillIcon}<span class="vp-label">${vm.pillLabel}</span>
          </button>`;
      }

      // No avatar/name/status block here: the center console orb already
      // carries Randy's identity and live listening state, so the header
      // keeps only the navigation buttons.
      function renderChatHeader(slot, idx, vm) {
        return `
          <header class="chat-head">
            <button class="icon-btn sb-toggle" data-action="toggle-history" title="Conversations" aria-label="Open conversations">
              <i data-lucide="panel-left" class="w-5 h-5"></i>
            </button>
            <div class="head-titles"></div>
            <div class="head-actions">
              <button class="icon-btn" data-action="switch-tab" data-tab="settings" title="Settings" aria-label="Settings">
                <i data-lucide="more-horizontal" class="w-5 h-5"></i>
              </button>
            </div>
          </header>`;
      }

      function renderLiveStrip(slot, idx) {
        const last = TECH.decisions[TECH.decisions.length - 1];
        const queued = TECH.questionQueue.length;
        // Near-miss: the classifier flagged a possible need but landed just
        // under the answer threshold. Surface it as a tappable "answer this?"
        // chip so the SE can force the answer with one tap.
        const nearMiss = (!last || !last.accepted)
          ? TECH.decisions.slice().reverse().find(d => !d.accepted && d.nearMiss)
          : null;
        const baseStats = TECH.answered + ' answered · ' + TECH.heard + ' heard';
        const stats = TECH.pending
          ? 'Checking a question…'
          : (queued ? queued + ' queued · ' + baseStats : baseStats);
        return `
          <div class="live-strip">
            <span class="sound-wave ls-wave" aria-hidden="true"><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span><span class="sound-wave-bar"></span></span>
            <div class="ls-body">
              <div class="ls-top">
                <span class="ls-title">Listening for tech questions</span>
                <span class="ls-stats ${TECH.pending ? 'busy' : ''}">${escHtml(stats)}</span>
              </div>
              ${DESKTOP.on ? `<div class="ls-desktop ${DESKTOP.statusText ? 'on' : ''}" id="desktop-status">${escHtml(DESKTOP.statusText)}</div>` : ''}
              <div class="ls-live ac-live ${VOICE.interimText ? 'hearing' : ''}" id="live-transcript">
                <span class="ls-live-text"><span id="live-transcript-text">${escHtml(VOICE.interimText || '')}</span><span class="interim-caret">▊</span></span>
              </div>
              ${nearMiss ? `
                <button class="ls-nearmiss" data-action="force-answer" data-text="${escAttr(nearMiss.text)}" title="Randy skipped this — tap to answer it anyway">
                  <i data-lucide="help-circle" class="w-3 h-3"></i>
                  <span>${escHtml(truncate(nearMiss.text, 70))} · answer this?</span>
                </button>
              ` : (last ? `
                <div class="ls-last">
                  <i data-lucide="${last.accepted ? 'check' : 'minus'}" class="w-3 h-3 ${last.accepted ? 'ok' : 'skip'}"></i>
                  <span>${escHtml(truncate(last.text, 90))} · ${Math.round((last.confidence || 0) * 100)}%</span>
                </div>
              ` : '')}
            </div>
            <div class="ls-controls">
              <label class="ls-speak" title="${slot.speakAnswers ? 'Randy reads each answer out loud' : 'Answers show in the chat only'}">
                <span>Read aloud</span>
                <span class="voice-switch ${slot.speakAnswers ? 'on' : ''}" role="switch" aria-checked="${!!slot.speakAnswers}" tabindex="0" data-action="toggle-speak-answers"></span>
              </label>
              <button class="ls-off" data-action="toggle-listen" title="Turn Randy off">Turn off</button>
            </div>
          </div>`;
      }

      // What is Randy doing right now? One model drives the console's orb label,
      // stage badge, and the big live text — mirrors pipLiveModel so the main
      // stage and the pop-out never disagree.
      function consoleModel(slot, vm) {
        if (!VOICE.srSupported) return { stageKey: 'off', orbLabel: 'Unavailable', icon: 'mic-off', label: 'Voice needs Chrome or Edge', sub: 'You can still type your questions below', mode: 'prompt', text: 'Randy listens through the browser\u2019s speech engine, which runs in Chrome or Edge. Type to him here anytime.' };
        if (slot.isSpeaking) return { stageKey: 'speaking', orbLabel: 'Talking', icon: 'volume-2', label: 'Randy is talking', sub: 'Reading the answer aloud — tap the orb to stop', mode: 'prompt', text: '' };
        // No loading branch: while an answer is generating, the thread shows a
        // compact inline "Writing…" pill (see renderBotMessage) instead of the
        // old full-width "Writing the answer" stage, and the orb (voiceModel)
        // already carries the thinking dots + cancel. The console falls through
        // to whatever is still true — listening if the mic is on, off otherwise.
        if (TECH.pending) return { stageKey: 'analyzing', orbLabel: 'Analyzing', icon: 'scan-search', label: 'Analyzing the question', sub: 'Deciding whether this needs an answer', mode: 'question', text: TECH.activeText || VOICE.interimText || '' };
        if (slot.listenOn) return { stageKey: 'listening', orbLabel: 'Listening', icon: 'ear', label: 'Listening for questions', sub: 'Randy is on the call — speak naturally', mode: 'transcript', text: VOICE.interimText || '' };
        return { stageKey: 'off', orbLabel: 'Off', icon: 'mic', label: 'Randy is off', sub: 'Tap the mic to start listening', mode: 'prompt', text: 'Turn Randy on and he listens to your call, spots the technical questions, and answers them right here — or just type below anytime.' };
      }

      // The main stage: status title, the mic (on/off), and live voice-to-text.
      function renderConsole(slot, idx, vm) {
        const cm = consoleModel(slot, vm);

        // The live transcript node carries the patchable id ONLY while Randy is
        // actively hearing the call (listening / speaking), so the in-place
        // interim patch never clobbers the settled question shown mid-analysis.
        const liveNode = slot.listenOn && (cm.stageKey === 'listening' || cm.stageKey === 'speaking');
        let body;
        if (liveNode) {
          const caret = cm.stageKey === 'listening' ? '<span class="interim-caret">▊</span>' : '';
          body = `<div class="cl-transcript ac-live ${VOICE.interimText ? 'hearing' : ''}" id="live-transcript"><span id="live-transcript-text">${escHtml(VOICE.interimText || '')}</span>${caret}</div>`;
        } else if (cm.mode === 'question') {
          body = cm.text ? `<div class="cl-transcript">${escHtml(cm.text)}</div>` : `<div class="cl-transcript cl-tr-muted">Working on it…</div>`;
        } else {
          body = `<div class="cl-transcript cl-tr-muted">Tap the mic to start listening</div>`;
        }

        return `
          <div class="console stage-${cm.stageKey}">
            <div class="console-inner">
              <div class="cl-status">${escHtml(cm.label)}</div>
              <div class="console-orb">
                <div class="orb-wrap ${vm.live ? 'live' : ''}">
                  <span class="orb-ring"></span>
                  <span class="orb-ring d"></span>
                  <button class="voice-orb ${vm.orbClass}" title="${escAttr(vm.title)}" aria-label="${escAttr(vm.title)}" data-action="${vm.action}" data-idx="${idx}" ${vm.disabled ? 'disabled' : ''}>
                    ${vm.orbInner}
                  </button>
                </div>
              </div>
              ${body}
              ${DESKTOP.on ? `<div class="cl-desktop ${DESKTOP.statusText ? 'on' : ''}" id="desktop-status">${escHtml(DESKTOP.statusText)}</div>` : ''}
            </div>
          </div>`;
      }

      function renderHomeEmpty(slot) {
        // The empty home view is intentionally blank — the listening card above
        // carries the messaging, so no "Hey, I'm Randy" hero/description here.
        return '';
      }

      function renderChat(slot, idx) {
        const vm = voiceModel(slot, idx);
        const hasMsgs = slot.messages.length > 0;
        // While loading, the trailing assistant message IS the in-flight answer
        // and already renders as a single "R" row — the compact "Writing…"
        // pill while it's empty, then the streaming answer card (see
        // renderBotMessage). So it carries the working indicator on its own.
        // Only fall back to a standalone pill row if, somehow, there's no
        // trailing assistant message to host it, so the indicator is never
        // doubled (the old "two Randys") nor lost.
        const lastMsg = slot.messages[slot.messages.length - 1];
        const placeholderPending = !!(lastMsg && lastMsg.role === 'assistant');
        return `
          ${renderChatHeader(slot, idx, vm)}
          <div class="split-row">
            <div class="top-stage">
              ${renderConsole(slot, idx, vm)}
            </div>
            <div class="right-col">
              <div id="home-scroll-${idx}" class="msg-scroll">
                <div class="msg-col">
                  ${hasMsgs ? slot.messages.map((m, mi) => `
                    <div class="msg-row ${m.role === 'user' ? 'me' : ''}">
                      ${m.role === 'user' ? renderUserMessage(m) : renderBotMessage(slot, m, mi, idx)}
                    </div>
                  `).join('') + (slot.loading && !placeholderPending ? `
                    <div class="msg-row">
                      <div class="msg-av">${escHtml(slot.label.charAt(0))}</div>
                      ${typingPillHtml()}
                    </div>
                  ` : '') : renderHomeEmpty(slot)}
                </div>
              </div>
              <div class="composer-zone">
                <div class="composer">
                  <button class="comp-newchat" data-action="new-chat" aria-label="New chat" title="Start a new chat — the current one is saved in the menu">
                    <i data-lucide="square-pen" class="w-5 h-5"></i>
                  </button>
                  <textarea id="home-input-${idx}" class="composer-input" rows="1" placeholder="Message ${escAttr(slot.label)}…" ${slot.loading ? 'disabled' : ''}>${escHtml(slot.inputText || '')}</textarea>
                  <button class="comp-capture${SELECTION_CAPTURE.armed ? ' armed' : ''}" data-action="ask-selection" data-idx="${idx}" aria-label="${SELECTION_CAPTURE.armed ? 'Capturing highlights — click to stop' : 'Ask about highlighted text'}" aria-pressed="${SELECTION_CAPTURE.armed}" title="${SELECTION_CAPTURE.armed ? 'Capturing — highlight text on the page and it goes to Randy. Click to stop.' : 'Click, then highlight text on the page — it goes straight to Randy.'}">
                    <i data-lucide="highlighter" class="w-5 h-5"></i>
                  </button>
                  ${VOICE.srSupported ? `<button class="comp-mic${isHomeDictating(idx) ? ' live' : ''}" data-action="dictate-home" data-idx="${idx}" title="${isHomeDictating(idx) ? 'Stop voice typing' : 'Voice to text — speak your message'}" aria-label="Voice to text" aria-pressed="${isHomeDictating(idx)}" ${slot.loading ? 'disabled' : ''}>
                    <i data-lucide="${isHomeDictating(idx) ? 'square' : 'mic'}" class="w-5 h-5"></i>
                  </button>` : ''}
                  <button class="comp-send" data-action="send-home" data-idx="${idx}" title="Send message" aria-label="Send message" ${(slot.loading || !(slot.inputText || '').trim()) ? 'disabled' : ''}>
                    <i data-lucide="arrow-up" class="w-5 h-5"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>`;
      }

      /* ---------- message rendering ---------- */

      function renderBotMessage(slot, m, mi, slotIdx) {
        const av = `<div class="msg-av">${escHtml(slot.label.charAt(0))}</div>`;
        // Upcoming-sessions card (the accepted follow-up). Branch before the
        // no-content check below — these messages keep content empty so they
        // never enter the model context or History pairs.
        if (m.kind === 'events') return av + renderEventsBody(m);
        // Clarify prompt (typed ambiguity check): a quick question with
        // tappable product options — not an answer, so no copy/TTS buttons
        // and no events offer. Branch before the answer path below.
        if (m.kind === 'clarify') return av + renderClarifyBody(m, mi, slotIdx);
        // While the answer is still arriving the placeholder has no content
        // yet: a compact "Writing…" pill holds the spot next to the single "R"
        // avatar, then the answer card replaces it as soon as tokens stream in.
        if (!m.content) return `${av}
          ${typingPillHtml()}`;
        // One follow-up offer per answer, under the card. dismiss-events and
        // show-events both flag the message, so it can never stack or reappear.
        const offer = eventsOfferEligible(m) ? `
          <div class="events-offer">
            <span>Want to see upcoming Recast sessions on this topic?</span>
            <button data-action="show-events" data-slot="${slotIdx}" data-msg="${mi}"><i data-lucide="calendar" class="w-3 h-3"></i>Yes, show sessions</button>
            <button class="ghost" data-action="dismiss-events" data-slot="${slotIdx}" data-msg="${mi}">No thanks</button>
          </div>` : '';
        return `${av}
          <div class="msg-wrap ans-wrap">${renderAnswerCard(slot, m, mi, slotIdx)}${offer}</div>`;
      }

      // Compact inline generating indicator: avatar-adjacent pill with three
      // bouncing dots. Replaces the old full-width "Writing the answer" stage.
      function typingPillHtml() {
        return `<div class="typing-pill" role="status" aria-live="polite" aria-label="Randy is writing">
            <span class="tp-dot"></span><span class="tp-dot"></span><span class="tp-dot"></span>
            <span class="tp-text">Writing…</span>
          </div>`;
      }

      // One Randy answer as a structured card with four stacked zones:
      // TL;DR strip, detail bullets, sources row, action footer. One render
      // path for every answer — typed or overheard — so format and sources are
      // identical; the "Technical assist" tag in the TL;DR head is the only
      // thing unique to overheard questions.
      function renderAnswerCard(slot, m, mi, slotIdx) {
        const parts = splitAnswerParts(m.content);
        const srcs = Array.isArray(m.sources) ? m.sources : [];
        const streaming = !!slot.loading && mi === slot.messages.length - 1;
        const badge = m.kind === 'assist'
          ? `<span class="ans-assist"><i data-lucide="ear" class="w-3 h-3"></i>Technical assist</span>`
          : '';
        const tldr = `
          <div class="ans-tldr">
            <div class="ans-tldr-head"><span class="ans-eyebrow">Short answer</span>${badge}</div>
            <div class="ans-tldr-text">${mdInline(escHtml(parts.short))}</div>
          </div>`;
        const sources = srcs.length ? `
          <div class="ans-sources">
            <span class="ans-eyebrow ans-src-label">Sources</span>
            ${srcs.map(u => `<a class="ans-src-chip" href="${escAttr(safeHref(u))}" target="_blank" rel="noopener noreferrer" title="${escAttr(u)}">
              <i data-lucide="book-open"></i><span>${escHtml(sourceLabelOf(u))}</span>
            </a>`).join('')}
          </div>` : '';
        const playing = !!(VOICE.playingMsg && VOICE.playingMsg.slot === slotIdx && VOICE.playingMsg.msg === mi);
        const readBtn = VOICE.ttsSupported
          ? `<button class="ans-act${playing ? ' playing' : ''}" data-action="tts-speak" data-slot="${slotIdx}" data-msg="${mi}" title="${playing ? 'Stop reading' : 'Read answer aloud'}" aria-label="Read answer aloud"><i data-lucide="${playing ? 'volume-x' : 'volume-2'}"></i></button>`
          : '';
        const foot = `
          <div class="ans-foot">
            ${readBtn}
            <button class="ans-act" data-action="copy-msg" data-slot="${slotIdx}" data-msg="${mi}" title="Copy answer" aria-label="Copy answer"><i data-lucide="copy"></i></button>
          </div>`;
        return `<div class="answer-card">${tldr}${renderAnswerDetail(parts.detail, m, mi, slotIdx, streaming)}${sources}${foot}</div>`;
      }

      // Detail zone: the bullets under the TL;DR. Long answers collapse past
      // ~5 items behind "Show more" — but never while the answer is still
      // streaming, so incoming text can't vanish into a collapsed zone, and
      // never for a single trailing line that wouldn't be worth a click.
      function renderAnswerDetail(detail, m, mi, slotIdx, streaming) {
        if (!detail) return '';
        const lines = String(detail).split('\n').filter(l => l.trim());
        const CAP = 5;
        const collapsed = !streaming && !m.detailExpanded && lines.length > CAP + 1;
        const shown = collapsed ? lines.slice(0, CAP) : lines;
        const more = collapsed
          ? `<button class="ans-more" data-action="expand-msg" data-slot="${slotIdx}" data-msg="${mi}">Show more</button>`
          : '';
        return `<div class="ans-detail">${mdToHtml(shown.join('\n'))}${more}</div>`;
      }

      // Body of a kind:'events' message: loading line → compact session list
      // (one line each: icon, one-sentence description, title as the link) →
      // or the honest fallback link to the configured webinars page. Only
      // parsed search results are ever shown — nothing is invented here.
      function renderEventsBody(m) {
        if (m.eventsLoading) {
          return `<div class="msg-wrap"><div class="chat-bubble chat-bot" style="white-space:normal">
              <div class="events-loading"><i data-lucide="calendar-search" class="w-3.5 h-3.5"></i>Looking for sessions…</div>
            </div></div>`;
        }
        const list = Array.isArray(m.events) ? m.events : [];
        if (!list.length) {
          const fb = m.eventsFallback || DEFAULT_EVENT_DOMAINS[0];
          return `<div class="msg-wrap"><div class="chat-bubble chat-bot" style="white-space:normal">
              I couldn't find a specific upcoming session on that right now — here's the full webinars page:
              <div class="src-chips">
                <a href="${escAttr(safeHref(fb))}" target="_blank" rel="noopener noreferrer" title="${escAttr(fb)}">
                  <i data-lucide="calendar" class="w-3 h-3"></i>${escHtml(sourceLabelOf(fb))}
                </a>
              </div>
            </div></div>`;
        }
        return `<div class="msg-wrap"><div class="chat-bubble chat-bot events-card" style="white-space:normal">
            <div class="events-head"><i data-lucide="calendar" class="w-3.5 h-3.5"></i>Upcoming Recast sessions</div>
            ${list.map(ev => `
              <div class="event-row">
                <i data-lucide="graduation-cap" class="w-3.5 h-3.5"></i>
                <span>${escHtml(ev.description || '')} <a href="${escAttr(safeHref(ev.url))}" target="_blank" rel="noopener noreferrer" title="${escAttr(ev.url)}">${escHtml(ev.title)}</a></span>
              </div>`).join('')}
          </div></div>`;
      }

      // Body of a kind:'clarify' message: one short question, the real
      // product/component options as tappable pills (data-action wired into
      // the central click switch — Manifest V3 forbids inline handlers), and
      // a hint that typing a reply works too. The help-circle icon keeps it
      // reading as a quick question rather than an answer.
      function renderClarifyBody(m, mi, slotIdx) {
        const opts = Array.isArray(m.clarifyOptions) ? m.clarifyOptions : [];
        return `<div class="msg-wrap"><div class="chat-bubble chat-bot" style="white-space:normal">
            <div class="clarify-line"><i data-lucide="help-circle" class="w-3.5 h-3.5"></i><span>${escHtml(m.clarifyQuestion || 'Quick check — which product do you mean?')}</span></div>
            ${opts.length ? `<div class="clarify-options">${opts.map(o => `
              <button data-action="clarify-pick" data-slot="${slotIdx}" data-msg="${mi}" data-option="${escAttr(o)}">${escHtml(o)}</button>`).join('')}</div>` : ''}
            <div class="clarify-hint">Tap one, or just type your answer below.</div>
          </div></div>`;
      }

      function renderUserMessage(m) {
        const badge = m.kind === 'assist-q'
          ? '<span style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.75;margin-bottom:4px"><i data-lucide="ear" class="w-3 h-3"></i>Overheard</span><br>'
          : '';
        return `<div class="chat-bubble chat-user">${badge}${escHtml(m.content)}</div>`;
      }

      /* ---------- saved conversation (read-only, opens in place) ---------- */

      function renderSavedView(entry) {
        const confirming = STATE.historyConfirmDeleteId === entry.id;
        const pairCount = entry.pairs.length;
        return `
          <div class="saved-view history-popout">
            <header class="chat-head">
              <button class="icon-btn sb-toggle" data-action="toggle-history" title="Conversations" aria-label="Open conversations">
                <i data-lucide="panel-left" class="w-5 h-5"></i>
              </button>
              <button class="icon-btn" data-action="close-history" title="Back to current chat" aria-label="Back to current chat">
                <i data-lucide="arrow-left" class="w-5 h-5"></i>
              </button>
              <div class="head-titles">
                <div class="conv-title">${escHtml(entry.preview || 'Saved conversation')}</div>
                <div class="conv-sub">Saved · ${escHtml(formatHistoryDate(entry))} · ${pairCount === 1 ? '1 Q&amp;A' : pairCount + ' Q&amp;As'}</div>
              </div>
              <div class="head-actions">
                ${confirming ? `
                  <span class="confirm-label">Delete this conversation?</span>
                  <button class="btn-ghost" data-action="cancel-delete-history" data-id="${escAttr(entry.id)}">Cancel</button>
                  <button class="btn-danger-solid" data-action="confirm-delete-history-popout" data-id="${escAttr(entry.id)}">Delete</button>
                ` : `
                  <button class="btn-primary" style="min-height:40px;padding:8px 18px" data-action="load-history" data-id="${escAttr(entry.id)}">
                    <i data-lucide="message-circle-plus" class="w-4 h-4"></i>Continue in chat
                  </button>
                  <button class="icon-btn danger" data-action="confirm-delete-history" data-id="${escAttr(entry.id)}" title="Delete conversation" aria-label="Delete conversation">
                    <i data-lucide="trash-2" class="w-5 h-5"></i>
                  </button>
                `}
              </div>
            </header>
            <div class="msg-scroll">
              <div class="msg-col">
                <div class="saved-note"><i data-lucide="archive" class="w-3.5 h-3.5"></i>Read-only copy — use &ldquo;Continue in chat&rdquo; to pick it back up</div>
                ${entry.pairs.map((p, i) => `
                  <div class="msg-row me"><div class="chat-bubble chat-user">${escHtml(p.question)}</div></div>
                  <div class="msg-row">
                    <div class="msg-av">R</div>
                    <div class="popout-answer">
                      <div class="chat-bubble chat-bot chat-md" style="white-space:normal">${mdToHtml(p.answer)}</div>
                      <button class="popout-copy" data-action="copy-answer" data-id="${escAttr(entry.id)}" data-pair="${i}" title="Copy answer" aria-label="Copy answer">
                        <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>`;
      }

      /* ---------- settings shell ---------- */

      function renderSettingsSheet() {
        return `
          <div class="sheet-scrim" data-action="close-settings-bg">
            <div class="sheet" role="dialog" aria-label="Settings">
              <div class="sheet-grab"></div>
              <div class="sheet-head">
                <div class="sheet-title">Settings</div>
                <button class="sheet-x" data-action="switch-tab" data-tab="home" title="Close" aria-label="Close"><i data-lucide="x" class="w-5 h-5"></i></button>
              </div>
              <div class="sheet-body">${renderSettings()}</div>
            </div>
          </div>`;
      }

      function renderSettingsShell() {
        return `
          <header class="chat-head">
            <button class="icon-btn sb-toggle" data-action="toggle-history" title="Conversations" aria-label="Open conversations">
              <i data-lucide="panel-left" class="w-5 h-5"></i>
            </button>
            <button class="icon-btn" data-action="switch-tab" data-tab="home" title="Back to chat" aria-label="Back to chat">
              <i data-lucide="arrow-left" class="w-5 h-5"></i>
            </button>
            <div class="head-titles">
              <div class="conv-title">Settings</div>
              <div class="conv-sub">Listening, persona, research domains &amp; voice</div>
            </div>
          </header>
          <div class="settings-scroll">
            <div class="settings-col">${renderSettings()}</div>
          </div>`;
      }

      // Single source of truth for the chooser's per-mode copy, reused by the
      // rendered card and the screen-reader announcement so they never drift.
      function audioModeInfo(mode) {
        return mode === 'one-way'
          ? { label: 'One-way audio', icon: 'mic', sub: 'Microphone only', line: "This will only pick up what you're saying and not what anyone else is saying." }
          : { label: 'Two-way audio', icon: 'volume-2', sub: 'Microphone + computer audio', line: 'This will pick up your audio and whatever audio is on your computer.' };
      }

      // "How should Randy listen?" — shown after the user asks to turn Randy
      // on (see toggleListening → openAudioChooser). The slider picks the
      // capture mode; the confirm button's click is the user gesture that
      // startListening() needs for the mic / screen-share prompts.
      function renderAudioChooser() {
        if (!STATE.audioChooserOpen) return '';
        const oneWay = STATE.slots[0].audioMode === 'one-way';
        const desc = audioModeInfo(oneWay ? 'one-way' : 'two-way');
        return `
          <div class="ac-scrim" data-action="close-audio-chooser-bg">
            <div class="ac-modal" role="dialog" aria-modal="true" aria-label="How should Randy listen?" aria-describedby="ac-desc-text" tabindex="-1">
              <button class="ac-x" data-action="close-audio-chooser" title="Cancel" aria-label="Cancel"><i data-lucide="x" class="w-4 h-4"></i></button>
              <div class="ac-title">How should Randy listen?</div>
              <p class="ac-sub">Choose how Randy captures audio while he's on.</p>
              <div class="ac-seg ${oneWay ? 'left' : 'right'}" role="tablist" aria-label="Audio mode">
                <span class="ac-seg-thumb" aria-hidden="true"></span>
                <button class="ac-seg-opt ${oneWay ? 'on' : ''}" role="tab" aria-selected="${oneWay}" data-action="set-audio-mode" data-mode="one-way">One-way audio</button>
                <button class="ac-seg-opt ${oneWay ? '' : 'on'}" role="tab" aria-selected="${!oneWay}" data-action="set-audio-mode" data-mode="two-way">Two-way audio</button>
              </div>
              <div class="ac-desc">
                <div class="ac-desc-ic"><i data-lucide="${desc.icon}" class="w-5 h-5"></i></div>
                <div class="ac-desc-body" id="ac-desc-text">
                  <div class="ac-desc-sub">${desc.sub}</div>
                  <p class="ac-desc-line">${desc.line}</p>
                </div>
              </div>
              <button class="ac-go" data-action="confirm-audio-mode">
                <i data-lucide="mic" class="w-4 h-4"></i>Turn on Randy
              </button>
            </div>
          </div>`;
      }

      function renderToast() {
        if (!VOICE.toastMessage) return '';
        return `<div class="voice-toast">${escHtml(VOICE.toastMessage)}</div>`;
      }

      /* ---------- settings ---------- */

      function renderSettings() {
        const es = STATE.editingSlot;
        const slot = STATE.slots[es];
        const mode = slot.audioMode === 'two-way' ? 'two-way' : 'one-way';
        return `
          <div class="space-y-4">
            <div class="settings-section settings-grid">
              <div class="full flex items-center gap-3">
                <div class="w-9 h-9 rounded-full grid place-items-center text-white font-bold" style="background:var(--primary)">${escHtml(slot.label.charAt(0))}</div>
                <h3 class="text-lg font-semibold" style="color:var(--navy)">${escHtml(slot.label)} — Configuration</h3>
              </div>

              <div class="full set-listen">
                <div class="set-h"><i data-lucide="headphones" class="w-4 h-4"></i>How Randy listens</div>
                <div class="seg2 ${mode === 'two-way' ? 'right' : 'left'}">
                  <span class="seg2-thumb"></span>
                  <button class="seg2-opt ${mode === 'one-way' ? 'on' : ''}" data-action="pick-audio-mode" data-mode="one-way"><i data-lucide="mic" class="w-3.5 h-3.5"></i>One-way</button>
                  <button class="seg2-opt ${mode === 'two-way' ? 'on' : ''}" data-action="pick-audio-mode" data-mode="two-way"><i data-lucide="volume-2" class="w-3.5 h-3.5"></i>Two-way</button>
                </div>
                <p class="set-note">${mode === 'two-way'
                  ? 'Mic <strong>plus your computer&rsquo;s audio</strong> &mdash; the way to have Randy hear the other side of the call on <strong>headphones</strong>. A screen-share prompt appears; ' + osShareAudioHint() + '. When the capture succeeds you&rsquo;ll see &ldquo;Computer audio connected&rdquo; below.'
                  : 'Your <strong>microphone only</strong> &mdash; just what you say, not the call audio on your speakers. Best when you&rsquo;re on <strong>speakers</strong> and only want your own voice picked up.'}</p>
                ${mode === 'two-way' ? `
                  <button class="set-share" data-action="share-computer-audio"><i data-lucide="monitor-speaker" class="w-4 h-4"></i>${DESKTOP.on ? 'Re-share computer audio&hellip;' : 'Share computer audio&hellip;'}</button>
                  ${DESKTOP.on ? `<div class="set-ok"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>Computer audio connected</div>` : ''}
                ` : ''}
                <div class="set-row">
                  <div class="set-row-txt">
                    <div class="set-row-t">Read answers aloud</div>
                    <div class="set-row-s">Randy speaks each answer in a natural voice</div>
                  </div>
                  <span class="voice-switch ${slot.speakAnswers ? 'on' : ''}" role="switch" aria-checked="${!!slot.speakAnswers}" tabindex="0" data-action="toggle-speak-answers"></span>
                </div>
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Display Name</label>
                <input type="text" id="setting-label" value="${escAttr(slot.label)}" placeholder="Assistant name..." />
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="table" class="w-3 h-3 inline mr-1"></i>Answer Service
                </label>
                <div class="flex items-center gap-2 text-[11px] font-medium">
                  ${PROXY.ready
                    ? (PROXY.hasKey
                        ? `<span style="color:#0F7A3F"><i data-lucide="check-circle-2" class="w-3 h-3 inline mr-1"></i>Connected</span>`
                        : `<span style="color:#b45309"><i data-lucide="alert-triangle" class="w-3 h-3 inline mr-1"></i>Reachable but no Anthropic key — add it to the Config tab</span>`)
                    : `<span style="color:#dc2626"><i data-lucide="x-circle" class="w-3 h-3 inline mr-1"></i>Not reachable${PROXY.error ? ' (' + escHtml(PROXY.error) + ')' : ''}</span>`}
                </div>
                <p class="text-[11px] text-slate-400 mt-1">
                  Randy's answer service is built in — nothing to configure here.
                </p>
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="file-text" class="w-3 h-3 inline mr-1"></i>Randy's Persona (system prompt core)
                </label>
                <textarea id="setting-prompt" rows="8" placeholder="You are Randy, a solution engineer...">${escHtml(slot.prompt)}</textarea>
                <p class="text-[11px] text-slate-400 mt-1">Defines who Randy is. Formatting rules for chat replies and technical-assist answers are appended automatically and are not editable here.</p>
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="globe" class="w-3 h-3 inline mr-1"></i>Research Domains (technical assistance)
                </label>
                <textarea id="setting-domains" rows="4" placeholder="docs.recastsoftware.com&#10;docs.liquit.com">${escHtml((slot.allowedDomains || []).join('\n'))}</textarea>
                <p class="text-[11px] text-slate-400 mt-1">One domain per line. Technical-assist answers research only these sites (support docs). Leave empty to allow the whole web.</p>
              </div>

              <div class="full">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  <i data-lucide="calendar" class="w-3 h-3 inline mr-1"></i>Event &amp; Webinar Sites (for follow-up suggestions)
                </label>
                <textarea id="setting-event-domains" rows="3" placeholder="https://www.recastsoftware.com/resources/webinars-trainings/&#10;https://www.recastsoftware.com/events-tradeshows-user-groups/">${escHtml((slot.eventDomains || []).join('\n'))}</textarea>
                <p class="text-[11px] text-slate-400 mt-1">One web address per line. When you accept a follow-up, Randy looks here for upcoming sessions. Add other event sites here anytime.</p>
              </div>

              <div class="full" style="border-top:1px dashed #e2e8f0;padding-top:16px">
                <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                  <i data-lucide="mic" class="w-3 h-3 inline mr-1"></i>Voice${VOICE.srSupported ? '' : ' — needs Chrome or Edge'}
                </label>

                ${VOICE.srSupported ? `
                  <div style="margin-bottom:16px">
                    <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Microphone</label>
                    <select id="setting-mic" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:14px">
                      <option value=""${MIC.deviceId ? '' : ' selected'}>System default microphone (recommended)</option>
                      ${MIC.devices
                        .filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
                        .map((d, i) => `<option value="${escAttr(d.deviceId)}"${MIC.deviceId === d.deviceId ? ' selected' : ''}>${escHtml(d.label || ('Microphone ' + (i + 1)))}</option>`)
                        .join('')}
                    </select>
                    <p class="text-[11px] text-slate-400 mt-1">The microphone Randy opens when he listens. If the default device isn&rsquo;t picking you up, switch here.</p>
                    <p class="text-[11px] text-slate-400 mt-1"><strong>Important:</strong> Chrome&rsquo;s live transcription always listens to your computer&rsquo;s <strong>default</strong> microphone &mdash; it can&rsquo;t be pointed at a specific device from here. To make Randy hear a particular mic, set it as your default input in <strong>${escHtml(osDefaultMicPath())}</strong>.</p>
                    ${MIC.deviceId ? `<div class="text-[11px] mt-2" style="color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px"><i data-lucide="alert-triangle" class="w-3 h-3 inline mr-1"></i>You&rsquo;ve pinned a specific microphone. Randy will capture it for keep-alive, but live transcription still follows your OS default input &mdash; set the same device as default in <strong>${escHtml(osDefaultMicPath())}</strong> so what Randy hears matches your choice.</div>` : ''}
                    <div class="flex flex-wrap items-center gap-2" style="margin-top:8px">
                      <button class="btn-outline" style="font-size:11px;padding:5px 12px" data-action="refresh-mics">
                        <i data-lucide="refresh-cw" class="w-3 h-3 inline mr-1"></i> Refresh device list
                      </button>
                      <button class="btn-outline" style="font-size:11px;padding:5px 12px" data-action="${MICTEST.active ? 'stop-mic-test' : 'test-mic'}">
                        <i data-lucide="${MICTEST.active ? 'square' : 'activity'}" class="w-3 h-3 inline mr-1"></i> ${MICTEST.active ? 'Stop test' : 'Test microphone'}
                      </button>
                    </div>
                    ${MICTEST.active ? `
                      <div style="margin-top:10px">
                        <div style="height:10px;background:#e2e8f0;border-radius:999px;overflow:hidden">
                          <div id="mic-test-bar" style="height:100%;width:0%;background:#cbd5e1;border-radius:999px;transition:width .05s linear"></div>
                        </div>
                        <p id="mic-test-status" class="text-[11px] mt-1" style="color:#64748b">Listening… speak now and watch the bar move.</p>
                      </div>
                    ` : ''}
                    ${osDefaultMicLabel() ? `<p class="text-[11px] text-slate-400 mt-2">Your computer&rsquo;s current default input &mdash; what Chrome actually transcribes &mdash; is <strong>${escHtml(osDefaultMicLabel())}</strong>.</p>` : ''}
                  </div>
                ` : ''}

                ${VOICE.ttsSupported ? `
                  <div>
                    <label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Speaking Voice <span class="text-slate-400 normal-case">(pick one, or let Randy choose the most natural)</span></label>
                    <select id="setting-voice-list" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:14px">
                      ${(() => {
                        const picked = pickDeepVoice();
                        const auto = TTS.chosenName === '';
                        const head = `<option value=""${auto ? ' selected' : ''}>Automatic${picked ? ' — currently ' + escHtml(picked.name) : ''} (recommended)</option>`;
                        const opts = (window.speechSynthesis.getVoices() || [])
                          .filter(v => /^en(-|_|$)/i.test(v.lang))
                          .map(v => `<option value="${escAttr(v.name)}"${TTS.chosenName === v.name ? ' selected' : ''}>${escHtml(v.name)} — ${escHtml(v.lang)}</option>`)
                          .join('');
                        return head + (opts || '<option value="" disabled>(voices will load after first click)</option>');
                      })()}
                    </select>
                    <p class="text-[11px] text-slate-400 mt-1">Voices come from your operating system and browser. &ldquo;Natural&rdquo;, &ldquo;Neural&rdquo; or Google voices sound the most human. Your choice is remembered; if it&rsquo;s ever uninstalled Randy falls back to the automatic pick.</p>
                    <button class="btn-outline" style="font-size:11px;padding:5px 12px;margin-top:8px" data-action="preview-voice" data-idx="${es}">
                      <i data-lucide="play" class="w-3 h-3 inline mr-1"></i> Preview Voice
                    </button>
                  </div>
                ` : ''}
              </div>

              <div class="full flex flex-wrap gap-2 pt-1">
                <button class="btn-primary" data-action="save-settings">
                  <i data-lucide="save" class="w-4 h-4 inline mr-1"></i> Save Configuration
                </button>
                <button class="btn-outline" data-action="reset-slot" data-idx="${es}">
                  <i data-lucide="rotate-ccw" class="w-4 h-4 inline mr-1"></i> Reset Defaults
                </button>
                <button class="btn-danger" data-action="clear-chat" data-idx="${es}">
                  <i data-lucide="trash-2" class="w-4 h-4 inline mr-1"></i> Clear Chat History
                </button>
              </div>
            </div>
          </div>`;
      }

      /* ================================================================
       * POP-OUT CHAT (Document Picture-in-Picture, Chrome 116+)
       *
       * A compact always-on-top chat window that stays visible while the
       * user works in other tabs/apps. All voice code (recognition and
       * TTS) keeps running in THIS tab — the pop-out is a dumb view
       * over STATE.slots[PIP.slotIdx], refreshed by renderPip() at the end
       * of every render(). It has its own document, so the main page's
       * Tailwind classes and delegated listeners don't reach it: it gets a
       * self-contained stylesheet and listeners bound to its own document.
       *
       * Two modes: the full chat, and a collapsed "listening" icon docked
       * in the bottom-right corner of the screen. PiP windows can't be
       * moved programmatically, so the dock works the only way Chrome
       * allows: minimize/expand close the current window and request a
       * fresh one with preferInitialWindowPlacement, which Chrome places
       * at its default spot — the bottom-right corner of the work area.
       * requestWindow() needs transient user activation on this (main)
       * window; clicks inside the PiP window propagate activation here,
       * so the swap works for real clicks, and falls back to reshaping
       * the current window in place when no activation exists.
       *
       * When a question arrives while collapsed, the code immediately
       * tries to bring the chat back so the answer lands in view. With no
       * gesture anywhere Chrome refuses, and the icon runs a status
       * sequence instead — thinking dots while answering, then a glowing
       * badge — and one click anywhere on it reopens the full chat with
       * the newest answer highlighted.
       * ================================================================ */

      const PIP_CSS = `
        :root { --primary:#0372FF; --primary-hover:#0262DB; --navy:#1F289C; --cyan:#31D1FF; --dark:#161F5B; --divider:#DCE2EC; --row:#F5F7FB; --quote:#F0F6FF; }
        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body { margin: 0; display: flex; flex-direction: column; background: var(--row); color: var(--dark); font-family: 'DM Sans', system-ui, sans-serif; }
        .pip-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--navy); color: #fff; flex-shrink: 0; }
        .pip-avatar { position: relative; width: 30px; height: 30px; border-radius: 50%; background: var(--primary); display: grid; place-items: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
        .pip-dot { position: absolute; bottom: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; border: 2px solid var(--navy); }
        .pip-dot.live { background: #10b981; animation: pipPulse 2.2s ease-out infinite; }
        @keyframes pipPulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); } 70% { box-shadow: 0 0 0 6px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
        .pip-titles { min-width: 0; }
        .pip-name { font-size: 13px; font-weight: 600; line-height: 1.2; }
        .pip-sub { font-size: 10.5px; color: rgba(255,255,255,0.6); line-height: 1.3; }
        .pip-min { margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: none; background: rgba(255,255,255,0.12); color: #fff; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s; }
        .pip-min:hover { background: rgba(255,255,255,0.26); }
        /* Collapsed mode — the floating "listening" icon. The whole window
           is one click target; the orb carries the state: green dot while
           listening, white dots while answering, badge + glow when an
           answer is waiting. */
        .pip-mini { display: none; position: relative; flex-direction: column; align-items: center; justify-content: center; gap: 9px; width: 100%; height: 100%; padding: 0; border: none; background: transparent; cursor: pointer; font-family: inherit; }
        body.pip-collapsed .pip-head, body.pip-collapsed .pip-live, body.pip-collapsed .pip-msgs, body.pip-collapsed .pip-toolbar, body.pip-collapsed .pip-newchat-row, body.pip-collapsed .pip-inputrow { display: none; }
        body.pip-collapsed .pip-mini { display: flex; }
        .pip-mini-stage { position: relative; width: 72px; height: 72px; }
        .pip-mini-ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--cyan); opacity: 0; pointer-events: none; }
        .pip-mini.is-live .pip-mini-ring { animation: pipRing 2s ease-out infinite; }
        @keyframes pipRing { 0% { transform: scale(1); opacity: 0.5; } 100% { transform: scale(1.55); opacity: 0; } }
        .pip-mini-orb { position: relative; width: 72px; height: 72px; border-radius: 50%; background: var(--primary); color: #fff; display: grid; place-items: center; font-size: 26px; font-weight: 700; box-shadow: 0 8px 24px rgba(3,114,255,0.35); transition: transform 0.15s, background 0.15s; }
        .pip-mini:hover .pip-mini-orb { transform: scale(1.05); background: var(--primary-hover); }
        .pip-mini-dots { display: none; gap: 5px; }
        .pip-mini-dots i { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: pipDot 1.4s infinite ease-in-out both; }
        .pip-mini-dots i:nth-child(1) { animation-delay: -0.32s; }
        .pip-mini-dots i:nth-child(2) { animation-delay: -0.16s; }
        .pip-mini.is-thinking .pip-mini-letter { display: none; }
        .pip-mini.is-thinking .pip-mini-dots { display: inline-flex; }
        .pip-mini-dot { position: absolute; bottom: 2px; right: 2px; width: 15px; height: 15px; border-radius: 50%; background: #94a3b8; border: 3px solid var(--row); }
        .pip-mini-dot.live { background: #10b981; animation: pipPulse 2.2s ease-out infinite; }
        .pip-mini-badge { position: absolute; top: -5px; right: -5px; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 999px; background: #fff; color: var(--primary); border: 2px solid var(--primary); font-size: 11px; font-weight: 800; display: none; place-items: center; box-shadow: 0 2px 8px rgba(22,31,91,0.25); }
        .pip-mini.has-unseen .pip-mini-badge { display: grid; }
        .pip-mini.has-unseen .pip-mini-orb { animation: pipGlow 1.6s ease-in-out infinite; }
        @keyframes pipGlow { 0%, 100% { box-shadow: 0 8px 24px rgba(3,114,255,0.35); } 50% { box-shadow: 0 0 0 9px rgba(3,114,255,0.16), 0 8px 28px rgba(3,114,255,0.5); } }
        .pip-mini-label { font-size: 10.5px; font-weight: 600; color: #6B7693; letter-spacing: 0.01em; }
        .pip-mini.has-unseen .pip-mini-label { color: var(--primary); font-weight: 700; }
        .pip-new { animation: pipNewFlash 1.8s ease-out 1; }
        @keyframes pipNewFlash { 0% { box-shadow: 0 0 0 3px rgba(3,114,255,0.5); } 100% { box-shadow: 0 0 0 3px rgba(3,114,255,0); } }
        .pip-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
        .pip-empty { margin: auto; max-width: 250px; text-align: center; color: #64748b; font-size: 12.5px; line-height: 1.6; }
        /* Live listening band — mirrors the main tab's transcript strip:
           streams the voice-to-text while hearing, then flips to a busy
           "Processing/Researching" state once a question is identified. */
        .pip-live { display: none; align-items: flex-start; gap: 10px; padding: 9px 14px; background: var(--quote); border-bottom: 1px solid var(--divider); flex-shrink: 0; }
        .pip-live.show { display: flex; }
        .pip-live-ind { display: inline-flex; align-items: center; height: 16px; margin-top: 1px; flex-shrink: 0; }
        .pip-live-wave { display: inline-flex; align-items: flex-end; gap: 2px; height: 16px; }
        .pip-live-wave i { width: 3px; height: 5px; background: var(--primary); border-radius: 2px; animation: pipWave 1s ease-in-out infinite; }
        .pip-live-wave i:nth-child(2) { animation-delay: 0.15s; }
        .pip-live-wave i:nth-child(3) { animation-delay: 0.3s; }
        @keyframes pipWave { 0%, 100% { height: 4px; } 50% { height: 15px; } }
        .pip-live-dots { display: none; gap: 3px; align-items: center; }
        .pip-live-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); animation: pipDot 1.4s infinite ease-in-out both; }
        .pip-live-dots i:nth-child(1) { animation-delay: -0.32s; }
        .pip-live-dots i:nth-child(2) { animation-delay: -0.16s; }
        /* Stage swap: a sound-wave while listening, bouncing dots while Randy
           analyzes the question and researches the support site. */
        .pip-live.stage-analyzing .pip-live-wave,
        .pip-live.stage-researching .pip-live-wave { display: none; }
        .pip-live.stage-analyzing .pip-live-dots,
        .pip-live.stage-researching .pip-live-dots { display: inline-flex; }
        .pip-live-body { min-width: 0; flex: 1; }
        .pip-live-label { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--primary); line-height: 1.4; transition: color 0.2s; }
        .pip-live-text { font-size: 12.5px; line-height: 1.45; color: var(--dark); margin-top: 2px; overflow-wrap: break-word; }
        .pip-live-text:empty { display: none; }
        /* Per-stage accent — colour the band, indicator and label together so
           each step reads at a glance. Analyzing = amber, Researching = green. */
        .pip-live.stage-analyzing { background: #FFFBEB; border-bottom-color: #FDE68A; }
        .pip-live.stage-analyzing .pip-live-label { color: #B45309; }
        .pip-live.stage-analyzing .pip-live-dots i { background: #D97706; }
        .pip-live.stage-analyzing .pip-live-text { color: #92400E; }
        .pip-live.stage-researching { background: #ECFDF5; border-bottom-color: #A7F3D0; }
        .pip-live.stage-researching .pip-live-label { color: #047857; }
        .pip-live.stage-researching .pip-live-dots i { background: #059669; }
        .pip-live.stage-researching .pip-live-text { color: #065F46; }
        .pip-live-caret { display: inline-block; margin-left: 1px; color: var(--primary); font-weight: 700; animation: pipCaret 1s steps(1) infinite; }
        @keyframes pipCaret { 50% { opacity: 0; } }
        .pip-row { display: flex; justify-content: flex-start; }
        .pip-row.user { justify-content: flex-end; }
        .pip-bubble { max-width: 88%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.5; overflow-wrap: break-word; white-space: pre-wrap; }
        .pip-user { background: var(--primary); color: #fff; border-radius: 12px 12px 4px 12px; }
        .pip-bot { background: #fff; color: var(--dark); border: 1px solid var(--divider); border-radius: 4px 12px 12px 12px; }
        .pip-md { white-space: normal; }
        .pip-bubble.pip-md { position: relative; padding-right: 34px; }
        .pip-copy { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; padding: 0; border-radius: 6px; border: 1px solid var(--divider); background: #fff; color: #64748b; display: grid; place-items: center; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s; }
        .pip-copy:hover { color: var(--primary); border-color: var(--cyan); background: var(--quote); }
        .pip-copy .ic-check { display: none; }
        .pip-copy.copied { color: #0F7A3F; border-color: #0F7A3F; }
        .pip-copy.copied .ic-copy { display: none; }
        .pip-copy.copied .ic-check { display: block; }
        .pip-md p { margin: 0 0 7px; }
        .pip-md p:last-child { margin-bottom: 0; }
        .pip-md ul, .pip-md ol { margin: 4px 0 8px; padding-left: 18px; }
        .pip-md li { margin-bottom: 4px; }
        .pip-md strong { color: var(--navy); }
        .pip-md code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
        .pip-md a { color: var(--primary); }
        .pip-md .md-h { font-weight: 700; color: var(--navy); margin: 8px 0 5px; font-size: 12.5px; }
        .pip-badge { display: block; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.75; margin-bottom: 3px; }
        .pip-badge.assist { color: var(--primary); opacity: 1; }
        .pip-src { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; padding-top: 7px; border-top: 1px dashed #e2e8f0; }
        .pip-src a { font-size: 10px; font-weight: 600; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 999px; padding: 2px 8px; text-decoration: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pip-src a:hover { color: var(--primary); border-color: var(--cyan); background: var(--quote); }
        .pip-tdot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; display: inline-block; margin-right: 3px; animation: pipDot 1.4s infinite ease-in-out both; }
        .pip-tdot:nth-child(1) { animation-delay: -0.32s; }
        .pip-tdot:nth-child(2) { animation-delay: -0.16s; }
        @keyframes pipDot { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        /* Read-aloud toggle — mirrors the main tab's voice switch so the
           pop-out can mute/unmute Randy's spoken answers. */
        .pip-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 12px; background: #fff; border-top: 1px solid var(--divider); flex-shrink: 0; }
        .pip-speak { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 600; color: #6B7693; cursor: pointer; user-select: none; transition: color 0.15s; }
        .pip-speak:hover { color: var(--navy); }
        .pip-speak.on { color: var(--primary); }
        .pip-speak svg { width: 15px; height: 15px; flex-shrink: 0; }
        .pip-speak .pip-ic-on { display: none; }
        .pip-speak.on .pip-ic-on { display: inline-block; }
        .pip-speak.on .pip-ic-off { display: none; }
        .pip-switch { position: relative; display: inline-flex; width: 38px; height: 21px; border-radius: 999px; background: #C3CBDC; cursor: pointer; transition: background 0.2s; flex-shrink: 0; }
        .pip-switch:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(3,114,255,0.28); }
        .pip-switch.on { background: var(--primary); }
        .pip-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: left 0.2s; box-shadow: 0 1px 3px rgba(22,31,91,0.25); }
        .pip-switch.on::after { left: 19px; }
        .pip-newchat-row { display: flex; padding: 0 12px 9px; background: #fff; flex-shrink: 0; }
        .pip-newchat { display: inline-flex; align-items: center; justify-content: center; gap: 7px; width: 100%; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--navy); background: #fff; border: 1.5px solid var(--divider); border-radius: 9px; cursor: pointer; font-family: inherit; transition: border-color 0.15s, color 0.15s, background 0.15s; }
        .pip-newchat:hover { border-color: var(--primary); color: var(--primary); background: #F5F9FF; }
        .pip-newchat svg { width: 15px; height: 15px; flex-shrink: 0; }
        .pip-inputrow { display: flex; gap: 8px; align-items: center; padding: 10px; border-top: 1px solid var(--divider); background: #fff; flex-shrink: 0; }
        .pip-inputrow input { flex: 1; min-width: 0; border: 1.5px solid var(--divider); border-radius: 9999px; padding: 9px 14px; font-size: 13px; outline: none; color: var(--navy); font-family: inherit; }
        .pip-inputrow input:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(0,191,255,0.16); }
        .pip-send { width: 38px; height: 38px; border-radius: 50%; background: var(--primary); color: #fff; border: none; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s; }
        .pip-send:hover { background: var(--primary-hover); }
        .pip-send:disabled { background: #cbd5e1; cursor: not-allowed; }
        .pip-mic { width: 38px; height: 38px; border-radius: 50%; background: #fff; color: var(--primary); border: 1.5px solid var(--divider); display: grid; place-items: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s, color 0.15s, border-color 0.15s; }
        .pip-mic:hover { border-color: var(--primary); background: #F5F9FF; }
        .pip-mic svg { width: 17px; height: 17px; }
        .pip-mic .pip-mic-live { display: none; }
        .pip-mic:disabled { opacity: 0.45; cursor: not-allowed; }
        .pip-mic.recording { background: #EF4444; border-color: #EF4444; color: #fff; animation: pipMicPulse 1.5s ease-in-out infinite; }
        .pip-mic.recording:hover { background: #DC2626; border-color: #DC2626; }
        .pip-mic.recording .pip-mic-idle { display: none; }
        .pip-mic.recording .pip-mic-live { display: block; }
        @keyframes pipMicPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.45); } 50% { box-shadow: 0 0 0 6px rgba(239,68,68,0); } }
        @media (prefers-reduced-motion: reduce) { .pip-dot.live, .pip-mini-dot.live, .pip-mini.is-live .pip-mini-ring, .pip-mini.has-unseen .pip-mini-orb, .pip-mini-dots i, .pip-new, .pip-tdot, .pip-live-wave i, .pip-live-dots i, .pip-live-caret, .pip-mic.recording { animation: none; } }
      `;

      // Toggle the floating window. Must run from a real user click —
      // requestWindow() requires a user gesture.
      async function togglePipWindow(idx) {
        if (!PIP.supported) return;
        if (PIP.window) { try { PIP.window.close(); } catch {} return; } // pagehide does the cleanup
        if (PIP.opening) return;
        PIP.opening = true;
        try {
          // preferInitialWindowPlacement: always dock at Chrome's default
          // spot (bottom-right of the screen) instead of wherever a past
          // PiP window was left.
          const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 380, height: 560, preferInitialWindowPlacement: true });
          PIP.window = pipWindow;
          PIP.slotIdx = idx;
          PIP.collapsed = false;
          PIP.restoreSize = null;
          PIP.unseen = 0;
          PIP.flashNext = false;
          PIP.flashNow = false;
          setupPipWindow(pipWindow);
          showToast('Chat popped out — it stays on top while you work');
          render();
        } catch (err) {
          console.warn('Pop-out window failed:', err);
          showToast("Couldn't open the pop-out window");
        } finally {
          PIP.opening = false;
        }
      }

      // One-time scaffold of a PiP document: stylesheet, static skeleton
      // (header / message list / composer / collapsed icon) and its own
      // event listeners. Both modes get the full skeleton — `collapsed`
      // just decides which half shows, so renderPip() works unchanged on
      // either window. renderPip() only ever rewrites #pip-msgs and the
      // status bits — the input element is never rebuilt, so its text and
      // focus survive re-renders (the PiP-side answer to
      // isComposerFocused()).
      function setupPipWindow(w, { collapsed = false } = {}) {
        const doc = w.document;
        const slot = STATE.slots[PIP.slotIdx];
        const label = slot ? slot.label : 'Randy';
        doc.title = label + ' — pop-out chat';

        // The PiP document doesn't inherit page resources: bring the brand
        // font along, then the self-contained styles.
        const font = document.querySelector('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
        if (font) {
          const l = doc.createElement('link');
          l.rel = 'stylesheet';
          l.href = font.href;
          doc.head.appendChild(l);
        }
        const style = doc.createElement('style');
        style.textContent = PIP_CSS;
        doc.head.appendChild(style);

        doc.body.innerHTML = `
          <div class="pip-head">
            <div class="pip-avatar">${escHtml(label.charAt(0))}<span class="pip-dot" id="pip-dot"></span></div>
            <div class="pip-titles">
              <div class="pip-name">${escHtml(label)}</div>
              <div class="pip-sub" id="pip-sub">Online</div>
            </div>
            <button class="pip-min" data-action="pip-minimize" title="Minimize to a floating icon" aria-label="Minimize to a floating icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
            </button>
          </div>
          <div class="pip-live" id="pip-live">
            <span class="pip-live-ind" aria-hidden="true">
              <span class="pip-live-wave"><i></i><i></i><i></i></span>
              <span class="pip-live-dots"><i></i><i></i><i></i></span>
            </span>
            <div class="pip-live-body">
              <div class="pip-live-label" id="pip-live-label">Listening for technical questions</div>
              <div class="pip-live-text" id="pip-live-text"></div>
            </div>
          </div>
          <div class="pip-msgs" id="pip-msgs"></div>
          <div class="pip-toolbar">
            <label class="pip-speak" id="pip-speak" data-action="pip-toggle-speak" title="Read each answer aloud">
              <svg class="pip-ic-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3l3.8 3.8a.7.7 0 0 0 1.2-.5Z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 5.6a10 10 0 0 1 0 12.8"/></svg>
              <svg class="pip-ic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3l3.8 3.8a.7.7 0 0 0 1.2-.5Z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
              <span>Read aloud</span>
            </label>
            <span class="pip-switch" id="pip-switch" role="switch" aria-checked="false" aria-label="Read answers aloud" tabindex="0" data-action="pip-toggle-speak"></span>
          </div>
          <div class="pip-newchat-row">
            <button class="pip-newchat" id="pip-newchat" data-action="pip-new-chat" title="Start a new chat — the current one is saved in History">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              <span>New chat</span>
            </button>
          </div>
          <div class="pip-inputrow">
            <input type="text" id="pip-input" placeholder="Message ${escAttr(label)}…" autocomplete="off" />
            <button class="pip-send" id="pip-send" data-action="pip-send" title="Send message" aria-label="Send message">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            </button>
            <button class="pip-mic" id="pip-mic" data-action="pip-dictate" title="Dictate your message — voice to text" aria-label="Dictate your message" aria-pressed="false"${VOICE.srSupported ? '' : ' disabled'}>
              <svg class="pip-mic-idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
              <svg class="pip-mic-live" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
            </button>
          </div>
          <button class="pip-mini" id="pip-mini" data-action="pip-expand" title="Randy is listening — click to open the chat" aria-label="Open the chat">
            <span class="pip-mini-stage">
              <span class="pip-mini-ring"></span>
              <span class="pip-mini-orb">
                <span class="pip-mini-letter">${escHtml(label.charAt(0))}</span>
                <span class="pip-mini-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="pip-mini-dot" id="pip-mini-dot"></span>
                <span class="pip-mini-badge" id="pip-mini-badge">1</span>
              </span>
            </span>
            <span class="pip-mini-label" id="pip-mini-label">Listening…</span>
          </button>`;

        // The main page's delegated listeners are bound to the MAIN document
        // and never fire here — the PiP document needs its own.
        doc.addEventListener('click', e => {
          if (!e.target.closest) return;
          if (e.target.closest('[data-action="pip-send"]')) { sendFromPip(); return; }
          if (e.target.closest('[data-action="pip-dictate"]')) { toggleDictation(); return; }
          if (e.target.closest('[data-action="pip-minimize"]')) { collapsePip(); return; }
          if (e.target.closest('[data-action="pip-expand"]')) { expandPip(); return; }
          if (e.target.closest('[data-action="pip-toggle-speak"]')) { toggleSpeakFromPip(); return; }
          if (e.target.closest('[data-action="pip-new-chat"]')) { newChat(); return; }
          const cp = e.target.closest('[data-action="pip-copy"]');
          if (cp) copyFromPip(cp);
        });
        doc.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.id === 'pip-input') {
            e.preventDefault();
            sendFromPip();
            return;
          }
          if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.id === 'pip-switch') {
            e.preventDefault();
            toggleSpeakFromPip();
          }
        });
        w.addEventListener('pagehide', () => {
          if (PIP.swapping) return; // window replaced by a swap, not closed
          if (VOICE.dictating) stopDictation(); // free the mic, resume Randy
          if (PIP.window === w) {
            PIP.window = null;
            PIP.slotIdx = null;
            PIP.lastHtml = '';
            PIP.collapsed = false;
            PIP.restoreSize = null;
            PIP.unseen = 0;
            PIP.flashNext = false;
            PIP.flashNow = false;
            render(); // put the pop-out buttons back in their closed state
          }
        });

        if (collapsed) doc.body.classList.add('pip-collapsed');
        PIP.lastHtml = '';
        renderPip();
        if (!collapsed) setTimeout(() => { try { doc.getElementById('pip-input').focus(); } catch {} }, 50);
      }

      // Mute / unmute Randy's spoken answers from the pop-out. Shares the
      // same slot.speakAnswers flag as the main tab's switch, so toggling
      // here and there stays in sync; render() refreshes both views.
      function toggleSpeakFromPip() {
        const slot = STATE.slots[PIP.slotIdx];
        if (!slot) return;
        slot.speakAnswers = !slot.speakAnswers;
        saveSettings();
        if (!slot.speakAnswers && slot.isSpeaking) stopSpeaking();
        render();
      }

      function sendFromPip() {
        const w = PIP.window;
        if (!w || w.closed) return;
        const slot = STATE.slots[PIP.slotIdx];
        const input = w.document.getElementById('pip-input');
        if (!slot || !input) return;
        const text = input.value.trim();
        if (!text || slot.loading) return;
        // Sending ends dictation — clear the staged text first so the
        // recognizer's trailing onend can't repaint the just-cleared input.
        if (VOICE.dictating) { VOICE.dictationBase = ''; stopDictation(); }
        slot.inputText = text;
        input.value = '';
        sendMessage(PIP.slotIdx); // its render() syncs the pop-out too
      }

      // Copy an assist answer from the pop-out. Goes through the PiP
      // window's OWN clipboard: the async Clipboard API rejects when the
      // calling document isn't focused, and during this click the focused
      // document is the pop-out, not the main page. Plain text, same as
      // the main app's copy-msg, so it pastes cleanly into chat/email.
      function copyFromPip(btn) {
        const w = PIP.window;
        if (!w || w.closed) return;
        const slot = STATE.slots[PIP.slotIdx];
        const m = slot && slot.messages[parseInt(btn.dataset.msg, 10)];
        if (!m || !m.content) return;
        const text = stripMarkdown(m.content);
        const done = () => {
          btn.classList.add('copied');
          setTimeout(() => { try { btn.classList.remove('copied'); } catch {} }, 1200);
        };
        const fallback = () => {
          try {
            const d = w.document;
            const ta = d.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            d.body.appendChild(ta); ta.select();
            d.execCommand('copy'); d.body.removeChild(ta);
            done();
          } catch {}
        };
        if (w.navigator.clipboard && w.navigator.clipboard.writeText) {
          w.navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else fallback();
      }

      // True when the main window holds transient user activation — clicks
      // inside the PiP window propagate it here, which is exactly what
      // requestWindow() and resizeTo() need.
      function canSwapPipWindow() {
        return !!(navigator.userActivation && navigator.userActivation.isActive);
      }

      // PiP windows can't be moved programmatically, so changing where one
      // sits means replacing it: request a fresh window with
      // preferInitialWindowPlacement and Chrome docks it at its default
      // spot — the bottom-right corner of the screen. Chrome closes the
      // old window itself (one PiP window at a time); the swapping flag
      // keeps that pagehide from being mistaken for the user closing it.
      async function swapPipWindow({ width, height }) {
        const old = PIP.window;
        PIP.swapping = true;
        try {
          const next = await window.documentPictureInPicture.requestWindow({
            width, height, preferInitialWindowPlacement: true
          });
          if (old && old !== next) { try { old.close(); } catch {} }
          PIP.window = next;
          PIP.lastHtml = '';
          return next;
        } finally {
          PIP.swapping = false;
        }
      }

      // Minimize the pop-out down to the small "R" icon, docked at the
      // bottom-right of the screen, that keeps listening (green dot =
      // voice on, same as everywhere else). Without activation to swap
      // windows, shrink the current one where it sits instead.
      async function collapsePip() {
        const w = PIP.window;
        if (!w || w.closed || PIP.collapsed || PIP.swapping) return;
        if (VOICE.dictating) stopDictation(); // the input is hidden while collapsed
        PIP.collapsed = true;
        PIP.unseen = 0;
        PIP.flashNext = false;
        PIP.flashNow = false;
        PIP.restoreSize = {
          width: w.innerWidth > 0 ? w.innerWidth : 380,
          height: w.innerHeight > 0 ? w.innerHeight : 560,
          outerWidth: w.outerWidth || 0,
          outerHeight: w.outerHeight || 0
        };
        if (canSwapPipWindow()) {
          try {
            const mini = await swapPipWindow({ width: 240, height: 130 });
            setupPipWindow(mini, { collapsed: true });
            return;
          } catch (err) {
            console.warn('PiP swap to icon failed, resizing in place:', err);
          }
        }
        try { w.document.body.classList.add('pip-collapsed'); } catch {}
        try { w.resizeTo(240, 152); } catch (err) { console.warn('PiP collapse resize failed:', err); }
        renderPip();
      }

      // Post-expand touches shared by both expand paths: land on the
      // newest answer, highlight it (the typing indicator doesn't count),
      // and only refocus the input on a deliberate click — never steal OS
      // focus while the user is mid-call in another app.
      function finishPipExpand(w, { auto, hadUnseen }) {
        try {
          const doc = w.document;
          const msgs = doc.getElementById('pip-msgs');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
          if (auto || hadUnseen) {
            const bots = doc.querySelectorAll('.pip-bubble.pip-bot:not(.pip-typing)');
            if (bots.length) bots[bots.length - 1].classList.add('pip-new');
            // Auto-expanded for a question that's still being answered —
            // there's no answer bubble to highlight yet; flag the reply so
            // it flashes the moment it lands.
            else if (auto) PIP.flashNext = true;
          }
          if (!auto) setTimeout(() => { try { doc.getElementById('pip-input').focus(); } catch {} }, 50);
        } catch {}
      }

      // Bring the full chat back at its previous size. Manual path = a
      // click inside the PiP window, which propagates the activation the
      // window swap needs. The auto path (a question just came in) has no
      // gesture; Chrome refuses the swap, we stay collapsed, and the icon
      // flips to its thinking / answer-ready state instead — returns false
      // so callers know the chat didn't come back.
      async function expandPip({ auto = false } = {}) {
        const w = PIP.window;
        if (!w || w.closed || !PIP.collapsed || PIP.swapping) return false;
        const size = PIP.restoreSize || { width: 380, height: 560 };
        const hadUnseen = PIP.unseen > 0;
        if (canSwapPipWindow()) {
          try {
            const big = await swapPipWindow({ width: size.width, height: size.height });
            PIP.collapsed = false;
            PIP.unseen = 0;
            PIP.restoreSize = null;
            setupPipWindow(big, { collapsed: false });
            finishPipExpand(big, { auto, hadUnseen });
            return true;
          } catch (err) {
            if (auto) return false;
            console.warn('PiP swap to chat failed, expanding in place:', err);
          }
        } else if (auto) {
          return false;
        }
        // In-place fallback (manual click without a usable swap): grow the
        // current window where it sits rather than leaving the user stuck.
        PIP.collapsed = false;
        PIP.unseen = 0;
        PIP.restoreSize = null;
        try { w.document.body.classList.remove('pip-collapsed'); } catch {}
        try { w.resizeTo(size.outerWidth || size.width, size.outerHeight || size.height); }
        catch (err) { console.warn('PiP expand resize failed:', err); }
        renderPip();
        finishPipExpand(w, { auto: false, hadUnseen });
        return true;
      }

      // A question just came in — pop the collapsed icon back out so the
      // answer lands in view. If Chrome refuses the gesture-less swap,
      // renderPip() shows the thinking state on the icon instead.
      function pipAutoExpand() {
        if (!PIP.window || PIP.window.closed || !PIP.collapsed) return;
        expandPip({ auto: true });
      }

      // An answer just finished. Collapsed: try once more to pop out with
      // the result, badge the icon if that's refused. Expanded because of
      // an earlier auto-expand: highlight the reply when the message list
      // next rebuilds (the render that paints it).
      async function notePipAnswerArrived() {
        const w = PIP.window;
        if (!w || w.closed) return;
        if (PIP.collapsed) {
          const expanded = await expandPip({ auto: true });
          if (!expanded && PIP.collapsed) {
            PIP.unseen++;
            renderPip();
          }
          return;
        }
        if (PIP.flashNext) { PIP.flashNext = false; PIP.flashNow = true; }
      }

      // Live listening band, mirroring the main tab's transcript strip:
      // stream the voice-to-text while Randy hears speech, then flip to a
      // busy "Processing/Researching" state the moment a question is being
      // checked or answered. Hidden whenever Randy isn't actively listening,
      // so typed-only use of the pop-out is unaffected.
      // The live band walks the question through three stages so the user can
      // watch Randy work: (1) listening — the voice-to-text streams in;
      // (2) analyzing — the classifier is deciding if it's a tech question;
      // (3) researching — the support-site web search is running for the answer.
      function pipLiveModel(slot) {
        if (!slot || !slot.listenOn) return { show: false };
        // Stage 3 — answering. The web search runs here. An overheard question
        // is a technical-assist answer ("Researching support site"); a spoken
        // one is an ordinary chat reply ("Thinking").
        if (slot.loading) {
          let lastUser = null;
          for (let i = slot.messages.length - 1; i >= 0; i--) {
            if (slot.messages[i].role === 'user') { lastUser = slot.messages[i]; break; }
          }
          const researching = lastUser && lastUser.kind === 'assist-q';
          if (researching) {
            return { show: true, stage: 'researching', label: 'Researching support site', text: lastUser ? lastUser.content : '' };
          }
          return { show: true, stage: 'researching', label: 'Thinking…', text: '' };
        }
        // Stage 2 — the classifier is deciding whether the utterance is a
        // technical question worth answering.
        if (TECH.pending) {
          return { show: true, stage: 'analyzing', label: 'Analyzing question', text: TECH.activeText || VOICE.interimText || '' };
        }
        // Stage 1 — live transcription as Randy hears the call.
        return { show: true, stage: 'listening', label: 'Listening for technical questions', text: VOICE.interimText || '' };
      }

      // Push the live-band state into the pop-out document. Called from
      // renderPip() (covers status changes) and directly from the interim
      // transcript hooks (which bypass a full render for performance). Must
      // never throw — the window can close between checks and DOM writes.
      function updatePipLive(slot) {
        const w = PIP.window;
        if (!w || w.closed || PIP.collapsed) return;
        try {
          const doc = w.document;
          const band = doc.getElementById('pip-live');
          if (!band) return;
          const m = pipLiveModel(slot || STATE.slots[PIP.slotIdx]);
          band.classList.toggle('show', !!m.show);
          band.classList.toggle('stage-listening', m.stage === 'listening');
          band.classList.toggle('stage-analyzing', m.stage === 'analyzing');
          band.classList.toggle('stage-researching', m.stage === 'researching');
          if (!m.show) return;
          const lbl = doc.getElementById('pip-live-label');
          if (lbl && lbl.textContent !== m.label) lbl.textContent = m.label;
          const txt = doc.getElementById('pip-live-text');
          if (txt) {
            // Only the live-transcription stage gets the blinking caret; the
            // analyzing/researching text is the settled question, shown plainly.
            const caret = m.stage === 'listening' ? '<span class="pip-live-caret">▊</span>' : '';
            const html = m.text ? escHtml(m.text) + caret : '';
            if (txt.innerHTML !== html) txt.innerHTML = html;
          }
        } catch (err) {
          // window vanished mid-write — harmless, next render reconciles.
        }
      }

      // Status line + listening dot, mirroring the conv-sub logic in
      // renderCard so the pop-out reflects the main tab's voice state.
      function pipStatus(slot) {
        const on = !!slot.listenOn;
        if (slot.isSpeaking) return { text: 'Talking…', live: true };
        if (slot.loading) return { text: 'Thinking…', live: on };
        if (on) return { text: 'Listening for technical questions', live: true };
        return { text: 'Online', live: false };
      }

      function pipMessagesHtml(slot) {
        const msgs = slot.messages;
        if (msgs.length === 0 && !slot.loading) {
          if (slot.listenOn) {
            return '<div class="pip-empty">Listening to the call — technical questions get answered here as Randy hears them.</div>';
          }
          return '<div class="pip-empty">No messages yet — turn ' + escHtml(slot.voiceName || slot.label) + ' on in the main tab to listen to your call, or type below.</div>';
        }
        const out = msgs.map((m, mi) => {
          if (m.role === 'user') {
            const badge = m.kind === 'assist-q' ? '<span class="pip-badge">Overheard</span>' : '';
            return '<div class="pip-row user"><div class="pip-bubble pip-user">' + badge + escHtml(m.content) + '</div></div>';
          }
          if (!m.content) return ''; // in-flight placeholder — the typing dots cover it
          // Same single render path as the main chat: every answer gets markdown
          // + source chips; the "Technical assist" badge marks overheard ones.
          const srcs = Array.isArray(m.sources) ? m.sources : [];
          const badge = m.kind === 'assist' ? '<span class="pip-badge assist">Technical assist</span>' : '';
          return '<div class="pip-row"><div class="pip-bubble pip-bot pip-md">' +
            '<button class="pip-copy" data-action="pip-copy" data-msg="' + mi + '" title="Copy answer" aria-label="Copy answer">' +
              '<svg class="ic-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
              '<svg class="ic-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
            '</button>' +
            badge +
            mdToHtml(m.content) +
            (srcs.length ? '<div class="pip-src">' + srcs.map(u =>
              '<a href="' + escAttr(safeHref(u)) + '" target="_blank" rel="noopener noreferrer" title="' + escAttr(u) + '">' + escHtml(sourceLabelOf(u)) + '</a>').join('') + '</div>' : '') +
            '</div></div>';
        });
        if (slot.loading) {
          out.push('<div class="pip-row"><div class="pip-bubble pip-bot pip-typing"><span class="pip-tdot"></span><span class="pip-tdot"></span><span class="pip-tdot"></span></div></div>');
        }
        return out.join('');
      }

      // Refresh the pop-out from STATE. Runs at the end of every render()
      // while the window is open, which is what makes voice answers landing
      // in the main tab appear here in real time. Must never throw — the
      // window can vanish between the .closed check and the DOM writes, and
      // a PiP hiccup must not break the main render cycle.
      function renderPip() {
        const w = PIP.window;
        if (!w || w.closed) return;
        const slot = STATE.slots[PIP.slotIdx];
        if (!slot) return;
        try {
          const doc = w.document;
          const msgs = doc.getElementById('pip-msgs');
          if (!msgs) return;

          const st = pipStatus(slot);
          const sub = doc.getElementById('pip-sub');
          if (sub && sub.textContent !== st.text) sub.textContent = st.text;
          const dot = doc.getElementById('pip-dot');
          if (dot) dot.className = 'pip-dot' + (st.live ? ' live' : '');

          // Live transcript / processing band.
          updatePipLive(slot);

          // Read-aloud switch — keep in sync with slot.speakAnswers (it can
          // also be toggled from the main tab).
          const speakOn = !!slot.speakAnswers;
          const speakLbl = doc.getElementById('pip-speak');
          if (speakLbl) {
            speakLbl.classList.toggle('on', speakOn);
            const t = speakOn ? 'Randy reads each answer aloud — click to mute' : 'Answers stay silent — click to have Randy read them aloud';
            if (speakLbl.title !== t) speakLbl.title = t;
          }
          const speakSw = doc.getElementById('pip-switch');
          if (speakSw) {
            speakSw.classList.toggle('on', speakOn);
            speakSw.setAttribute('aria-checked', speakOn ? 'true' : 'false');
          }

          // Collapsed icon: listening → answering → answer-ready.
          const mini = doc.getElementById('pip-mini');
          if (mini) {
            const thinking = !!slot.loading;
            const unseen = !thinking && PIP.unseen > 0;
            mini.classList.toggle('is-live', st.live);
            mini.classList.toggle('is-thinking', thinking);
            mini.classList.toggle('has-unseen', unseen);
            const miniDot = doc.getElementById('pip-mini-dot');
            if (miniDot) miniDot.className = 'pip-mini-dot' + (st.live ? ' live' : '');
            const badge = doc.getElementById('pip-mini-badge');
            if (badge) badge.textContent = PIP.unseen > 9 ? '9+' : String(PIP.unseen || 1);
            const lbl = doc.getElementById('pip-mini-label');
            const lblText = thinking ? 'Answering…'
              : unseen ? (PIP.unseen === 1 ? 'Answer ready' : PIP.unseen + ' answers ready')
              : st.live ? 'Listening…' : 'Online';
            if (lbl && lbl.textContent !== lblText) lbl.textContent = lblText;
            const t = thinking ? 'Randy is answering — click to open the chat'
              : unseen ? 'Answer ready — click to view it'
              : st.live ? 'Randy is listening — click to open the chat'
              : 'Click to open the chat';
            if (mini.title !== t) mini.title = t;
          }

          const name = doc.querySelector('.pip-name');
          if (name && name.textContent !== slot.label) {
            name.textContent = slot.label;
            doc.title = slot.label + ' — pop-out chat';
          }

          // Skip no-op rebuilds (toasts and interim updates re-render the
          // main app constantly) so text selection in the pop-out survives.
          const html = pipMessagesHtml(slot);
          if (PIP.lastHtml !== html) {
            const atBottom = msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 48;
            msgs.innerHTML = html;
            PIP.lastHtml = html;
            if (atBottom) msgs.scrollTop = msgs.scrollHeight;
            if (PIP.flashNow) {
              PIP.flashNow = false;
              const bots = msgs.querySelectorAll('.pip-bubble.pip-bot:not(.pip-typing)');
              if (bots.length) bots[bots.length - 1].classList.add('pip-new');
            }
          }

          const sendBtn = doc.getElementById('pip-send');
          if (sendBtn && sendBtn.disabled !== !!slot.loading) sendBtn.disabled = !!slot.loading;

          // Dictation mic — reflect the live recording state.
          const micBtn = doc.getElementById('pip-mic');
          if (micBtn) {
            micBtn.classList.toggle('recording', !!VOICE.dictating);
            micBtn.setAttribute('aria-pressed', VOICE.dictating ? 'true' : 'false');
            if (micBtn.disabled !== !VOICE.srSupported) micBtn.disabled = !VOICE.srSupported;
            const t = VOICE.dictating ? 'Stop dictation' : 'Dictate your message — voice to text';
            if (micBtn.title !== t) micBtn.title = t;
          }
        } catch (err) {
          console.warn('renderPip failed:', err);
        }
      }

      /* ================================================================
       * EVENTS
       * ================================================================ */

      let _bound = false;
      function bindEvents() {
        if (_bound) return;
        _bound = true;

        // The microphone picker in Settings. Changing it re-opens the held
        // capture on the chosen device right away (no need to toggle Randy off
        // and on). The screen-share picker is NOT re-triggered — only the mic
        // stream is swapped — so two-way users aren't re-prompted.
        document.addEventListener('change', e => {
          const el = e.target;
          if (!el) return;

          // The speaking-voice picker. '' = automatic. Changing it re-renders
          // Settings so the "(currently …)" hint and selection stay accurate;
          // the next spoken sentence uses the new voice via resolveVoice().
          if (el.id === 'setting-voice-list') {
            TTS.chosenName = el.value || '';
            saveSettings();
            showToast(TTS.chosenName ? 'Voice set to ' + TTS.chosenName : 'Using the automatic voice');
            render();
            return;
          }

          if (el.id !== 'setting-mic') return;
          MIC.deviceId = el.value || '';
          saveSettings();
          if (STATE.slots[0].listenOn) {
            const twoWay = STATE.slots[0].audioMode === 'two-way';
            if (VOICE.micStream) {
              try { VOICE.micStream.getTracks().forEach(t => t.stop()); } catch {}
              VOICE.micStream = null;
            }
            acquireMicStream(twoWay).then((status) => {
              if (status === 'ok') restartRecognition();
            });
          }
          showToast(MIC.deviceId ? 'Microphone switched' : 'Using the system default microphone');
          render();
        });

        document.addEventListener('click', e => {
          const act = e.target.closest('[data-action]');
          // Close the card overflow menu when clicking outside it.
          if (!act && STATE.cardMenuOpen && !e.target.closest('[data-menu="card"]')) {
            STATE.cardMenuOpen = false;
            render();
            return;
          }
          // Cancel the inline delete-confirm when clicking elsewhere.
          if (STATE.historyConfirmDeleteId) {
            const insidePanel = !!e.target.closest('.history-panel-open');
            const insidePopout = !!HISTORY_VIEW.open && !!e.target.closest('.history-popout');
            const protect = act && /^(confirm-delete-history|cancel-delete-history|confirm-delete-history-yes|confirm-delete-history-popout|copy-answer|load-history|noop)$/.test(act.dataset.action);
            if ((!insidePanel && !insidePopout) || (act && !protect)) {
              STATE.historyConfirmDeleteId = null;
              if (!act) { render(); return; }
            }
          }
          if (!act) return;
          const action = act.dataset.action;
          const idx = act.dataset.idx !== undefined ? parseInt(act.dataset.idx) : null;

          if (STATE.cardMenuOpen && action !== 'toggle-card-menu') STATE.cardMenuOpen = false;

          switch (action) {
            case 'save-onboarding': {
              const fn = document.getElementById('onb-first');
              const ln = document.getElementById('onb-last');
              const first = fn ? fn.value : '';
              const last  = ln ? ln.value : '';
              const errEl = document.getElementById('onb-error');
              if (!first.trim() || !last.trim()) {
                if (errEl) errEl.textContent = 'Please enter both your first and last name.';
                if (!first.trim() && fn) fn.focus(); else if (ln) ln.focus();
                break;
              }
              if (act.dataset.busy === '1') break;   // guard against double-submit
              act.dataset.busy = '1';
              saveUserName(first, last).then(ok => {
                if (!ok) {
                  act.dataset.busy = '';
                  if (errEl) errEl.textContent = 'Please enter both your first and last name.';
                  return;
                }
                render();         // gate now passes → the normal tool renders
                startMainApp();   // run the boot side-effects deferred during onboarding
              });
              break;
            }
            case 'switch-tab': {
              const enteringSettings = STATE.activeTab !== 'settings' && act.dataset.tab === 'settings';
              const leavingSettings = STATE.activeTab === 'settings' && act.dataset.tab !== 'settings';
              // Leaving Settings ends any running mic test (the meter loop also
              // self-terminates, but stop it up front so the capture closes the
              // instant the user navigates).
              if (act.dataset.tab !== 'settings' && MICTEST.active) stopMicTest();
              // Pause listening while Settings is open so its constant
              // re-renders can't glitch the sheet; resume on the way out.
              if (enteringSettings) pauseListenForSettings();
              STATE.activeTab = act.dataset.tab;
              render();
              // Opening Settings is a good moment to refresh the mic list so
              // the picker shows current devices (labels appear once granted).
              if (act.dataset.tab === 'settings') { try { refreshMicDevices(); } catch {} }
              if (leavingSettings) resumeListenAfterSettings();
              break;
            }
            case 'close-settings-bg': {
              if (!e.target.hasAttribute('data-action')) break;
              if (MICTEST.active) stopMicTest();
              STATE.activeTab = 'home';
              render();
              // Resume the listening paused when Settings opened.
              resumeListenAfterSettings();
              break;
            }
            case 'toggle-history': {
              STATE.historyOpen = !STATE.historyOpen;
              if (!STATE.historyOpen) STATE.historyQuery = ''; // a hidden filter would silently hide entries next time
              render();
              break;
            }
            case 'clear-history-search': {
              STATE.historyQuery = '';
              render();
              const si = document.getElementById('history-search');
              if (si) si.focus();
              break;
            }
            case 'toggle-composer': {
              const cur = document.getElementById('home-input-' + (idx !== null ? idx : 0));
              if (cur && STATE.slots[idx !== null ? idx : 0]) STATE.slots[idx !== null ? idx : 0].inputText = cur.value;
              STATE.composerExpanded = !STATE.composerExpanded;
              render();
              setTimeout(() => {
                const inp = document.getElementById('home-input-' + (idx !== null ? idx : 0));
                if (inp) { inp.focus(); const len = inp.value.length; try { inp.setSelectionRange(len, len); } catch {} }
              }, 40);
              break;
            }
            case 'toggle-card-menu': STATE.cardMenuOpen = !STATE.cardMenuOpen; render(); break;
            case 'pop-out-chat': togglePipWindow(idx !== null ? idx : 0); break;
            case 'expand-slot': STATE.expandedSlot = idx; render(); scrollChat(); setTimeout(()=>document.getElementById('expanded-input')?.focus(),100); break;
            case 'close-expanded': STATE.expandedSlot = null; render(); break;
            case 'clear-chat': clearChat(idx !== null ? idx : 0); break;
            case 'send-expanded': {
              const inp = document.getElementById('expanded-input');
              if (inp) STATE.slots[STATE.expandedSlot].inputText = inp.value;
              sendMessage(STATE.expandedSlot);
              break;
            }
            case 'send-home': {
              const inp = document.getElementById('home-input-' + idx);
              if (inp) STATE.slots[idx].inputText = inp.value;
              sendMessage(idx);
              break;
            }
            case 'dictate-home': {
              const di = idx !== null ? idx : 0;
              // Persist whatever's typed so dictation appends to it (and a
              // re-render from the toggle keeps it).
              const cur = document.getElementById('home-input-' + di);
              if (cur && STATE.slots[di]) STATE.slots[di].inputText = cur.value;
              toggleDictation({ kind: 'home', slot: di });
              break;
            }
            case 'ask-selection': toggleSelectionCapture(idx !== null ? idx : 0); break;
            case 'toggle-listen': toggleListening(); break;
            case 'pick-audio-mode': {
              const m = act.dataset.mode === 'two-way' ? 'two-way' : 'one-way';
              const s = STATE.slots[0];
              if (s.audioMode === m && (m === 'one-way' || DESKTOP.on)) { break; }
              s.audioMode = m;
              saveSettings();
              // Listening is only paused because Settings is open — don't spin
              // up a live capture inside the sheet (that's the glitch we're
              // avoiding). Just record the new mode so we resume in it when
              // Settings closes.
              if (STATE.settingsResumeListen) { STATE.settingsResumeListen = m; render(); break; }
              // Apply immediately. Two-way's screen-share picker rides this
              // click's user activation. Restart so the mic's echo-cancellation
              // matches the mode (off for two-way, on for one-way).
              if (s.listenOn) { stopListening({ silent: true }); }
              startListening(m);
              render();
              break;
            }
            case 'share-computer-audio': {
              const s = STATE.slots[0];
              s.audioMode = 'two-way';
              saveSettings();
              if (s.listenOn) { stopListening({ silent: true }); }
              startListening('two-way');
              render();
              break;
            }
            case 'refresh-mics': {
              // Labels stay blank until mic permission has been granted once;
              // a throwaway capture unlocks them, then we re-enumerate.
              (async () => {
                try {
                  if (!MIC.devices.some(d => d.label) && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                    s.getTracks().forEach(t => t.stop());
                  }
                } catch {}
                refreshMicDevices();
              })();
              break;
            }
            case 'test-mic': { startMicTest(); break; }
            case 'stop-mic-test': { stopMicTest(); break; }
            case 'set-audio-mode': {
              const m = act.dataset.mode === 'one-way' ? 'one-way' : 'two-way';
              STATE.slots[0].audioMode = m;
              render();
              // Keep keyboard focus on the slider, and announce the new choice.
              focusAfterRender('.ac-seg-opt[data-mode="' + m + '"]');
              const info = audioModeInfo(m);
              announceLive(info.label + '. ' + info.sub + '. ' + info.line);
              break;
            }
            case 'confirm-audio-mode': {
              STATE.audioChooserOpen = false;
              const m = STATE.slots[0].audioMode === 'one-way' ? 'one-way' : 'two-way';
              // Start capture synchronously inside this click so the mic /
              // screen-share prompts keep the user activation they require,
              // then re-render to dismiss the chooser.
              startListening(m);
              render();
              break;
            }
            case 'close-audio-chooser':
            case 'close-audio-chooser-bg': {
              // Background only closes on a direct click (mirrors the history
              // popout): a click on the modal's own content has no data-action.
              if (action === 'close-audio-chooser-bg' && !e.target.hasAttribute('data-action')) break;
              closeAudioChooser();
              break;
            }
            case 'new-chat': HISTORY_VIEW.open = null; STATE.activeTab = 'home'; newChat(); break;
            case 'toggle-speak-answers': {
              const s = STATE.slots[0];
              s.speakAnswers = !s.speakAnswers;
              saveSettings();
              showToast(s.speakAnswers ? 'Randy will read answers out loud' : 'Answers will show in the chat only');
              if (!s.speakAnswers && s.isSpeaking) stopSpeaking();
              render();
              break;
            }
            case 'stop-speaking': stopSpeaking(); break;
            case 'cancel-reply': abortActiveReply(); render(); break;
            case 'force-answer': {
              const q = act.dataset.text || '';
              if (q.trim()) {
                // Clear the near-miss flag so the chip doesn't linger after tap.
                TECH.decisions.forEach(d => { if (d.text === q) d.nearMiss = false; });
                TECH.lastSubmitted = q;
                TECH.lastSubmittedAt = Date.now();
                runAssistAnswer(0, q);
              }
              break;
            }
            case 'tts-speak': {
              const si = parseInt(act.dataset.slot, 10);
              const mi = parseInt(act.dataset.msg, 10);
              const sl = STATE.slots[si];
              if (!sl) break;
              if (VOICE.playingMsg && VOICE.playingMsg.slot === si && VOICE.playingMsg.msg === mi) {
                stopSpeaking();
                break;
              }
              if (sl.isSpeaking) stopSpeaking();
              const msg = sl.messages[mi];
              if (!msg || msg.role !== 'assistant') break;
              // Every answer now carries a spoken summary (voice and typed
              // alike); fall back to a generated summary only for older
              // messages that predate it.
              const speech = msg.spoken || extractSummary(stripMarkdown(msg.content));
              speakText(speech, si, mi);
              break;
            }
            case 'preview-voice': {
              if (STATE.activeTab === 'settings') readFields();
              speakText("Hey, it's Randy. This is how I'll sound when I answer out loud.", idx !== null ? idx : 0);
              break;
            }
            case 'save-settings': {
              readFields();
              saveSettings();
              showToast('Settings saved');
              render();
              break;
            }
            case 'view-history': {
              HISTORY_VIEW.open = act.dataset.id;
              STATE.historyConfirmDeleteId = null;
              STATE.activeTab = 'home';
              STATE.historyOpen = false;
              render();
              break;
            }
            case 'close-history':
            case 'close-history-bg': {
              if (act.dataset.action === 'close-history-bg' && !e.target.hasAttribute('data-action')) break;
              HISTORY_VIEW.open = null;
              render();
              break;
            }
            case 'confirm-delete-history': {
              STATE.historyConfirmDeleteId = act.dataset.id;
              render();
              break;
            }
            case 'cancel-delete-history': {
              STATE.historyConfirmDeleteId = null;
              render();
              break;
            }
            case 'confirm-delete-history-yes': {
              deleteHistoryEntry(act.dataset.id);
              STATE.historyConfirmDeleteId = null;
              render();
              break;
            }
            case 'confirm-delete-history-popout': {
              deleteHistoryEntry(act.dataset.id);
              STATE.historyConfirmDeleteId = null;
              HISTORY_VIEW.open = null;
              render();
              showToast('Conversation deleted');
              break;
            }
            case 'copy-answer': {
              const h = STATE.sessionHistory.find(x => x.id === act.dataset.id);
              const pi = parseInt(act.dataset.pair, 10);
              if (!h || !h.pairs[pi]) break;
              copyTextToClipboard(h.pairs[pi].answer || '', act);
              break;
            }
            case 'copy-msg': {
              const slot = STATE.slots[parseInt(act.dataset.slot, 10)];
              const m = slot && slot.messages[parseInt(act.dataset.msg, 10)];
              if (!m || !m.content) break;
              // Plain text, not markdown source — pastes cleanly into
              // chat/email mid-call.
              copyTextToClipboard(stripMarkdown(m.content), act);
              break;
            }
            case 'expand-msg': {
              // "Show more" on a long answer card: reveal the capped bullets.
              const sl = STATE.slots[parseInt(act.dataset.slot, 10)];
              const m = sl && sl.messages[parseInt(act.dataset.msg, 10)];
              if (!m) break;
              m.detailExpanded = true;
              render();
              break;
            }
            case 'show-events': {
              const sl = STATE.slots[parseInt(act.dataset.slot, 10)];
              const m = sl && sl.messages[parseInt(act.dataset.msg, 10)];
              if (!m || !eventsOfferEligible(m)) break;
              m.eventsRequested = true;   // one offer per answer — never re-asks
              const eventsMsg = { role: 'assistant', content: '', kind: 'events', eventsLoading: true, events: [], eventsFallback: '' };
              sl.messages.push(eventsMsg);
              render();
              scrollChat();
              fetchUpcomingEvents(parseInt(act.dataset.slot, 10), m, eventsMsg);
              break;
            }
            case 'dismiss-events': {
              const sl = STATE.slots[parseInt(act.dataset.slot, 10)];
              const m = sl && sl.messages[parseInt(act.dataset.msg, 10)];
              if (m) m.eventsDismissed = true;
              render();
              break;
            }
            case 'clarify-pick': {
              // A tapped clarify option: fold the choice into the pending
              // question and answer it immediately. skipClarify guarantees
              // this send never re-enters the ambiguity check (one round max).
              const si = parseInt(act.dataset.slot, 10);
              const sl = STATE.slots[si];
              const mi = parseInt(act.dataset.msg, 10);
              const m = sl && sl.messages[mi];
              if (!sl || sl.loading || !m || m.kind !== 'clarify') break;
              const option = act.dataset.option || '';
              const pending = m.pendingQuestion || '';
              if (!option || !pending) break;
              // The pick supersedes the clarify prompt — remove it so the
              // thread (and the model context) reads: original question,
              // disambiguated question, answer.
              sl.messages.splice(mi, 1);
              sl.inputText = pending + ' — specifically about ' + option;
              sendMessage(si, { skipClarify: true });
              break;
            }
            case 'noop': break;
            case 'load-history': {
              const hist = STATE.sessionHistory.find(h => h.id === act.dataset.id);
              if (hist) {
                const slot = STATE.slots[0];
                const transcript = hist.pairs.map(p => 'User: ' + p.question + '\nRandy: ' + stripMarkdown(p.answer)).join('\n\n');
                slot.inputText = 'Here is a previous conversation for context:\n\n' + transcript + '\n\nBased on this conversation, ';
                HISTORY_VIEW.open = null;
                STATE.historyOpen = false;
                STATE.activeTab = 'home';
                render();
                scrollChat();
                setTimeout(() => {
                  const inp = document.getElementById('home-input-0');
                  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
                }, 150);
              }
              break;
            }
            case 'reset-slot': {
              const s = STATE.slots[idx !== null ? idx : 0];
              s.prompt = RANDY_PERSONA;
              s.label = 'Randy';
              s.voiceName = 'Randy';
              s.voicePersonality = DEFAULT_VOICE_PERSONALITY;
              s.allowedDomains = DEFAULT_RESEARCH_DOMAINS.slice();
              s.eventDomains = DEFAULT_EVENT_DOMAINS.slice();
              saveSettings(); render(); break;
            }
          }
        });

        // Keep STATE in sync with the composer and patch the send button's
        // disabled state live (a re-render per keystroke would steal focus).
        document.addEventListener('input', e => {
          const syncSendBtn = (sendBtn, slot) => {
            if (!sendBtn || !slot) return;
            const shouldDisable = !!slot.loading || !(slot.inputText || '').trim();
            if (sendBtn.disabled !== shouldDisable) sendBtn.disabled = shouldDisable;
          };
          if (e.target.id === 'expanded-input' && STATE.expandedSlot !== null) {
            const slot = STATE.slots[STATE.expandedSlot];
            slot.inputText = e.target.value;
            syncSendBtn(document.querySelector('[data-action="send-expanded"]'), slot);
          } else if (typeof e.target.id === 'string' && e.target.id.startsWith('home-input-')) {
            const hi = parseInt(e.target.id.slice('home-input-'.length), 10);
            if (!Number.isNaN(hi) && STATE.slots[hi]) {
              STATE.slots[hi].inputText = e.target.value;
              syncSendBtn(document.querySelector('[data-action="send-home"][data-idx="' + hi + '"]'), STATE.slots[hi]);
            }
          } else if (e.target.id === 'history-search') {
            // Filter as you type. render() rebuilds the DOM, so put the
            // focus and caret back where they were.
            STATE.historyQuery = e.target.value;
            const caret = e.target.selectionStart;
            render();
            const si = document.getElementById('history-search');
            if (si) { si.focus(); try { si.setSelectionRange(caret, caret); } catch {} }
          }
        });

        document.addEventListener('keydown', e => {
          // Enter in either onboarding field submits the one-time name screen.
          if (e.key === 'Enter' && (e.target.id === 'onb-first' || e.target.id === 'onb-last')) {
            e.preventDefault();
            document.querySelector('[data-action="save-onboarding"]')?.click();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'expanded-input' && STATE.expandedSlot !== null) {
            e.preventDefault();
            STATE.slots[STATE.expandedSlot].inputText = e.target.value;
            sendMessage(STATE.expandedSlot);
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && typeof e.target.id === 'string' && e.target.id.startsWith('home-input-')) {
            e.preventDefault();
            const hi = parseInt(e.target.id.slice('home-input-'.length), 10);
            if (!Number.isNaN(hi) && STATE.slots[hi]) {
              STATE.slots[hi].inputText = e.target.value;
              sendMessage(hi);
            }
            return;
          }
          // Space/Enter activate the toggle switches (they're divs with role=switch).
          if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'switch') {
            e.preventDefault();
            e.target.click();
            return;
          }
          // ...and the div-based buttons (saved-conversation items, history rail).
          if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute &&
              e.target.getAttribute('role') === 'button' && e.target.dataset && e.target.dataset.action) {
            e.preventDefault();
            e.target.click();
            return;
          }
          if (e.key === 'Escape' && STATE.audioChooserOpen) {
            closeAudioChooser();
            return;
          }
          if (e.key === 'Escape' && e.target.id === 'history-search') {
            STATE.historyQuery = '';
            render();
            return;
          }
          if (e.key === 'Escape' && HISTORY_VIEW.open) {
            HISTORY_VIEW.open = null; render();
          }
        });
      }

      function readFields() {
        const i = STATE.editingSlot;
        const s = STATE.slots[i];
        const l = document.getElementById('setting-label');
        const p = document.getElementById('setting-prompt');
        const dm = document.getElementById('setting-domains');
        if (l) s.label = l.value.trim() || s.label;
        if (p) s.prompt = p.value.trim() || s.prompt;
        // The wake-word field is gone; keep voiceName (the hero/display name)
        // in sync with the display name so renaming Randy still works.
        s.voiceName = s.label;
        if (dm) {
          s.allowedDomains = dm.value.split('\n').map(x => x.trim()).filter(Boolean);
        }
        const ed = document.getElementById('setting-event-domains');
        if (ed) {
          s.eventDomains = ed.value.split('\n').map(x => x.trim()).filter(Boolean);
        }
      }

      /* ================================================================
       * BOOT
       * ================================================================ */

      // The normal-tool boot side-effects. Deferred until onboarding is complete
      // so the mic and the first API call never fire behind the name screen.
      // Runs exactly once per panel open.
      let _mainStarted = false;
      function startMainApp() {
        if (_mainStarted) return;
        _mainStarted = true;
        loadRemoteConfig().then(render);
        // Re-render once the browser loads its speech voice list (async in Chrome).
        if (VOICE.ttsSupported && typeof speechSynthesis.onvoiceschanged !== 'undefined') {
          window.speechSynthesis.onvoiceschanged = () => {
            if (STATE.activeTab === 'settings') render();
          };
        }
        // Auto-launch the mic on open. One-way (mic only) needs no screen-share
        // prompt, so Randy starts listening the moment the panel opens — the user
        // never picks a mic. Two-way / computer-audio capture stays opt-in from
        // Settings (its share picker needs a click). autoStartListening() retries
        // through the transient capture failures that can happen right as the
        // panel appears, so Randy reliably comes up listening on every open.
        if (VOICE.srSupported) {
          setTimeout(() => { try { autoStartListening(); } catch {} }, 250);
        }
        // Auto-arm highlight capture on open too, so highlighting text on the
        // page (e.g. while copying something) goes straight to Randy — the
        // button still lets the user turn it off.
        setTimeout(() => { try { autoArmSelectionCapture(); } catch {} }, 600);
      }

      function boot() {
        // Fast path: a synchronous localStorage hint says this install already
        // finished onboarding, so render the normal tool and start listening
        // IMMEDIATELY — identical to the original boot, with no wait on the async
        // chrome.storage read. (That wait was the reload glitch: a flashed frame
        // and a delayed mic auto-start every time.)
        if (readOnboardedHint()) {
          render();
          startMainApp();
        } else {
          render(); // blank panel until identity resolves, then onboarding/tool
        }
        // Always load the real id + name (the source of truth). On the fast path
        // the id lands in the background, well before any API call; on a first
        // run this decides whether we show onboarding or the tool. If the hint
        // was stale (id/name actually gone), this corrects the view. startMainApp
        // is guarded so it never runs twice.
        ensureIdentity().then(() => {
          render();
          if (onboardingComplete()) startMainApp();
        });
      }

      // Run boot once the DOM is ready. The script is the last element in the
      // body, so DOMContentLoaded normally hasn't fired yet — but if this ever
      // executes after the DOM is already parsed, addEventListener would never
      // fire and Randy would never come up. Guard on readyState so boot always
      // runs exactly once, on every open.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
