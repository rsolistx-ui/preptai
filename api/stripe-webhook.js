import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(Buffer.from(data)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    // --- SOMEONE JUST PAID ---
    if (event.type === "customer.subscription.created") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;

      const priceId = subscription.items.data[0].price.id;

      let plan = "pro";
      if (priceId === process.env.STRIPE_CAREER_PRICE_ID) {
        plan = "career";
      }

      await supabase.from("subscribers").upsert({
        email,
        stripe_customer_id: customerId,
        plan,
      });

      console.log(`Upgraded ${email} to ${plan}`);
    }

    // --- SOMEONE CANCELLED OR PAYMENT FAILED ---
    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "invoice.payment_failed"
    ) {
      const subscription = event.data.object;
      const customerId =
        event.type === "invoice.payment_failed"
          ? event.data.object.customer
          : subscription.customer;

      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;

      await supabase
        .from("subscribers")
        .update({ plan: "free" })
        .eq("email", email);

      console.log(`Downgraded ${email} to free`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
