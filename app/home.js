// app/home.js
// Home (chat) page controller — desktop & mobile friendly

// Clear one-shot redirect flag so future logins work again
sessionStorage.removeItem("sow_redirected");

import { supabase, ensureAuthedOrRedirect, getSession } from "./supabase.js";

/* -------------------------- tiny DOM helpers -------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ------------------------------ state -------------------------------- */
const CHAT_URL = "/api/chat";          // your backend (n8n/Express/etc.)
const chatId   = (crypto?.randomUUID?.() || String(Date.now())); // session/thread id
let session    = null;
let sending    = false;

/* ------------------------------ UI refs ------------------------------- */
const refs = {
  chipsRow:   $(".simple-chips"),
  chips:      $$(".chip"),
  status:     $("#status"),
  input:      $("#q"),
  sendBtn:    $("#btn-send"),
  callBtn:    $("#btn-call"),
  filesBtn:   $("#btn-files"),
  speakBtn:   $("#btn-speak"),
  chatBox:    $("#chat-box"),          // optional (add if you want bubbles)
  logoutBtn:  $("#btn-logout"),
  hamburger:  $("#btn-menu"),
};

/* ---------------------------- utilities ------------------------------- */
function setStatus(msg, isError = false) {
  if (!refs.status) return;
  refs.status.textContent = msg || "";
  refs.status.style.color = isError ? "#ffb3b3" : "var(--muted)";
}

function setSendingState(v) {
  sending = !!v;
  if (refs.sendBtn) {
    refs.sendBtn.disabled = sending;
    refs.sendBtn.textContent = sending ? "Sending…" : "Send";
  }
  if (refs.input) refs.input.disabled = sending;
}

/* optional: render bubbles if #chat-box exists */
function appendBubble(role, text) {
  if (!refs.chatBox) return; // no chat stream on page; silently skip
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  refs.chatBox.appendChild(el);
  refs.chatBox.parentElement?.scrollTo({ top: refs.chatBox.parentElement.scrollHeight, behavior: "smooth" });
}

/* ---------------------------- networking ------------------------------ */
async function chatRequest(text, meta = {}) {
  const body = {
    text,
    meta,
  };
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Chat ${res.status}: ${t || res.statusText}`);
  }
  // Expect JSON: { reply: "..." } or { message: "..." }
  const data = await res.json().catch(() => ({}));
  return data.reply ?? data.message ?? "";
}

/* ------------------------------ actions ------------------------------- */
async function handleSend() {
  if (!refs.input) return;
  const text = refs.input.value.trim();
  if (!text || sending) return;

  appendBubble("user", text);
  setSendingState(true);
  setStatus("Thinking…");

  try {
    const email = session?.user?.email ?? null;
    const reply = await chatRequest(text, {
      email,
      page: "home",
      sessionId: chatId,
      timestamp: new Date().toISOString(),
    });
    appendBubble("ai", reply || "…");
    setStatus("Ready.");
  } catch (err) {
    console.error("[HOME] chat error:", err);
    appendBubble("ai", "Sorry — something went wrong while replying.");
    setStatus("Request failed. Please try again.", true);
  } finally {
    setSendingState(false);
    refs.input.value = "";
    refs.input.focus();
  }
}

function bindUI() {
  // chips -> fill input
  refs.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const fill = chip.getAttribute("data-fill") || chip.textContent || "";
      if (refs.input) {
        refs.input.value = fill;
        refs.input.focus();
      }
    });
  });

  // send button
  refs.sendBtn?.addEventListener("click", handleSend);

  // Enter to send (Shift+Enter for newline if you switch to textarea later)
  refs.input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // tools (stubs / routes)
  refs.callBtn?.addEventListener("click", () => {
    window.location.href = "call.html";
  });
  refs.filesBtn?.addEventListener("click", async () => {
    // lightweight stub; replace with your flow
    alert("Files: connect your upload flow here.");
  });
  refs.speakBtn?.addEventListener("click", () => {
    alert("Speak: wire your mic/voice flow here.");
  });

  // history nav (hamburger)
  refs.hamburger?.addEventListener("click", () => {
    window.location.href = "history.html";
  });

  // logout
  refs.logoutBtn?.addEventListener("click", async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn("signOut error:", e);
    } finally {
      window.location.replace("/auth.html");
    }
  });
}

/* -------------------------------- boot -------------------------------- */
(async function boot() {
  // Protect the page (redirect to auth when not signed in)
  await ensureAuthedOrRedirect();

  // If we’re still here, we’re either signed in or in the short window before redirect.
  session = await getSession();
  bindUI();

  if (session?.user) {
    setStatus("Signed in. How can I help?");
  } else {
    setStatus("Checking sign-in…");
  }
})();
