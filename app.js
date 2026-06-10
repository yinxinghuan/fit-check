// Fit Check · main glue.
// Tap shutter → upload → recognize → game-chat verdict (rich styling card) →
// render → next.

import {
  t,
  getLocale,
  setLocale,
  issueLabel,
  caseLabel,
  hydrateI18n,
  getLookStages,
  getSystemPrompt,
} from "./i18n.js?v=v3";

const UPLOAD_URL    = "https://chat.aiwaves.tech/aigram/api/upload";
const RECOGNIZE_URL = "https://chat.aiwaves.tech/aigram/api/recognize";
const CHAT_URL      = "https://chat.aiwaves.tech/aigram/api/game-chat";
const GEN_IMAGE_URL = "https://chat.aiwaves.tech/aigram/api/gen-image";

const $ = (id) => document.getElementById(id);

const fileInput   = $("file");
const proc        = $("processing");
const procStep    = $("procStep");
const procMsg     = $("procMsg");
const procCancel  = $("procCancel");
const errOver     = $("errorOverlay");
const errMsgEl    = $("errMsg");
const overlay     = $("verdictOverlay");
const stampEl     = $("cardStamp");
const vibeEl      = $("cardVibe");
const categoryEl  = $("cardCategory");
const eraEl       = $("cardEra");
const archetypeEl = $("cardArchetype");
const wearWithUl  = $("cardWearWith");
const skipUl      = $("cardSkip");
const whereUl     = $("cardWhere");
const whyP        = $("cardWhy");
const butP        = $("cardBut");
const letGoP      = $("cardLetGo");
const refEl       = $("cardRef");
const careEl      = $("cardCare");
const invEl       = $("cardInv");
const eggEl       = $("cardEgg");
const colorEl     = $("cardColor");
const cardFootEl  = $("cardFoot");
const lookSection = $("secLook");
const lookImg     = $("lookImg");
const lookLoading = $("lookLoading");
const lookTimerEl = $("lookTimer");
const lookStageEl = $("lookStage");
const lookNotesUl = $("lookNotes");
const lookUpNext  = $("lookUpNext");
const nextBtn     = $("nextBtn");
const caseLog     = $("caseLog");
const caseLogTotal = $("caseLogTotal");
const caseLogKeep  = $("caseLogKeep");
const caseLogToss  = $("caseLogToss");
const issueLineEl  = $("issueLine");

// Aigram bridge — populated by aigram-bridge.js loaded before this module.
const A = window.Aigram || {};
const me = { id: A.telegramId || null, name: "" };

const state = {
  photoDataUrl: null,    // data: URL for instant preview
  photoR2Url:   null,    // R2 URL after upload (for any future social use)
  card:         null,    // parsed styling card JSON
};

// Monotonic run id — bumped on cancel/retry so stale in-flight results are
// dropped when they finally come back.
let runId = 0;

// ── System prompt for the styling card LLM (locale-aware, lives in i18n.js) ─
// Keeping a tombstone here so future readers don't grep for the literal.
const _SYSTEM_PROMPT_NOTE = "see i18n.js → getSystemPrompt()";


// ─── Endpoints ────────────────────────────────────────────────────────

async function uploadDataUrl(dataUrl) {
  const m = (dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("bad image data url");
  const mime = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });

  const form = new FormData();
  form.append("file", blob, "fit." + (mime.split("/")[1] || "jpg"));
  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload http ${res.status}`);
  const json = await res.json();
  if (!json.url) throw new Error("upload returned no url");
  return json.url;
}

async function recognize(imageUrl) {
  const res = await fetch(RECOGNIZE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, mode: "object" }),
  });
  if (!res.ok) throw new Error(`recognize http ${res.status}`);
  const json = await res.json();
  return json?.ok ? json : null;
}

async function genImageLook(prompt, refUrl) {
  const body = { prompt };
  if (refUrl) body.ref_url = refUrl;
  const res = await fetch(GEN_IMAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gen-image http ${res.status}`);
  const json = await res.json();
  if (!json.url) throw new Error("gen-image returned no url");
  return json.url;
}

function buildLookPrompt(card) {
  // Compose an editorial flatlay prompt from the card's KEEP fields.
  const item = card.category || "the photographed item";
  const pieces = (card.wear_with || []).slice(0, 5).join(", ");
  const era = card.era ? `, era: ${card.era}` : "";
  return (
    `editorial styling flatlay photograph: ${item} arranged with ${pieces}. ` +
    `overhead view on warm cream paper background, soft directional lighting, ` +
    `magazine still-life composition${era}, high-end fashion editorial, ` +
    `clean documentary style, square crop.`
  );
}

