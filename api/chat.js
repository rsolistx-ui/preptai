import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Free tier limits — enforced server side
const FREE_LIMITS = { chat: 3, match: 1 };

// Rate limit — max requests per IP per hour regardless of plan
const RATE_LIMIT = 60;

// Simple in-memory IP rate limiter (resets on Vercel cold start)
const ipCounts = new Map();

function checkIPRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const entry = ipCounts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  ipCounts.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// Get current month usage for a user from Supabase
async function getMonthlyUsage(email, type) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from("usage")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("type", type)
    .gte("created_at", startOfMonth.toISOString());

  if (error) {
    console.error("Usage check error:", error);
    return 0;
  }
  return count || 0;
}

// Log usage to Supabase
async function logUsage(email, type) {
  await supabase.from("usage").insert({ email, type });
}

// Sanitize input — strip anything suspicious
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .slice(0, 8000) // max length
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "") // no script tags
    .replace(/javascript:/gi, "") // no js protocol
    .trim();
}

// Validate the message doesn't contain prompt injection attempts
function detectPromptInjection(text) {
  const injectionPatterns = [
    /ignore (all |previous |above |prior )?instructions/i,
    /you are now/i,
    /forget (everything|all|your instructions)/i,
    /act as (a |an )?(?!interviewer|job|career)/i,
    /new personality/i,
    /jailbreak/i,
    /dan mode/i,
    /system prompt/i,
  ];
  return injectionPatterns.some((pattern) => pattern.test(text));
}

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "https://preptai.co");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-count");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── IP rate limiting ───────────────────────────────────────────────────────
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkIPRateLimit(ip)) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Please wait a moment before trying again.",
    });
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { message, mode, userEmail } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  if (!mode || !["chat", "match"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }

  const cleanMessage = sanitize(message);
  const cleanEmail = userEmail ? sanitize(userEmail).toLowerCase() : null;

  if (!cleanMessage) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  // ── Prompt injection detection ─────────────────────────────────────────────
  if (detectPromptInjection(cleanMessage)) {
    return res.status(400).json({
      error: "invalid_input",
      message: "Your message contains content that cannot be processed.",
    });
  }

  // ── Subscription check ─────────────────────────────────────────────────────
  let plan = "free";

  if (cleanEmail) {
    const { data: subscriber } = await supabase
      .from("subscribers")
      .select("plan")
      .eq("email", cleanEmail)
      .single();

    if (subscriber?.plan) {
      plan = subscriber.plan;
    }
  }

  // ── Server-side free tier enforcement ─────────────────────────────────────
  if (plan === "free") {
    if (!cleanEmail) {
      // Not logged in — allow only 1 anonymous request then block
      return res.status(403).json({
        error: "login_required",
        message: "Please create a free account to use PREPT AI.",
        loginUrl: "/login.html",
      });
    }

    const usage = await getMonthlyUsage(cleanEmail, mode);
    const limit = FREE_LIMITS[mode];

    if (usage >= limit) {
      return res.status(403).json({
        error: "free_limit_reached",
        message: `You have used all ${limit} free ${mode === "match" ? "resume analyses" : "interview questions"} this month. Upgrade to Pro to continue.`,
        upgradeUrl: "https://preptai.co/#pricing",
        remaining: 0,
      });
    }
  }

  // ── Call Anthropic API ─────────────────────────────────────────────────────
  try {
    const systemPrompt =
      mode === "match"
        ? "You are PREPT AI Match, an expert ATS resume optimizer. Analyze resumes against job descriptions, identify keyword gaps, score ATS compatibility, and provide specific rewrites. Be precise, actionable, and professional."
        : "You are PREPT AI Live, an expert interview coach providing real-time coaching during job interviews. Give confident, natural-sounding answers the user can speak aloud. Use STAR method for behavioral questions. Keep answers 80-130 words — about 30-60 seconds when spoken.";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: cleanMessage }],
    });

    const answer = response.content[0]?.text;

    if (!answer) throw new Error("No response from AI");

    // ── Log usage after successful response ──────────────────────────────────
    if (cleanEmail) {
      await logUsage(cleanEmail, mode);
    }

    // ── Get remaining count ──────────────────────────────────────────────────
    let remaining = "unlimited";
    if (plan === "free" && cleanEmail) {
      const used = await getMonthlyUsage(cleanEmail, mode);
      remaining = Math.max(0, FREE_LIMITS[mode] - used);
    }

    return res.status(200).json({ answer, plan, remaining });

  } catch (error) {
    console.error("Anthropic API error:", error);

    if (error.status === 429) {
      return res.status(429).json({
        error: "ai_rate_limited",
        message: "AI service is busy. Please try again in a moment.",
      });
    }

    return res.status(500).json({
      error: "ai_error",
      message: "Something went wrong. Please try again.",
    });
  }
}
