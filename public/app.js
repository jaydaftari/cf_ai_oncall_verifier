// On-Call Verifier front end: plain JS, no build step.
// Server state lives in the incident's Durable Object; localStorage only remembers
// which incident IDs this browser has opened so the sidebar can list them.

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "oncall-verifier:incidents";
const WATCH_POLL_MS = 5000;

const els = {
  list: $("incident-list"),
  title: $("incident-title"),
  idLabel: $("incident-id"),
  messages: $("messages"),
  empty: $("empty"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  severity: $("severity"),
  status: $("status"),
  service: $("service"),
  timeline: $("timeline"),
  watchCard: $("watch-card"),
  watchBody: $("watch-body"),
  watchVerdict: $("watch-verdict"),
  updatesCard: $("updates-card"),
  updates: $("updates"),
  generate: $("generate"),
  pmProgress: $("pm-progress"),
  pmActions: $("pm-actions"),
  postmortem: $("postmortem"),
};

let currentId = null;
let streaming = false;
let renderedMessages = 0;
let watch = null;
let pollTimer = null;
const watchTimer = { tick: null, poll: null };
let postmortemMarkdown = "";

// ---------------------------------------------------------------- helpers

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}

function loadIncidents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveIncidents(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* storage unavailable: sidebar just won't persist */
  }
}

function rememberIncident(id, title) {
  const previous = loadIncidents().find((i) => i.id === id);
  const list = loadIncidents().filter((i) => i.id !== id);
  list.unshift({ id, title: title || previous?.title || "Untitled incident" });
  saveIncidents(list);
  renderIncidentList();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const isWatching = (w) => w && (w.state === "waiting" || w.state === "awaiting");

function countdown(at) {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function copyText(button, text, label) {
  await navigator.clipboard.writeText(text);
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1500);
}

// --------------------------------------------------------------- rendering

function renderIncidentList() {
  els.list.replaceChildren(
    ...loadIncidents().map(({ id, title }) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = title;
      btn.title = title;
      btn.setAttribute("aria-current", String(id === currentId));
      btn.addEventListener("click", () => (location.hash = id));
      li.append(btn);
      return li;
    }),
  );
}

