// app/home.js
// Home screen: chips, prompt box + Call / Files / Speak / Send, and a Logout button.

import { CONFIG } from "./config.js";

// Try to import signOut from supabase.js, but don't break if it's not there.
let signOut = null;
try {
  ({ signOut } = await import("./supabase.js"));
} catch (_) {
  // optional
}

// ---------- Top bar (Logout) ----------
(function injectHomeTopbar() {
  const bar = document.createElement("div");
  bar.className = "topbar";
  bar.innerHTML = `
    <div class="topbar__left">
      <span class="powered tiny muted">powered by Son of Wisdom</span>
    </div>
    <div class="topbar__right">
      <button id="logout-btn" class="link-btn" aria-label="Sign out">Logout</button>
    </div>
  `;
  document.body.prepend(bar);

  const btn = bar.querySelector("#logout-btn");
  btn.addEventListener("click", async () => {
    try { if (typeof signOut === "function") await signOut(); } catch (e) { console.error(e); }
    location.href = "/auth.html";
  });
})();

// ---------- Layout ----------
const app = document.getElementById("app");
app.classList.add("home-wrap");

app.innerHTML = `
  <section class="home-card">
    <h2 class="home-title">What do you want to explore today?</h2>
    <div class="chip-row">
      <button class="chip" data-text="Boosting energy and vitality tips">Boosting energy and vitality tips</button>
      <button class="chip" data-text="I feel stuck about my business">I feel stuck about my business</button>
      <button class="chip" data-text="Help me prepare for a tough conversation">Help me prepare for a tough conversation</button>
    </div>

    <div class="prompt-row">
      <input id="prompt" class="input" type="text" placeholder="Ask Son of Wisdom AI..." autocomplete="off" />
    </div>

    <div class="action-row">
      <button id="call-btn" class="btn btn-primary btn-icon">
        <span class="i i-call"></span><span>Call</span>
      </button>
      <button id="files-btn" class="btn btn-soft btn-icon">
        <span class="i i-file"></span><span>Files</span>
      </button>
      <button id="speak-btn" class="btn btn-soft btn-icon">
        <span class="i i-mic"></span><span>Speak</span>
      </button>
      <button id="send-btn" class="btn btn-soft btn-icon btn-grow">
        <span class="i i-send"></span><span>Send</span>
      </button>
    </div>

    <p class="tip muted">Tip: tap a chip or type your own and choose Call or Send.</p>

    <p class="history-link"><a href="/history.html">See past conversations</a></p>
  </section>
`;

// ---------- Behavior ----------
const promptEl = document.getElementById("prompt");
const setPrompt = (text) => (promptEl.value = text);

app.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => setPrompt(c.dataset.text || c.textContent.trim()))
);

function goCall() {
  const q = promptEl.value.trim();
  const qs = q ? `?prompt=${encodeURIComponent(q)}` : "";
  location.href = `/call.html${qs}`;
}

app.querySelector("#call-btn").addEventListener("click", goCall);
app.querySelector("#send-btn").addEventListener("click", () => {
  // placeholder for text chat – for now go to call with the prompt
  goCall();
});
app.querySelector("#speak-btn").addEventListener("click", goCall);
app.querySelector("#files-btn").addEventListener("click", () => {
  alert("File upload coming soon.");
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") goCall();
});
