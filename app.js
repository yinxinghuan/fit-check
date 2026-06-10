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
  getSystemPrompt,
  SUGGEST_CHIPS,
  DEFEND_CHIPS,
  chipText,
} from "./i18n.js?v=v5";

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
const cardEl      = $("card");
const cardImg     = $("cardImg");
const cardPhoto   = $("cardPhoto");
const revealEl    = $("reveal");
const revealLabel = $("revealLabel");
const revealBig   = $("revealBig");
const revealStatus= $("revealStatus");
const revealTimer = $("revealTimer");
const nextBtn     = $("nextBtn");
const caseLog     = $("caseLog");
const caseLogTotal = $("caseLogTotal");
const caseLogKeep  = $("caseLogKeep");
const caseLogToss  = $("caseLogToss");
const issueLineEl  = $("issueLine");
const rackBtn      = $("rackBtn");
const rackBadge    = $("rackBadge");
const rackOverlay  = $("rackOverlay");
const rackFeed     = $("rackFeed");
const passSheet      = $("passSheet");
const passSheetTitle = $("passSheetTitle");
const passSheetChips = $("passSheetChips");

// Aigram bridge — populated by aigram-bridge.js loaded before this module.
const A = window.Aigram || {};
const me = { id: A.telegramId || null, name: "" };

const state = {
  photoDataUrl: null,    // data: URL for instant preview
  photoR2Url:   null,    // R2 URL after upload (wall image + notify ref_url)
  card:         null,    // parsed styling card JSON
  publishedFitId: null,  // id of the fit auto-published for this verdict
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
  // Auto-publish to THE RACK — making is publishing (no private/public fork).
  state.publishedFitId = publishFit(card);
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

  // Reset image slot — will be populated when flatlay arrives
  cardImg.src = "";
  cardPhoto.classList.remove("hidden");

  // Phase 1 · show the reveal carousel cycling through this card's content
  // while the flatlay generates in the background
  startReveal(c);

  // Phase 2 · TOSS verdicts skip the image (no point visualizing what to
  // throw away) — just settle without an image after a brief carousel beat
  if (isToss) {
    // Let the carousel run long enough to read the why/but/let-go beats,
    // then settle without an image (no flatlay for TOSS verdicts).
    setTimeout(() => settleCard({ skipImage: true }), 7000);
  } else {
    kickOffLook(c);
  }

  overlay.classList.add("show");
}

// ── REVEAL CAROUSEL · cycles the card's actual content while gen-image runs ──
//
// Phase 1: card is hidden; reveal panel shows category → era → verdict →
//          vibe → each wear_with → each skip → each where → ref → care
//          → ..., one item every ~1.7s. User reads teasers while the
//          flatlay develops in the background.
// Phase 2: image arrives → hide reveal, populate img at top of card,
//          unhide card → the full brief is laid out (image first, then
//          all the same info that was just teased).

let revealRunId    = 0;
let revealItems    = [];
let revealIdx      = 0;
let revealInt      = null;
let revealTimerInt = null;
let revealStart    = 0;

const REVEAL_INTERVAL_MS  = 1700;
const REVEAL_TIMER_MS     = 200;