function addMessage(role, content) {
  els.empty.hidden = true;
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  if (role === "assistant") {
    div.classList.add("markdown");
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

/** Messages can also arrive from the recovery watch, so re-sync from server state. */
function syncMessages(messages) {
  if (streaming || messages.length === renderedMessages) return;
  els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
  els.empty.hidden = messages.length > 0;
  messages.forEach((m) => addMessage(m.role, m.content));
  renderedMessages = messages.length;
}

function renderState(state) {
  const { meta, timeline } = state;
  const title = meta.title || "New incident";
  els.title.textContent = title;
  document.title = `${title} · On-Call Verifier`;
  els.severity.value = meta.severity;
  els.status.value = meta.status;
  els.service.textContent = meta.service || "—";

  if (timeline.length === 0) {
    const li = document.createElement("li");
    li.className = "placeholder muted";
    li.textContent = "Events appear here as you describe them.";
    els.timeline.replaceChildren(li);
  } else {
    els.timeline.replaceChildren(
      ...timeline.map((e) => {
        const li = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = e.time;
        li.append(time, document.createTextNode(e.event));
        return li;
      }),
    );
  }

  if (meta.title) rememberIncident(currentId, meta.title);
  syncMessages(state.messages);
  renderWatch(state.watch);
  renderUpdates(state.updates);
  renderPostmortem(state.postmortem);
}

function renderWatch(next) {
  watch = next;
  const { state, round, maxChecks } = next;
  const awaiting = state === "awaiting";
  els.watchCard.classList.toggle("awaiting", awaiting);
  els.watchVerdict.hidden = !awaiting;

  const view = {
    null: ["", "Idle", "Starts automatically when the incident is marked Mitigated."],
    waiting: ["live", "Watching recovery", "First check-in in "],
    awaiting: [
      "live",
      `Check-in ${round} of ${maxChecks}: still healthy?`,
      round < maxChecks ? "Next check-in in " : "Watch expires in ",
    ],
    recovered: ["ok", "Recovery verified", `Confirmed after ${round} check-in${round === 1 ? "" : "s"}.`],
    regressed: ["bad", "Regressed, incident reopened", "Mark it Mitigated again to restart the watch."],
    expired: ["bad", "Expired without confirmation", "Still mitigated. Verify and resolve manually."],
  }[state ?? "null"];

  const [dot, label, detail] = view;
  els.watchBody.innerHTML = `<div class="watch-status"><span class="dot ${dot}"></span><span></span></div><div class="watch-meta"></div>`;
  els.watchBody.querySelector(".watch-status span:last-child").textContent = label;
  const metaEl = els.watchBody.querySelector(".watch-meta");
  const tick = () => {
    metaEl.textContent = isWatching(watch) && watch.nextCheckAt ? detail + countdown(watch.nextCheckAt) : detail;
  };
  tick();

  clearInterval(watchTimer.tick);
  clearTimeout(watchTimer.poll);
  if (isWatching(next)) {
    watchTimer.tick = setInterval(tick, 1000);
    watchTimer.poll = setTimeout(pollIncident, WATCH_POLL_MS);
  }
}

function renderUpdates(updates) {
  els.updatesCard.hidden = updates.length === 0;
  els.updates.replaceChildren(
    ...[...updates].reverse().map((u) => {
      const li = document.createElement("li");
      const head = document.createElement("div");
      head.className = "update-head";
      const when = document.createElement("span");
      when.textContent = `#${u.round} · ${new Date(u.createdAt).toISOString().slice(11, 16)} UTC`;
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", () => copyText(copy, u.content, "Copy"));
      head.append(when, copy);
      const body = document.createElement("div");
      body.className = "markdown";
      body.innerHTML = renderMarkdown(u.content);
      li.append(head, body);
      return li;
    }),
  );
}

function renderPostmortem(job) {
  const running = job.workflowId && !["Complete", "Failed"].includes(job.stage);
  els.generate.disabled = Boolean(running);
  els.generate.textContent = job.markdown ? "Regenerate postmortem" : "Generate postmortem";

  els.pmProgress.hidden = !running && job.stage !== "Failed";
  els.pmProgress.classList.toggle("failed", job.stage === "Failed");
  if (running) {
    els.pmProgress.innerHTML = `<span class="spinner"></span>`;
    els.pmProgress.append(`Workflow: ${job.stage || "Queued"}…`);
  } else if (job.stage === "Failed") {
    els.pmProgress.textContent = `Failed: ${job.error || "unknown error"}`;
  }

  postmortemMarkdown = job.markdown || "";
  els.postmortem.hidden = !job.markdown;
  els.pmActions.hidden = !job.markdown;
  if (job.markdown) els.postmortem.innerHTML = renderMarkdown(job.markdown);

  clearTimeout(pollTimer);
  if (running) pollTimer = setTimeout(pollPostmortem, 2000);
}

// ----------------------------------------------------------------- actions

async function openIncident(id) {
  currentId = id;
  clearTimeout(pollTimer);
  els.idLabel.textContent = `incident ${id.slice(0, 8)}`;
  els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
  els.empty.hidden = false;
  renderedMessages = 0;
  renderIncidentList();

  try {
    const state = await api(`/api/incidents/${id}`);
    if (id !== currentId) return;
    renderState(state);
    rememberIncident(id, state.meta.title);
  } catch (err) {
    addMessage("assistant", `Couldn't load incident: ${err.message}`).classList.add("msg-error");
  }
}

async function pollIncident() {
  const id = currentId;
  try {
    const state = await api(`/api/incidents/${id}`);
    if (id === currentId) renderState(state);
  } catch {
    if (id === currentId) watchTimer.poll = setTimeout(pollIncident, WATCH_POLL_MS * 2);
  }
}

async function newIncident() {
  const { id } = await api("/api/incidents", { method: "POST" });
  rememberIncident(id, "Untitled incident");
  location.hash = id;
}

async function sendMessage(text) {
  if (streaming || !text.trim()) return;
  streaming = true;
  els.send.disabled = true;
  addMessage("user", text);
  const bubble = addMessage("assistant", "");
  bubble.classList.add("typing");
  let reply = "";
  let finalState = null;

  try {
    const res = await fetch(`/api/incidents/${currentId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === "delta") {
          reply += event.text;
          bubble.innerHTML = renderMarkdown(reply);
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (event.type === "state") {
          finalState = event.state;
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }
    }
  } catch (err) {
    bubble.classList.add("msg-error");
    bubble.textContent = `⚠ ${err.message}`;
  } finally {
    bubble.classList.remove("typing");
    streaming = false;
    els.send.disabled = false;
    els.input.focus();
  }

  if (finalState) {
    // Our two bubbles are now on the server; anything beyond them (e.g. the
    // recovery watch reacting to this message) gets synced in.
    renderedMessages += 2;
    renderState(finalState);
  }
}

async function pollPostmortem() {
  const id = currentId;
  try {
    const job = await api(`/api/incidents/${id}/postmortem`);
    if (id !== currentId) return;
    if (job.workflowStatus === "errored" && job.stage !== "Failed") {
      job.stage = "Failed";
      job.error = job.error || "Workflow errored";
    }
    renderPostmortem(job);
  } catch {
    pollTimer = setTimeout(pollPostmortem, 4000);
  }
}

// ------------------------------------------------------------------ wiring

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  els.input.style.height = "auto";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
});

document.querySelectorAll(".starter").forEach((btn) =>
  btn.addEventListener("click", () => sendMessage(btn.textContent.trim())),
);

$("new-incident").addEventListener("click", newIncident);

$("delete-incident").addEventListener("click", async () => {
  await api(`/api/incidents/${currentId}`, { method: "DELETE" });
  saveIncidents(loadIncidents().filter((i) => i.id !== currentId));
  newIncident();
});

for (const field of ["severity", "status"]) {
  els[field].addEventListener("change", async () => {
    const state = await api(`/api/incidents/${currentId}`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: els[field].value }),
    });
    renderState(state);
  });
}

els.watchVerdict.querySelectorAll("button").forEach((btn) =>
  btn.addEventListener("click", async () => {
    els.watchVerdict.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const state = await api(`/api/incidents/${currentId}/verdict`, {
        method: "POST",
        body: JSON.stringify({ verdict: btn.dataset.verdict }),
      });
      renderState(state);
    } finally {
      els.watchVerdict.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }),
);

els.generate.addEventListener("click", async () => {
  els.generate.disabled = true;
  try {
    await api(`/api/incidents/${currentId}/postmortem`, { method: "POST" });
    pollPostmortem();
  } catch (err) {
    els.generate.disabled = false;
    els.pmProgress.hidden = false;
    els.pmProgress.classList.add("failed");
    els.pmProgress.textContent = err.message;
  }
});

$("pm-copy").addEventListener("click", () => copyText($("pm-copy"), postmortemMarkdown, "Copy Markdown"));

$("pm-download").addEventListener("click", () => {
  const blob = new Blob([postmortemMarkdown], { type: "text/markdown" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `postmortem-${currentId.slice(0, 8)}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== currentId) openIncident(id);
});

// Boot: open the incident in the URL, else the most recent one, else a new one.
(function boot() {
  const fromHash = location.hash.slice(1);
  const recent = loadIncidents()[0]?.id;
  if (fromHash) openIncident(fromHash);
  else if (recent) location.hash = recent;
  else newIncident();
})();
