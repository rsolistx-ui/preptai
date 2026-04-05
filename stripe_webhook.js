// api/stripe_webhook.js — PREPT AI
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Raw body error:", err);
    return res.status(400).json({ error: "Could not read body" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).json({ error: "Missing stripe-signature" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  const allowed = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "customer.subscription.trial_will_end",
  ];

  if (!allowed.includes(event.type)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    if (["customer.subscription.created", "customer.subscription.updated"].includes(event.type)) {
      const sub = event.data.object;
      if (!["active", "trialing"].includes(sub.status)) return res.status(200).json({ received: true });
      const customer = await stripe.customers.retrieve(sub.customer);
      if (!customer || customer.deleted) return res.status(200).json({ received: true });
      const email = customer.email;
      if (!isValidEmail(email)) return res.status(200).json({ received: true });
      const priceId = sub.items.data[0]?.price?.id;
      const plan = priceId === process.env.STRIPE_CAREER_PRICE_ID ? "career" : "pro";
      const { error } = await supabase
        .from("subscribers")
        .upsert({ email, stripe_customer_id: sub.customer, plan }, { onConflict: "email" });
      if (error) throw new Error("Supabase error: " + error.message);
      console.log(`Upgraded ${email} to ${plan}`);
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      const email = customer?.email;
      if (!isValidEmail(email)) return res.status(200).json({ received: true });
      await supabase.from("subscribers").update({ plan: "free" }).eq("email", email);
      console.log(`Downgraded ${email} to free`);
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      if (!invoice.subscription) return res.status(200).json({ received: true });
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      const customer = await stripe.customers.retrieve(invoice.customer);
      const email = customer?.email;
      if (!isValidEmail(email)) return res.status(200).json({ received: true });
      const priceId = sub.items.data[0]?.price?.id;
      const plan = priceId === process.env.STRIPE_CAREER_PRICE_ID ? "career" : "pro";
      await supabase
        .from("subscribers")
        .upsert({ email, stripe_customer_id: invoice.customer, plan }, { onConflict: "email" });
      console.log(`Payment succeeded — ${email} confirmed on ${plan}`);
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customer = await stripe.customers.retrieve(invoice.customer);
      const email = customer?.email;
      if (!isValidEmail(email)) return res.status(200).json({ received: true });
      if ((invoice.attempt_count || 1) >= 3) {
        await supabase.from("subscribers").update({ plan: "free" }).eq("email", email);
        console.log(`Downgraded ${email} to free — payment failed 3x`);
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Processing failed" });
  }
}
