// app/auth.js
import supabase from "./supabase.js";

/**
 * Safe element refs (won’t throw if a selector is missing).
 */
const $ = (sel) => document.querySelector(sel);

const els = {
  wrap: $(".auth-wrap") || $("#auth-app") || document.body,
  form: $("#auth-form"),
  email: $("#email"),
  password: $("#password"),
  signInBtn: $("#signin-btn"),
  createBtn: $("#create-btn"),
  toast: $("#toast"), // optional helper; falls back to alert
};

function toast(msg) {
  if (els.toast) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), 3500);
  } else {
    // Keep going even if there’s no toast element
    console.warn("[auth] ", msg);
    alert(msg);
  }
}

function setBusy(isBusy) {
  if (els.wrap) {
    els.wrap.classList.toggle("busy", isBusy);
  }
  if (els.signInBtn) els.signInBtn.disabled = isBusy;
  if (els.createBtn) els.createBtn.disabled = isBusy;
}

/**
 * Redirect to home if already logged in.
 */
async function redirectIfLoggedIn() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error("[auth] getSession error:", error);
    return;
  }
  if (data?.session) {
    window.location.replace("home.html");
  }
}

/**
 * Sign in with email/password.
 */
async function doSignIn() {
  const email = els.email?.value?.trim();
  const password = els.password?.value || "";

  if (!email || !password) {
    toast("Please enter your email and password.");
    return;
  }

  setBusy(true);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  setBusy(false);

  if (error) {
    toast(error.message || "Sign-in failed.");
    return;
  }

  // Success → go to home
  window.location.replace("home.html");
}

/**
 * Create account (email/password).
 */
async function doCreate() {
  const email = els.email?.value?.trim();
  const password = els.password?.value || "";

  if (!email || !password) {
    toast("Please enter your email and password.");
    return;
  }

  setBusy(true);
  const { data, error } = await supabase.auth.signUp({ email, password });
  setBusy(false);

  if (error) {
    toast(error.message || "Sign-up failed.");
    return;
  }

  toast("Check your email to confirm your account, then sign in.");
}

/**
 * Bootstrap
 */
(async function boot() {
  // 1) If already authenticated → home
  await redirectIfLoggedIn();

  // 2) Wire buttons (only if present)
  els.signInBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    doSignIn();
  });
  els.createBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    doCreate();
  });

  // 3) Optional: prefill via URL params and auto-signin if &confirm= is present
  const url = new URL(window.location.href);
  const qEmail = url.searchParams.get("email");
  const qPassword = url.searchParams.get("password");
  const doConfirm = url.searchParams.has("confirm");

  if (qEmail && els.email) els.email.value = decodeURIComponent(qEmail);
  if (qPassword && els.password) els.password.value = decodeURIComponent(qPassword);

  if (doConfirm && qEmail && qPassword) {
    // Auto attempt a sign-in
    doSignIn();
  }
})();