function buildRevealItems(card) {
  const items = [];

  // Opening trio — the headline beats. These are the "what is this?"
  // moments before we get into the styling brief itself.
  if (card.category) {
    items.push({ label: t("category_label"), big: card.category });
  }
  if (card.era || card.archetype) {
    items.push({
      label: t("era_label"),
      big: [card.era, card.archetype].filter(Boolean).join(" · "),
    });
  }
  // The verdict reveal
  items.push({
    label: t("verdict_label"),
    big: card.verdict,
    isStamp: true,
    isToss: card.verdict === "TOSS",
  });
  if (card.vibe_line) {
    items.push({ label: t("vibe_label"), big: card.vibe_line });
  }

  if (card.verdict === "KEEP") {
    for (const w of card.wear_with || []) {
      items.push({ label: t("wear_with"), big: w });
    }
    for (const s of card.skip || []) {
      items.push({ label: t("skip"), big: s });
    }
    for (const w of card.where || []) {
      items.push({ label: t("where"), big: w });
    }
  } else {
    if (card.why_toss) items.push({ label: t("why"),    big: card.why_toss });
    if (card.but_if)   items.push({ label: t("but_if"), big: card.but_if   });
    if (card.let_go)   items.push({ label: t("let_go"), big: card.let_go   });
  }

  // Sub-grid teases at the tail
  if (card.reference)     items.push({ label: t("ref"),   big: card.reference     });
  if (card.care)          items.push({ label: t("care"),  big: card.care          });
  if (card.investment)    items.push({ label: t("value"), big: card.investment    });
  if (card.easter_egg)    items.push({ label: t("note"),  big: card.easter_egg    });
  if (card.color_pairing) items.push({ label: t("color"), big: card.color_pairing });

  return items;
}

function startReveal(card) {
  stopReveal();
  revealItems = buildRevealItems(card);
  revealIdx   = 0;
  revealStart = Date.now();

  // Reset reveal panel to initial state
  revealStatus.classList.remove("is-failed");
  revealStatus.textContent = t("the_look_developing");
  revealTimer.textContent  = "0s";

  // Show reveal, hide card
  revealEl.classList.remove("hidden");
  cardEl.classList.add("hidden");

  pushRevealItem();
  revealInt      = setInterval(pushRevealItem, REVEAL_INTERVAL_MS);
  revealTimerInt = setInterval(updateRevealTimer, REVEAL_TIMER_MS);
}

function stopReveal() {
  if (revealInt)      clearInterval(revealInt);
  if (revealTimerInt) clearInterval(revealTimerInt);
  revealInt      = null;
  revealTimerInt = null;
}

function pushRevealItem() {
  if (!revealItems.length) return;
  // Loop endlessly so a slow gen-image doesn't strand the carousel.
  const item = revealItems[revealIdx % revealItems.length];
  revealIdx++;

  // Force animation restart by removing then re-adding the fresh class
  revealLabel.classList.remove("is-fresh");
  revealBig.classList.remove("is-fresh", "is-stamp", "is-toss");
  void revealLabel.offsetWidth;
  void revealBig.offsetWidth;

  revealLabel.textContent = item.label || "";
  revealBig.textContent   = item.big   || "";
  revealLabel.classList.add("is-fresh");
  revealBig.classList.add("is-fresh");
  if (item.isStamp) revealBig.classList.add("is-stamp");
  if (item.isToss)  revealBig.classList.add("is-toss");
}

function updateRevealTimer() {
  const secs = Math.floor((Date.now() - revealStart) / 1000);
  revealTimer.textContent = secs + "s";
}

// Swap from reveal → settled card once the flatlay arrives, fails, or is
// intentionally skipped (TOSS verdicts don't get a flatlay).
function settleCard({ imageUrl, failed, skipImage }) {
  stopReveal();
  if (skipImage) {
    // TOSS path — never had a flatlay coming. Just hide the image slot
    // and settle the card body.
    cardPhoto.classList.add("hidden");
    showSettledCard();
    return;
  }
  if (failed) {
    // Show the card without an image at top + flag the status briefly so
    // the user knows the flatlay isn't coming. Card body still reads fine.
    cardPhoto.classList.add("hidden");
    revealStatus.textContent = t("flatlay_missed");
    revealStatus.classList.add("is-failed");
    setTimeout(showSettledCard, 700);
    return;
  }
  // Image succeeded — populate then wait for image to actually load before swap
  updateFitLook(state.publishedFitId, imageUrl);
  cardImg.onload = () => {
    cardPhoto.classList.remove("hidden");
    showSettledCard();
  };
  cardImg.onerror = () => {
    cardPhoto.classList.add("hidden");
    showSettledCard();
  };
  cardImg.src = imageUrl;
}