async function callCard(vision) {
  const subject = vision?.labels?.[0] || "unidentified item";
  const caption = vision?.caption || "";
  const attrs   = (vision?.attributes || []).slice(0, 8).join(", ");

  const userMsg = [
    `SUBJECT: ${subject}`,
    caption ? `DESCRIPTION: ${caption}` : "",
    attrs   ? `ATTRIBUTES: ${attrs}` : "",
    "",
    "Render the styling card. JSON only.",
  ].filter(Boolean).join("\n");

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: getSystemPrompt() },
        { role: "user",   content: userMsg },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat http ${res.status}`);
  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseCard(raw);
  if (!parsed) throw new Error("no card parsed");
  return parsed;
}

function safeParseCard(raw) {
  const cleaned = String(raw || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const v = String(obj.verdict || "").toUpperCase();
    if (v !== "KEEP" && v !== "TOSS") return null;
    obj.verdict = v;
    return obj;
  } catch { return null; }
}

// ─── Pipeline ────────────────────────────────────────────────────────

async function onFilePicked(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!f.type.startsWith("image/")) {
    toast(t("not_an_image"));
    return;
  }
  state.photoDataUrl = await fileToDataURL(f);
  runPipeline();
}

async function runPipeline() {
  const myRun = ++runId;
  hideError();

  showProcessing(t("step_uploading"), t("msg_uploading"));
  let photoUrl;
  try {
    photoUrl = await uploadDataUrl(state.photoDataUrl);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError(t("upload_failed"));
    return;
  }
  if (myRun !== runId) return;
  state.photoR2Url = photoUrl;

  showProcessing(t("step_inspecting"), t("msg_inspecting"));
  let vision = null;
  try {
    vision = await recognize(photoUrl);
  } catch (err) {
    console.warn("recognize failed", err);
  }
  if (myRun !== runId) return;

  showProcessing(t("step_styling"), t("msg_styling"));
  let card;
  try {
    card = await callCard(vision);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError(t("stylist_stepped_out"));
    return;
  }
  if (myRun !== runId) return;

  state.card = card;
  hideProcessing();
  showCard();
  incStats(card.verdict);
}

function cancelPipeline() {
  runId++;
  hideProcessing();
  hideError();
  fileInput.value = "";
}

// ─── Card render ─────────────────────────────────────────────────────

function setRow(rowId, valId, text) {
  if (text == null || text === "") {
    $(rowId).classList.add("hidden");
    return;
  }
  $(rowId).classList.remove("hidden");
  $(valId).textContent = String(text);
}

function setSection(secId, listOrParaId, content, isList) {
  if (content == null || (Array.isArray(content) && content.length === 0)) {
    $(secId).classList.add("hidden");
    return;
  }
  $(secId).classList.remove("hidden");
  const el = $(listOrParaId);
  if (isList) {
    el.innerHTML = "";
    for (const item of content) {
      const li = document.createElement("li");
      li.textContent = String(item);
      el.appendChild(li);
    }
  } else {
    el.textContent = String(content);
  }
}

function showCard() {
  const c = state.card;
  if (!c) return;

  // header strip
  categoryEl.textContent = c.category || "item";
  eraEl.textContent = c.era || "—";
  archetypeEl.textContent = c.archetype || "—";

  // verdict stamp + vibe
  const isToss = c.verdict === "TOSS";
  stampEl.textContent = isToss ? "TOSS" : "KEEP";
  stampEl.classList.remove("toss", "keep");
  stampEl.classList.add(isToss ? "toss" : "keep");
  vibeEl.textContent = c.vibe_line || "";

  // KEEP path
  setSection("secWearWith", "cardWearWith", c.wear_with, true);
  setSection("secSkip",     "cardSkip",     c.skip,      true);
  setSection("secWhere",    "cardWhere",    c.where,     true);

  // TOSS path
  setSection("secWhy",    "cardWhy",    c.why_toss, false);
  setSection("secBut",    "cardBut",    c.but_if,   false);
  setSection("secLetGo",  "cardLetGo",  c.let_go,   false);

  // sub-grid (conditional rows)
  setRow("subRefRow",    "cardRef",   c.reference);
  setRow("subCareRow",   "cardCare",  c.care);
  setRow("subInvRow",    "cardInv",   c.investment);
  setRow("subEggRow",    "cardEgg",   c.easter_egg);
  setRow("subColorRow",  "cardColor", c.color_pairing);

  // footer (case id)
  cardFootEl.textContent = caseLabel(nextCaseNo());

  // THE LOOK (KEEP only — gen-image flatlay, fired in background)
  // Reset the look slot every render
  lookImg.classList.add("hidden");
  lookImg.src = "";
  lookLoading.classList.remove("hidden");
  if (isToss) {
    lookSection.classList.add("hidden");
  } else {
    lookSection.classList.remove("hidden");
    kickOffLook(c);
  }

  overlay.classList.add("show");
}

// ── THE LOOK · staged process display while gen-image is running ──────

// Track current run so stale results / tickers never paint the next card.
let lookRunId = 0;

const NOTE_INTERVAL_MS = 1500;
const TIMER_INTERVAL_MS = 200;
const NOTES_PER_STAGE = 4;

// Stages + flat queue come from i18n.js. Rebuilt on every kickOffLook so
// a locale switch mid-session takes effect on the next card.
let LOOK_STAGES = getLookStages();
let LOOK_QUEUE  = LOOK_STAGES.flatMap(s => s.notes.map(n => ({ stage: s.name, note: n })));
function refreshLookData() {
  LOOK_STAGES = getLookStages();
  LOOK_QUEUE  = LOOK_STAGES.flatMap(s => s.notes.map(n => ({ stage: s.name, note: n })));
}

let lookProcStart = 0;
let lookNoteIdx   = 0;
let lookNoteInt   = null;
let lookTimerInt  = null;

function startLookProcess() {
  stopLookProcess();
  refreshLookData();
  lookProcStart = Date.now();
  lookNoteIdx = 0;

  // Reset notes list to 3 empty placeholders
  const lis = lookNotesUl.querySelectorAll(".look-loading__note");
  lis.forEach(li => {
    li.textContent = "—";
    li.className = "look-loading__note is-faded";
  });
  lookStageEl.textContent = LOOK_STAGES[0].name;
  setUpNextLine(0);
  pushLookNote(); // initial push so it doesn't start empty

  lookNoteInt = setInterval(pushLookNote, NOTE_INTERVAL_MS);
  lookTimerInt = setInterval(updateLookTimer, TIMER_INTERVAL_MS);
  updateLookTimer();
}

function stopLookProcess() {
  if (lookNoteInt) clearInterval(lookNoteInt);
  if (lookTimerInt) clearInterval(lookTimerInt);
  lookNoteInt = null;
  lookTimerInt = null;
}

function pushLookNote() {
  // If we exhaust the queue, loop the final stage (image is just slow today).
  let idx = lookNoteIdx;
  if (idx >= LOOK_QUEUE.length) {
    // Recycle within DEVELOPING stage's notes
    idx = LOOK_QUEUE.length - NOTES_PER_STAGE + ((idx - LOOK_QUEUE.length) % NOTES_PER_STAGE);
  }
  const next = LOOK_QUEUE[idx];
  if (!next) return;
  lookNoteIdx++;

  // Stage label only changes when we cross a stage boundary
  if (lookStageEl.textContent !== next.stage) {
    lookStageEl.textContent = next.stage;
    const stageIdx = LOOK_STAGES.findIndex(s => s.name === next.stage);
    setUpNextLine(stageIdx);
  }

  // Shift queue: oldest drops off the top, newest enters at bottom.
  // We keep 3 visible — [is-faded] [is-old] [is-fresh]
  const lis = lookNotesUl.querySelectorAll(".look-loading__note");
  lis[0].textContent = lis[1].textContent;
  lis[1].textContent = lis[2].textContent;
  lis[2].textContent = next.note;
  lis[0].className = "look-loading__note is-faded";
  lis[1].className = "look-loading__note is-old";
  lis[2].className = "look-loading__note is-fresh";
}

function setUpNextLine(stageIdx) {
  // Lowercase only for the latin alphabet; CJK pass-through identity.
  const lower = (s) => /^[\x00-\x7F]+$/.test(s) ? s.toLowerCase() : s;
  const upcoming = LOOK_STAGES.slice(stageIdx + 1).map(s => lower(s.name)).join(" · ");
  lookUpNext.textContent = upcoming ? `${t("up_next_prefix")} ${upcoming}` : "";
}

function updateLookTimer() {
  const t = Math.floor((Date.now() - lookProcStart) / 1000);
  lookTimerEl.textContent = t + "s";
}

async function kickOffLook(card) {
  const myRun = ++lookRunId;
  startLookProcess();
  const prompt = buildLookPrompt(card);
  try {
    const url = await genImageLook(prompt, state.photoR2Url || null);
    if (myRun !== lookRunId) { stopLookProcess(); return; }
    lookImg.src = url;
    lookImg.onload = () => {
      if (myRun !== lookRunId) return;
      stopLookProcess();
      lookImg.classList.remove("hidden");
      lookLoading.classList.add("hidden");
    };
    lookImg.onerror = () => {
      if (myRun !== lookRunId) return;
      stopLookProcess();
      lookStageEl.textContent = t("missed");
      lookUpNext.textContent = t("flatlay_failed");
    };
  } catch (e) {
    if (myRun !== lookRunId) return;
    console.warn("genImageLook failed", e);
    stopLookProcess();
    lookStageEl.textContent = "MISSED";
    lookUpNext.textContent = "the flatlay didn't develop · tap NEXT FIT";
  }
}

function closeVerdict() {
  overlay.classList.remove("show");
  state.photoDataUrl = null;
  state.photoR2Url = null;
  state.card = null;
  // Invalidate any in-flight gen-image so it doesn't paint into the next card.
  lookRunId++;
  stopLookProcess();
  fileInput.value = "";
}

// ─── UI helpers ──────────────────────────────────────────────────────

function showProcessing(step, msg) {
  procStep.textContent = step;
  procMsg.textContent  = msg;
  proc.classList.add("show");
}
function hideProcessing() { proc.classList.remove("show"); }

function showError(msg) {
  errMsgEl.textContent = msg;
  hideProcessing();
  errOver.classList.add("show");
}
function hideError() { errOver.classList.remove("show"); }

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function nextCaseNo() {
  const n = Number(localStorage.getItem("fc:case") || "0") + 1;
  localStorage.setItem("fc:case", String(n));
  return n;
}

// ─── Stats tally (case log) ──────────────────────────────────────────

const STATS_LS_KEY = "fc:stats";

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_LS_KEY);
    if (!raw) return { total: 0, keep: 0, toss: 0 };
    const s = JSON.parse(raw);
    return {
      total: Number(s.total) || 0,
      keep:  Number(s.keep)  || 0,
      toss:  Number(s.toss)  || 0,
    };
  } catch { return { total: 0, keep: 0, toss: 0 }; }
}
function incStats(verdict) {
  const s = loadStats();
  s.total += 1;
  if (verdict === "KEEP") s.keep += 1;
  else if (verdict === "TOSS") s.toss += 1;
  try { localStorage.setItem(STATS_LS_KEY, JSON.stringify(s)); } catch { /* full */ }
  renderCaseLog(s);
}
function renderCaseLog(s) {
  s = s || loadStats();
  if (!s.total) { caseLog.classList.add("hidden"); return; }
  caseLogTotal.textContent = String(s.total);
  caseLogKeep.textContent  = String(s.keep);
  caseLogToss.textContent  = String(s.toss);
  caseLog.classList.remove("hidden");
}

// ─── Masthead issue line (date + cumulative no.) ─────────────────────

function renderIssueLine() {
  const s = loadStats();
  issueLineEl.textContent = issueLabel(s.total + 1);
}

// ─── init ────────────────────────────────────────────────────────────

function init() {
  fileInput.addEventListener("change", onFilePicked);
  $("closeVerdict").addEventListener("click", closeVerdict);
  nextBtn.addEventListener("click", onNextFit);
  procCancel.addEventListener("click", cancelPipeline);
  $("errRetry").addEventListener("click", () => {
    hideError();
    runPipeline();
  });
  $("errDismiss").addEventListener("click", () => {
    hideError();
    cancelPipeline();
  });
  // locale toggle: tap EN / 中 to switch + persist + re-hydrate
  document.querySelectorAll(".locale-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const loc = btn.getAttribute("data-loc");
      if (loc === getLocale()) return;
      setLocale(loc);
      applyLocale();
    });
  });
  applyLocale();
}

function applyLocale() {
  hydrateI18n();
  // Active-state on toggle
  document.querySelectorAll(".locale-btn").forEach(btn => {
    btn.classList.toggle("is-active", btn.getAttribute("data-loc") === getLocale());
  });
  // <html lang> for accessibility / browser hints
  document.documentElement.setAttribute("lang", getLocale() === "zh" ? "zh" : "en");
  // Re-render dynamic strings that don't have data-i18n
  renderIssueLine();
  renderCaseLog();
  // Look stages will be picked up on next kickOffLook (refreshLookData).
}

function onNextFit() {
  closeVerdict();
  fileInput.value = "";
  setTimeout(() => fileInput.click(), 60);
}

// Kick everything off AFTER all module-level const/lets above are initialized.
// (Function decls hoist; const/let live in the TDZ until execution reaches
// them — calling init() at the top would silently break stats helpers.)
init();
