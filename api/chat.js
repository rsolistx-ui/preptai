// api/chat.js — PREPT AI — Full coaching engine with job description, follow-up challenge, and thank-you email
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── USAGE LIMITS ──────────────────────────────────────────────────────────────
const FREE_LIMITS   = { chat: 3,   match: 1  };
const PRO_LIMITS    = { chat: 200, match: 999 };
const CAREER_LIMITS = { chat: 400, match: 999 };

// followup and thankyou count against the chat bucket
function getLimitKey(mode) {
  return ["chat","followup","thankyou"].includes(mode) ? "chat" : "match";
}

// ── IP RATE LIMIT ─────────────────────────────────────────────────────────────
const ipCounts = new Map();
function checkIPRateLimit(ip) {
  const now     = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry   = ipCounts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  ipCounts.set(ip, entry);
  return entry.count <= 60;
}

// ── MONTHLY USAGE ─────────────────────────────────────────────────────────────
async function getMonthlyUsage(email, limitKey) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const types = limitKey === "chat" ? ["chat","followup","thankyou"] : ["match"];
  const { count, error } = await supabase
    .from("usage")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .in("type", types)
    .gte("created_at", startOfMonth.toISOString());
  if (error) { console.error("Usage check error:", error); return 0; }
  return count || 0;
}

async function logUsage(email, mode) {
  await supabase.from("usage").insert({ email, type: mode });
}