function showSettledCard() {
  revealEl.classList.add("hidden");
  cardEl.classList.remove("hidden");
}

async function kickOffLook(card) {
  const myRun = ++revealRunId;
  const prompt = buildLookPrompt(card);
  try {
    const url = await genImageLook(prompt, state.photoR2Url || null);
    if (myRun !== revealRunId) return;
    settleCard({ imageUrl: url });
  } catch (e) {
    if (myRun !== revealRunId) return;
    console.warn("genImageLook failed", e);
    settleCard({ failed: true });
  }
}

function closeVerdict() {
  overlay.classList.remove("show");
  state.photoDataUrl = null;
  state.photoR2Url = null;
  state.card = null;
  state.publishedFitId = null;
  // Invalidate any in-flight gen-image so it doesn't paint into the next card.
  revealRunId++;
  stopReveal();
  // Reset DOM for next render
  revealEl.classList.add("hidden");
  cardEl.classList.add("hidden");
  cardImg.src = "";
  fileInput.value = "";
}

// ─── THE RACK · stylist pass social layer ────────────────────────────
//
// Every save row is that user's own data; the wall is a projection:
//   { fits:   [{ id, photo, look?, cat, era, verdict, vibe, ts }],   // my fits (cap 12)
//     passes: [{ id, fit_id, author_id, chip, ts }],                 // notes I left on others' fits (cap 40)
//     hearts: [{ pass_id, fit_id, ts }] }                            // notes on MY fits I curated (cap 60)
// A note on fit F is "curated" when its id appears in F's author's hearts.
// Chips are stored by KEY so each viewer reads them in their own locale.

const SEEN_LS_KEY = "fc:rackSeen";

// In-memory source of truth for my own save row. get/data/list is eventually
// consistent — never refetch-then-write, always write through this mirror.
let myMirror = null;
let wall = null; // { fits: [...], newCount }

function selfUser() {
  return { id: String(me.id || ""), name: t("you_label"), avatar: "" };
}

function persistMirror() {
  if (!A.isInAigram || !A.gameUuid || !me.id) return;
  if (!myMirror) myMirror = {};
  A.postAigramAPI("/note/aigram/ai/game/save/data", {
    session_id: A.gameUuid,
    resource_data: JSON.stringify(myMirror),
  });
}

function notifyUser(targetId, event, template, refUrl) {
  if (!A.isInAigram || !A.gameUuid) return;
  if (!targetId || String(targetId) === String(me.id)) return; // never self-notify
  const action = {
    type: "notify",
    target_user_id: String(targetId),
    message: { template, variables: ["sender_name"] },
  };
  if (refUrl) {
    action.image = { ref_url: refUrl, prompt: "a fit on the rack · Fit Check" };
  }
  A.postAigramAPI("/note/aigram/ai/game/record/play", {
    session_id: A.gameUuid,
    event,
    config_json: JSON.stringify({ actions: [action] }),
  });
}

// ── publish my fits ──

function publishFit(card) {
  if (!A.isInAigram || !A.gameUuid || !me.id || !state.photoR2Url) return null;
  if (!myMirror) myMirror = {};
  const fit = {
    id: "f_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    photo: state.photoR2Url,
    cat: card.category || "",
    era: card.era || "",
    verdict: card.verdict,
    vibe: card.vibe_line || "",
    ts: Date.now(),
  };
  myMirror.fits = (myMirror.fits || []).slice(-11);
  myMirror.fits.push(fit);
  persistMirror();
  if (wall) {
    wall.fits.unshift({ ...fit, user: selfUser(), notes: [], curatedDefends: 0 });
  }
  return fit.id;
}

function updateFitLook(fitId, lookUrl) {
  if (!fitId || !myMirror) return;
  const f = (myMirror.fits || []).find(x => x && x.id === fitId);
  if (!f) return;
  f.look = lookUrl;
  persistMirror();
}

// ── wall scan + projection ──

