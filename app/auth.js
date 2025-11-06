// app/auth.js
// Robust email+password auth with safe redirect to /home.html

import { CONFIG } from "./config.js";

// Try to load whatever your supabase wrapper exports
let supaMod = {};
try {
  supaMod = await import("./supabase.js");
} catch (e) {
  console.warn("supabase.js import failed:", e);
}

// Accept any of these forms: {supabase}, default, or helper functions
const supabase =
  supaMod.supabase ||          // named export
  supaMod.default ||           // default export
  null;

// ---------- helpers ----------
const qs = new URLSearchParams(location.search);
const qEmail = qs.get("email") || "";
const qPassword = qs.get("password") || "";

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
const $ = (sel, root = document) => root.querySelector(sel);
const setText = (n, t) => { if (n) n.textContent = t; };

// Normalize “get current session” across wrappers
async function fetchSession() {
  try {
    // If your module exposes a helper:
    if (typeof supaMod.getSession === "function") {
      const r = await supaMod.getSession();
      // Accept either {data:{session}} or {session}
      const session = r?.data?.session ?? r?.session ?? null;
      return session;
    }
    // Or use the raw client:
    if (supabase?.auth?.getSession) {
      const r = await supabase.auth.getSession();
      return r?.data?.session ?? null;
    }
  } catch (e) {
    console.warn("fetchSession error:", e);
  }
  return null;
}

async function signInWithPassword(email, password) {
  if (typeof supaMod.signInWithPassword === "function") {
    await supaMod.signInWithPassword(email, password);
    return;
  }
  if (!supabase) throw new Error("Supabase client not available.");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signUpWithPassword(email, password) {
  if (typeof supaMod.signUpWithPassword === "function") {
    await supaMod.signUpWithPassword(email, password);
    return;
  }
  if (!supabase) throw new Error("Supabase client not available.");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

async function redirectIfLoggedIn() {
  const session = await fetchSession();
  if (session) {
    location.replace("/home.html");
    return true;
  }
  return false;
}

// ---------- UI ----------
const app = $("#auth-app");
app.classList.add("auth-wrap");
app.innerHTML = "";

const card = el(`
  <section class="home-card" style="max-width:520px">
    <h2 class="home-title" id="auth-title">Sign in</h2>
    <p class="muted tiny" style="text-align:center;margin-top:-6px">
      Use your email &amp; password to continue.
    </p>

    <form id="auth-form" class="auth-form" autocomplete="on" style="margin-top:14px">
      <label class="muted tiny">Email</label>
      <div class="prompt-row" style="margin-top:6px">
        <input id="email" class="input" type="email" placeholder="you@domain.com" required autocomplete="email">
      </div>

      <label class="muted tiny" style="margin-top:10px">Password</label>
      <div class="prompt-row" style="margin-top:6px">
        <input id="password" class="input" type="password" placeholder="Password" required autocomplete="current-password">
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:10px">
        <button id="mode-toggle" type="button" class="link-btn" style="border-style:dashed">Create an account</button>
        <button id="submit-btn" class="btn btn-primary">Sign in</button>
      </div>

      <p id="auth-status" class="muted tiny" style="min-height:18px;margin-top:10px;text-align:center;"></p>
      <p class="muted tiny" style="text-align:center;margin-top:8px">powered by Son of Wisdom</p>
    </form>
  </section>
`);
app.appendChild(card);

const titleEl  = $("#auth-title", card);
const formEl   = $("#auth-form", card);
const emailEl  = $("#email", card);
const passEl   = $("#password", card);
const toggleEl = $("#mode-toggle", card);
const submitEl = $("#submit-btn", card);
const statusEl = $("#auth-status", card);

// Prefill from query, if provided
emailEl.value = qEmail;
passEl.value  = qPassword;

// Mode handling
let mode = "signin";
function setMode(m) {
  mode = m;
  setText(titleEl, mode === "signin" ? "Sign in" : "Create account");
  setText(submitEl, mode === "signin" ? "Sign in" : "Sign up");
  setText(toggleEl, mode === "signin" ? "Create an account" : "Have an account? Sign in");
}
toggleEl.addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
setMode("signin");

// If already logged-in, go straight to home
await redirectIfLoggedIn();

// Submit handler
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitEl.disabled = true;
  setText(statusEl, "");

  const email = emailEl.value.trim();
  const pass  = passEl.value;

  try {
    if (!email || !pass) throw new Error("Please enter your email and password.");
    if (mode === "signin") {
      setText(statusEl, "Signing in…");
      await signInWithPassword(email, pass);
    } else {
      setText(statusEl, "Creating your account…");
      await signUpWithPassword(email, pass);
    }

    // Either way, go to home on success
    setText(statusEl, "Success. Redirecting…");
    location.replace("/home.html");

  } catch (err) {
    console.error(err);
    setText(statusEl, err?.message || "Authentication failed.");
  } finally {
    submitEl.disabled = false;
  }
});

// Enter to submit
[emailEl, passEl].forEach((input) =>
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") formEl.requestSubmit();
  })
);