// ── INPUT SANITIZATION ────────────────────────────────────────────────────────
function sanitize(str, maxLen = 8000) {
  if (typeof str !== "string") return "";
  return str.slice(0, maxLen)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

function detectPromptInjection(text) {
  const patterns = [
    /ignore (all |previous |above |prior )?instructions/i,
    /you are now/i,
    /forget (everything|all|your instructions)/i,
    /jailbreak/i,
    /dan mode/i,
    /override (your |all )?instructions/i,
    /disregard (your |all )?instructions/i,
  ];
  return patterns.some(p => p.test(text));
}

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────

const STYLE_GUIDES = {
  star:      "STAR Method: Structure every behavioral answer as Situation → Task → Action → Result. Lead with a 1-sentence context hook. End with a quantified result and a forward-looking reflection that signals growth.",
  concise:   "Concise & Direct: No filler, no preamble. Answer the core of the question in 2-3 focused sentences, then support with one concrete example. Decision-makers at senior levels respond best to this format.",
  story:     "Narrative Arc: Open with a compelling scene or moment that puts the interviewer in the room with you. Build tension naturally, then resolve it with a clear outcome. The best stories make interviewers lean in.",
  technical: "Technical Depth: Lead with your methodology or framework, walk through your technical decision-making process, quantify outcomes where possible. Show you think in systems, not just solutions.",
  executive: "Executive Presence: Speak at the business impact level. Frame everything in terms of strategy, team outcomes, and organizational value. Use the language of priorities, trade-offs, and stakeholder alignment."
};

function buildCoachingPrompt(sector, role, company, style, resumeText, jobDescription) {
  const resumeSection = resumeText
    ? `\n\nCANDIDATE RESUME (pull specific details — job titles, companies, accomplishments, skills — never use generic placeholders):\n${resumeText}`
    : "";
  const jobSection = jobDescription
    ? `\n\nACTUAL JOB DESCRIPTION (tailor every answer to match the keywords, requirements, and priorities in this posting — this is the exact role):\n${jobDescription}`
    : "";

  return `You are PREPT AI, the world's most advanced interview coaching engine. You operate at the intersection of behavioral psychology, hiring science, and executive communication.

YOUR CORE MISSION: Generate the single best answer a candidate could give to this interview question — not a template, not a placeholder, not generic advice. A real, complete, speakable answer they can use right now.

CANDIDATE CONTEXT:
- Industry/Sector: ${sector || "General"}
- Role they are interviewing for: ${role || "not specified — assume a professional mid-to-senior level role"}
- Company: ${company || "not specified"}
- Answer framework: ${STYLE_GUIDES[style] || STYLE_GUIDES.star}${resumeSection}${jobSection}

THE SCIENCE BEHIND WHAT INTERVIEWERS ACTUALLY EVALUATE:
Research from Google's hiring studies, McKinsey's interview design, and meta-analyses of hiring outcomes shows interviewers simultaneously evaluate five things:
1. SIGNAL CLARITY — Can this person communicate complex ideas simply and confidently?
2. EVIDENCE QUALITY — Do they give specific, verifiable examples (not vague generalities)?
3. SELF-AWARENESS — Do they show genuine insight into their strengths, gaps, and growth?
4. CULTURAL ALIGNMENT — Does their values language match what this organization prioritizes?
5. FORWARD ORIENTATION — Do they frame past experiences in terms of what they learned and where they're going?

HOW TO BUILD THE ANSWER:
${resumeText
  ? "- Pull SPECIFIC details from the candidate's resume: job titles, companies, accomplishments, skills, dates. Never use [brackets] or placeholders."
  : "- No resume provided — write a strong, specific-sounding answer using realistic professional details that fit the role and industry. Make it feel personal, not generic."}
${jobDescription
  ? "- Mirror the language and priorities from the job description. Match their keywords naturally. Interviewers notice when candidates use the same language from the posting."
  : ""}
- Open with a confident, direct sentence — no preamble like 'Great question' or 'That's something I've thought a lot about'
- Use one concrete, specific example with real-world texture (a project, a decision, a moment of conflict or leadership)
- Include at least one quantified outcome when possible (%, $, timeframe, team size, scale)
- Close with a sentence that connects the past experience to why it makes them the right person for THIS role
- Length: 100-140 words — the research-validated sweet spot (long enough to show depth, short enough to hold attention)

AFTER THE ANSWER, ADD:
💡 Coaching tip: [One specific, tactical delivery note — e.g. a word to emphasize, a pause to take, a detail to add if they have time, or how to handle a likely follow-up]

CRITICAL RULES:
- Never use [brackets], [your name], [X years], or ANY placeholder text. Ever.
- Never start with "I'd be happy to..." or "Great question" or any AI preamble
- Never suggest the candidate "fill in" details — you provide the details
- The answer must be immediately speakable, word for word, right now`;
}

function buildFollowUpPrompt(sector, role, company, resumeText, jobDescription) {
  const resumeSection = resumeText     ? `\nCANDIDATE RESUME:\n${resumeText}`     : "";
  const jobSection    = jobDescription ? `\nJOB DESCRIPTION:\n${jobDescription}` : "";

  return `You are PREPT AI, a world-class interview coach specializing in pressure testing — exposing the follow-up questions that separate candidates who truly know their material from those who gave a rehearsed surface answer.

WHAT YOU DO:
The candidate just answered an interview question. Your job is to:

1. FOLLOW-UP CHALLENGE: Generate the single sharpest follow-up question a skilled interviewer would ask next — the one designed to probe deeper, test consistency, or uncover whether the answer was truly substantive. Think like a McKinsey interviewer or a top-tier tech hiring manager who has heard thousands of rehearsed answers. Make it specific to what was just said. Phrase it exactly as the interviewer would say it out loud in the room.

2. COACHED RESPONSE: Provide the ideal answer to that follow-up. Same rules — specific, speakable, no placeholders, 80-110 words, grounded in the candidate's actual background if resume is available.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — no deviation:
⚡ Follow-up: [the follow-up question, phrased as the interviewer would say it]

[coached answer to the follow-up — start immediately, no label]

💡 Coaching tip: [one tactical note on delivery or what to watch out for]

CANDIDATE CONTEXT:
- Sector: ${sector || "General"}
- Role: ${role || "professional role"}
- Company: ${company || "not specified"}${resumeSection}${jobSection}

CRITICAL: The follow-up must feel like a real, sharp interviewer asking it — not an AI generating a question. Never use placeholders in the coached response.`;
}

function buildThankYouPrompt() {
  return `You are PREPT AI, an expert in post-interview communication strategy.

Your job: Write a perfect post-interview thank-you email based on the details the candidate provides. This email must:

1. Open with a warm but professional expression of gratitude — specific to this interview, not generic
2. Reference ONE specific thing discussed in the interview to show genuine engagement and reinforce fit
3. Reinforce the candidate's single strongest qualification for this role — one confident sentence, not desperate
4. Close with a clear, professional forward-looking sentence — confident, not pushy
5. Total length: 4 short paragraphs, under 150 words. Tight, polished, human.

OUTPUT FORMAT — respond with exactly this structure:
Subject: [subject line]

[email body — 4 paragraphs]

RULES:
- Never open with "I wanted to reach out" or "I hope this email finds you well" — start strong and specific
- No groveling, no over-thanking, no "I would be honored to..."
- Sound like a confident professional, not someone desperate for the job
- Make it personal and specific using the details provided — not a template
- If the candidate doesn't provide the interviewer's name, use "Hi [Name]," as a placeholder only in that one spot
- Every other detail in the email must be specific and real based on what the candidate shares`;
}

function buildMatchPrompt() {
  return `You are PREPT AI Match, a precision ATS resume optimization engine.

Your job: Analyze the resume against the job description with surgical accuracy. Return:

1. ATS COMPATIBILITY SCORE (0-100) with specific explanation
2. MISSING KEYWORDS — exact phrases from the job description not found in the resume, ranked by impact
3. WEAK PHRASES TO REWRITE — paste the original line, then provide the optimized version with stronger action verbs and quantified impact
4. SECTION-BY-SECTION AUDIT — Professional Summary, Work Experience, Skills, Education
5. TOP 3 PRIORITY FIXES — the three changes with the highest immediate impact on ATS scoring and recruiter attention

Be specific, be direct, prioritize ruthlessly. This person's career advancement depends on getting this right.`;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "https://preptai.co");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-count");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  if (!checkIPRateLimit(ip)) {
    return res.status(429).json({ error: "rate_limited", message: "Too many requests. Please wait before trying again." });
  }

  const { message, mode, userEmail, sector, role, company, style, resumeText, jobDescription } = req.body;

  const validModes = ["chat","match","followup","thankyou"];
  if (!message || typeof message !== "string") return res.status(400).json({ error: "Message is required" });
  if (!mode || !validModes.includes(mode))       return res.status(400).json({ error: "Invalid mode" });

  const cleanMessage  = sanitize(message);
  const cleanEmail    = userEmail      ? sanitize(userEmail).toLowerCase() : null;
  const cleanSector   = sector         ? sanitize(sector, 100)             : "General";
  const cleanRole     = role           ? sanitize(role, 200)               : "";
  const cleanCompany  = company        ? sanitize(company, 200)            : "";
  const cleanStyle    = ["star","concise","story","technical","executive"].includes(style) ? style : "star";
  const cleanResume   = resumeText     ? sanitize(resumeText, 6000)        : "";
  const cleanJobDesc  = jobDescription ? sanitize(jobDescription, 4000)    : "";

  if (!cleanMessage) return res.status(400).json({ error: "Message cannot be empty" });
  if ([cleanMessage, cleanResume, cleanJobDesc].filter(Boolean).some(f => detectPromptInjection(f))) {
    return res.status(400).json({ error: "invalid_input", message: "Your message contains content that cannot be processed." });
  }

  // Get plan
  let plan = "free";
  if (cleanEmail) {
    const { data: subscriber } = await supabase
      .from("subscribers").select("plan").eq("email", cleanEmail).single();
    if (subscriber?.plan) plan = subscriber.plan;
  }

  const limitKey = getLimitKey(mode);
  const limits   = { free: FREE_LIMITS, pro: PRO_LIMITS, career: CAREER_LIMITS }[plan] || FREE_LIMITS;

  if (plan === "free") {
    if (!cleanEmail) {
      return res.status(403).json({ error: "login_required", message: "Please create a free account to use PREPT AI.", loginUrl: "/login.html" });
    }
    const usage = await getMonthlyUsage(cleanEmail, limitKey);
    if (usage >= limits[limitKey]) {
      return res.status(403).json({
        error: "free_limit_reached",
        message: `You have used all ${limits[limitKey]} free ${limitKey === "match" ? "resume analyses" : "coaching sessions"} this month. Upgrade to Pro to continue.`,
        upgradeUrl: "https://preptai.co/#pricing",
        remaining: 0,
      });
    }
  }

  if (plan === "pro" && cleanEmail) {
    const usage = await getMonthlyUsage(cleanEmail, limitKey);
    if (usage >= limits[limitKey]) {
      return res.status(403).json({ error: "pro_limit_reached", message: "You have reached your monthly limit. This resets on the 1st of next month.", upgradeUrl: "https://preptai.co/#pricing" });
    }
  }

  if (plan === "career" && cleanEmail) {
    const usage = await getMonthlyUsage(cleanEmail, limitKey);
    if (usage >= limits[limitKey]) {
      return res.status(403).json({ error: "career_limit_reached", message: "You have reached your monthly limit. This resets on the 1st of next month." });
    }
  }

  // Build system prompt
  let systemPrompt;
  if      (mode === "match")    systemPrompt = buildMatchPrompt();
  else if (mode === "followup") systemPrompt = buildFollowUpPrompt(cleanSector, cleanRole, cleanCompany, cleanResume, cleanJobDesc);
  else if (mode === "thankyou") systemPrompt = buildThankYouPrompt();
  else                          systemPrompt = buildCoachingPrompt(cleanSector, cleanRole, cleanCompany, cleanStyle, cleanResume, cleanJobDesc);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: cleanMessage }],
    });

    const answer = response.content[0]?.text;
    if (!answer) throw new Error("No response from AI");

    if (cleanEmail) await logUsage(cleanEmail, mode);

    let remaining = "unlimited";
    if (plan === "free" && cleanEmail) {
      const used = await getMonthlyUsage(cleanEmail, limitKey);
      remaining = Math.max(0, limits[limitKey] - used);
    }

    return res.status(200).json({ answer, plan, remaining });

  } catch (error) {
    console.error("Anthropic API error:", error);
    if (error.status === 429) {
      return res.status(429).json({ error: "ai_rate_limited", message: "AI service is busy. Please try again in a moment." });
    }
    return res.status(500).json({ error: "ai_error", message: "Something went wrong. Please try again." });
  }
}