async function scanRack() {
  if (!A.isInAigram || !A.gameUuid || !me.id) return;
  let rows;
  try {
    const res = await A.callAigramAPI(
      `/note/aigram/ai/game/get/data/list?session_id=${encodeURIComponent(A.gameUuid)}`,
      "GET"
    );
    rows = res?.data || [];
  } catch (e) {
    console.warn("scanRack: data/list failed", e);
    return;
  }
  buildWall(rows);
  renderRackBadge();
  if (rackOverlay.classList.contains("show")) renderRackFeed();
}

function buildWall(rows) {
  const fits = [];
  const passes = [];
  const heartsByUser = {}; // userId -> Map(pass_id -> ts)
  const meId = String(me.id || "");
  let selfMeta = null;

  for (const row of rows) {
    if (!row || !row.resource_data) continue;
    const uid = String(row.user_id);
    let p;
    try { p = JSON.parse(row.resource_data) || {}; } catch { continue; }
    if (uid === meId) {
      // Seed the mirror ONCE; afterwards the mirror is authoritative for my
      // row (server echo lags behind my own writes).
      if (!myMirror) myMirror = p;
      selfMeta = { id: uid, name: row.user_name || "", avatar: row.head_url || "" };
      continue;
    }
    const user = { id: uid, name: row.user_name || "stylist", avatar: row.head_url || "" };
    for (const f of p.fits || [])   if (f  && f.id  && f.photo)   fits.push({ ...f, user });
    for (const ps of p.passes || []) if (ps && ps.id && ps.fit_id) passes.push({ ...ps, user });
    const hm = heartsByUser[uid] = new Map();
    for (const h of p.hearts || []) if (h && h.pass_id) hm.set(h.pass_id, h.ts || 0);
  }

  // My contributions come from the mirror, not the (possibly stale) server row.
  if (!myMirror) myMirror = {};
  const meUser = selfMeta || selfUser();
  for (const f of myMirror.fits || [])   if (f  && f.id  && f.photo)   fits.push({ ...f, user: meUser });
  for (const ps of myMirror.passes || []) if (ps && ps.id && ps.fit_id) passes.push({ ...ps, user: meUser });
  const mh = heartsByUser[meId] = new Map();
  for (const h of myMirror.hearts || []) if (h && h.pass_id) mh.set(h.pass_id, h.ts || 0);

  // Attach notes to fits
  const byId = new Map();
  for (const f of fits) { f.notes = []; byId.set(f.id, f); }
  for (const ps of passes) {
    const f = byId.get(ps.fit_id);
    if (!f || ps.user.id === f.user.id) continue; // can't note your own fit
    f.notes.push(ps);
  }

  const lastSeen = Number(localStorage.getItem(SEEN_LS_KEY) || 0);
  const myPassIds = new Set((myMirror.passes || []).map(x => x.id));
  let newCount = 0;
  for (const f of fits) {
    f.notes.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const hm = heartsByUser[f.user.id];
    for (const n of f.notes) {
      n.curated = !!(hm && hm.has(n.id));
      if (f.user.id === meId && (n.ts || 0) > lastSeen) newCount++;
    }
    f.curatedDefends = f.verdict === "TOSS" ? f.notes.filter(n => n.curated).length : 0;
  }
  // Hearts other authors gave to MY notes
  for (const uid of Object.keys(heartsByUser)) {
    if (uid === meId) continue;
    for (const [pid, ts] of heartsByUser[uid]) {
      if (myPassIds.has(pid) && ts > lastSeen) newCount++;
    }
  }

  fits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  wall = { fits, newCount };
}

// ── rack UI ──

function renderRackBadge() {
  const n = wall ? wall.newCount : 0;
  if (n > 0) {
    rackBadge.textContent = String(n);
    rackBadge.classList.remove("hidden");
  } else {
    rackBadge.classList.add("hidden");
  }
}

function openRack() {
  if (!A.isInAigram) { toast(t("rack_outside")); return; }
  rackOverlay.classList.add("show");
  renderRackFeed();
  markRackSeen();
  scanRack();
}

