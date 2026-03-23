import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, email, password } = req.body;

  if (!action || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {

    // --- SIGN UP ---
    if (action === "signup") {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (error) {
        if (error.message.includes("already registered")) {
          return res.status(400).json({
            error: "An account with this email already exists. Try logging in.",
          });
        }
        throw error;
      }

      // Add them to subscribers table as free user
      await supabase.from("subscribers").upsert({
        email,
        plan: "free",
      });

      return res.status(200).json({
        success: true,
        message: "Account created. Welcome to PREPT AI.",
        user: { email: data.user.email },
      });
    }

    // --- LOG IN ---
    if (action === "login") {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(401).json({
          error: "Incorrect email or password. Please try again.",
        });
      }

      // Get their subscription plan
      const { data: subscriber } = await supabase
        .from("subscribers")
        .select("plan")
        .eq("email", email)
        .single();

      const plan = subscriber?.plan || "free";

      return res.status(200).json({
        success: true,
        user: {
          email: data.user.email,
          plan,
        },
        session: data.session,
      });
    }

    // --- LOG OUT ---
    if (action === "logout") {
      return res.status(200).json({
        success: true,
        message: "Logged out successfully.",
      });
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (error) {
    console.error("Auth error:", error);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
    });
  }
}
