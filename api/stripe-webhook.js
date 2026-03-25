import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(Buffer.from(data)));
    req.on("error", reject);
  });
}

// Validate email format
function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  // Only Stripe should be calling this endpoint
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    console.error("Missing Stripe signature");
    return res.status(400).json({ error: "Missing signature" });
  }

  // ── Verify the webhook is genuinely from Stripe ───────────────────────────
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    // Return 400 so Stripe knows to retry
    return res.status(400).json({ error: "Invalid signature" });
  }

  // ── Only process events we care about ─────────────────────────────────────
  const allowedEvents = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "customer.subscription.trial_will_end",
  ];

  if (!allowedEvents.includes(event.type)) {
    // Acknowledge but ignore other events
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    // ── SUBSCRIPTION CREATED OR UPDATED ─────────────────────────────────────
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const status = subscription.status;

      // Only activate for active or trialing subscriptions
      if (!["active", "trialing"].includes(status)) {
        console.log(`Subscription ${subscription.id} is ${status} — skipping`);
        return res.status(200).json({ received: true });
      }

      const customer = await stripe.customers.retrieve(customerId);

      if (!customer || customer.deleted) {
        console.error("Customer not found or deleted:", customerId);
        return res.status(200).json({ received: true });
      }

      const email = customer.email;

      if (!isValidEmail(email)) {
        console.error("Invalid email for customer:", customerId);
        return res.status(200).json({ received: true });
      }

      const priceId = subscription.items.data[0]?.price?.id;
      let plan = "pro";
      if (priceId === process.env.STRIPE_CAREER_PRICE_ID) {
        plan = "career";
      }

      const { error } = await supabase.from("subscribers").upsert(
        { email, stripe_customer_id: customerId, plan },
        { onConflict: "email" }
      );

      if (error) {
        console.error("Supabase upsert error:", error);
        return res.status(500).json({ error: "Database error" });
      }

      console.log(`✓ Upgraded ${email} to ${plan} (${status})`);
    }

    // ── SUBSCRIPTION CANCELLED ───────────────────────────────────────────────
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const customer = await stripe.customers.retrieve(customerId);
      const email = customer?.email;

      if (!isValidEmail(email)) {
        return res.status(200).json({ received: true });
      }

      const { error } = await supabase
        .from("subscribers")
        .update({ plan: "free", stripe_customer_id: customerId })
        .eq("email", email);

      if (error) console.error("Supabase update error:", error);
      console.log(`✓ Downgraded ${email} to free (cancelled)`);
    }

    // ── PAYMENT FAILED ───────────────────────────────────────────────────────
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const customer = await stripe.customers.retrieve(customerId);
      const email = customer?.email;

      if (!isValidEmail(email)) {
        return res.status(200).json({ received: true });
      }

      // Give a grace period — Stripe retries automatically
      // Only downgrade after 3 failed attempts (Stripe handles this)
      const attemptCount = invoice.attempt_count || 1;
      if (attemptCount >= 3) {
        await supabase
          .from("subscribers")
          .update({ plan: "free" })
          .eq("email", email);
        console.log(`✓ Downgraded ${email} to free (payment failed x${attemptCount})`);
      } else {
        console.log(`Payment failed for ${email} (attempt ${attemptCount}) — keeping plan active`);
      }
    }

    // ── TRIAL ENDING SOON ────────────────────────────────────────────────────
    if (event.type === "customer.subscription.trial_will_end") {
      // Stripe sends this 3 days before trial ends
      // You could trigger an email here in future
      console.log("Trial ending soon for subscription:", event.data.object.id);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Webhook processing error:", error);
    // Return 500 so Stripe retries
    return res.status(500).json({ error: "Processing failed" });
  }
}