function markRackSeen() {
  try { localStorage.setItem(SEEN_LS_KEY, String(Date.now())); } catch { /* ignore */ }
  if (wall) wall.newCount = 0;
  renderRackBadge();
}

function renderRackFeed() {
  rackFeed.innerHTML = "";
  const fits = wall ? wall.fits : [];
  if (!fits.length) {
    const d = document.createElement("div");
    d.className = "rack-empty";
    d.textContent = t("rack_empty");
    rackFeed.appendChild(d);
    return;
  }
  const meId = String(me.id || "");
  const mine   = fits.filter(f => f.user.id === meId);
  const others = fits.filter(f => f.user.id !== meId);
  const section = (labelKey, arr) => {
    if (!arr.length) return;
    const lab = document.createElement("div");
    lab.className = "rack-section-label";
    lab.textContent = t(labelKey);
    rackFeed.appendChild(lab);
    for (const f of arr) rackFeed.appendChild(rackCard(f));
  };
  section("your_fits", mine);
  section("on_the_rack", others);
}

function makeAvatar(user) {
  if (user.avatar) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = user.avatar;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.draggable = false;
    return img;
  }
  const d = document.createElement("div");
  d.className = "avatar is-initial";
  d.textContent = (user.name || "?").slice(0, 1).toUpperCase();
  return d;
}

function authorChip(user, isMine) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rack-card__author";
  if (isMine) {
    const s = document.createElement("span");
    s.className = "author-you";
    s.textContent = t("you_label");
    b.appendChild(s);
    b.style.cursor = "default";
  } else {
    b.appendChild(makeAvatar(user));
    const s = document.createElement("span");
    s.className = "author-name";
    s.textContent = user.name || "stylist";
    b.appendChild(s);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (A.openAigramProfile) A.openAigramProfile(user.id);
    });
  }
  return b;
}

function noteChip(fit, note, isMineFit) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "note-chip" + (note.curated ? " is-curated" : "");
  b.appendChild(makeAvatar(note.user));
  const s = document.createElement("span");
  s.textContent = chipText(note.chip);
  b.appendChild(s);
  if (isMineFit && !note.curated) {
    // onClick (not pointerdown) — we're inside a scrollable feed
    b.addEventListener("click", () => heartPass(fit, note));
  } else if (!isMineFit) {
    b.addEventListener("click", () => {
      if (A.openAigramProfile) A.openAigramProfile(note.user.id);
    });
  } else {
    b.style.cursor = "default";
  }
  return b;
}

function rackCard(fit) {
  const meId = String(me.id || "");
  const isMine = fit.user.id === meId;
  const isToss = fit.verdict === "TOSS";

  const el = document.createElement("article");
  el.className = "rack-card";

  const ph = document.createElement("div");
  ph.className = "rack-card__photo";
  const img = document.createElement("img");
  img.src = fit.photo;
  img.alt = "";
  img.loading = "lazy";
  img.draggable = false;
  ph.appendChild(img);
  el.appendChild(ph);

  const body = document.createElement("div");
  body.className = "rack-card__body";

  const meta = document.createElement("div");
  meta.className = "rack-card__meta";
  const stamp = document.createElement("span");
  stamp.className = "rack-card__stamp " + (isToss ? "toss" : "keep");
  stamp.textContent = isToss ? "TOSS" : "KEEP";
  meta.appendChild(stamp);
  const cat = document.createElement("span");
  cat.className = "rack-card__cat";
  cat.textContent = fit.cat || "";
  meta.appendChild(cat);
  meta.appendChild(authorChip(fit.user, isMine));
  body.appendChild(meta);

  if (fit.vibe) {
    const v = document.createElement("div");
    v.className = "rack-card__vibe";
    v.textContent = fit.vibe;
    body.appendChild(v);
  }

  // TOSS verdict flips once the author keeps 3 defenses — the easter egg
  if (isToss && fit.curatedDefends >= 3) {
    const o = document.createElement("div");
    o.className = "rack-card__overruled";
    o.textContent = t("overruled") + " · KEEP";
    body.appendChild(o);
  }

  const notes = document.createElement("div");
  notes.className = "rack-card__notes";
  for (const n of fit.notes) notes.appendChild(noteChip(fit, n, isMine));
  if (!isMine) {
    const already = fit.notes.some(n => n.user.id === meId);
    if (!already) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "note-chip is-add";
      add.textContent = t(isToss ? "defend_note" : "add_note");
      add.addEventListener("click", () => openPassSheet(fit));
      notes.appendChild(add);
    }
  }
  body.appendChild(notes);

  if (isMine && fit.notes.some(n => !n.curated)) {
    const h = document.createElement("div");
    h.className = "rack-card__hint";
    h.textContent = t("tap_note_keep");
    body.appendChild(h);
  }

  el.appendChild(body);
  return el;
}

// ── stylist pass sheet ──

function openPassSheet(fit) {
  const isToss = fit.verdict === "TOSS";
  passSheetTitle.textContent = t(isToss ? "defend_sheet_title" : "pass_sheet_title");
  passSheetChips.innerHTML = "";
  for (const key of (isToss ? DEFEND_CHIPS : SUGGEST_CHIPS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-chip";
    b.textContent = chipText(key);
    b.addEventListener("click", () => sendPass(fit, key));
    passSheetChips.appendChild(b);
  }
  passSheet.classList.add("show");
}

function closePassSheet() {
  passSheet.classList.remove("show");
}

function sendPass(fit, chipKey) {
  closePassSheet();
  const meId = String(me.id || "");
  if (!A.isInAigram || !meId || fit.user.id === meId) return;
  if (((myMirror && myMirror.passes) || []).some(p => p.fit_id === fit.id)) {
    toast(t("already_noted"));
    return;
  }
  if (!myMirror) myMirror = {};
  const pass = {
    id: "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    fit_id: fit.id,
    author_id: fit.user.id,
    chip: chipKey,
    ts: Date.now(),
  };
  myMirror.passes = (myMirror.passes || []).slice(-39);
  myMirror.passes.push(pass);
  persistMirror();

  // Optimistic insert so the note shows immediately
  fit.notes.unshift({ ...pass, user: selfUser(), curated: false });
  renderRackFeed();

  const tmpl = t(fit.verdict === "TOSS" ? "notify_defend" : "notify_pass")
    .replace("%s", chipText(chipKey));
  notifyUser(fit.user.id, "stylist_pass", tmpl, fit.photo);
  toast(t("noted"));
}

function heartPass(fit, note) {
  const meId = String(me.id || "");
  if (!A.isInAigram || !meId) return;
  if (!myMirror) myMirror = {};
  if ((myMirror.hearts || []).some(h => h.pass_id === note.id)) return;
  myMirror.hearts = (myMirror.hearts || []).slice(-59);
  myMirror.hearts.push({ pass_id: note.id, fit_id: fit.id, ts: Date.now() });
  persistMirror();

  note.curated = true;
  if (fit.verdict === "TOSS") {
    fit.curatedDefends = fit.notes.filter(n => n.curated).length;
  }
  renderRackFeed();

  notifyUser(note.user.id, "pass_kept", t("notify_heart"), fit.photo);
  toast(t("kept_note"));
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
  // THE RACK — modal close buttons use onClick (pointerdown bleeds through)
  rackBtn.addEventListener("click", openRack);
  $("closeRack").addEventListener("click", () => rackOverlay.classList.remove("show"));
  $("passSheetCancel").addEventListener("click", closePassSheet);
  passSheet.addEventListener("click", (ev) => {
    if (ev.target === passSheet) closePassSheet();
  });
  scanRack(); // seed mirror + inbox badge (no-op outside Aigram)
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
  if (rackOverlay.classList.contains("show")) renderRackFeed();
  // Reveal carousel labels are picked up via t() on next render.
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
