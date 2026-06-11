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
} from "./i18n.js?v=v16";

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
const homeFeed      = $("homeFeed");
const closetOverlay = $("closetOverlay");
const closetFeed    = $("closetFeed");
const closetAvatar  = $("closetAvatar");
const closetName    = $("closetName");
const closetStats   = $("closetStats");
const closetProfileBtn = $("closetProfileBtn");
const fitOverlay    = $("fitOverlay");
const fitDetailBody = $("fitDetailBody");
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

// Four serialized illustration styles. The styling LLM picks one per garment
// (plate_style field, default "catalog"); each has a combo (KEEP, item +
// companions) and a solo (TOSS, the item alone as a study) variant.
// "no typography" tail must stay LAST in every prompt — anything appended
// after it (era suffix, style words like "department store") gets burned
// into the frame as a garbled header. Verified 2026-06-11 in _style_lab.
const PLATE_TAIL =
  "warm cream paper background, no human figure, no face, " +
  "absolutely no typography, no words, no letters, no numbers, " +
  "no labels, unlabeled, square composition";

const PLATE_STYLES = {
  catalog: {
    combo: (item, pieces) =>
      `mid-century retro print illustration: ${item} at center as the unmistakable star of the plate, rendered in full saturated color with crisp confident outlines and the richest detail, companion pieces ${pieces} along the bottom edge as small understated spot illustrations in pale washed-out tones with thinner lines, all visual emphasis on the central item, flat gouache colors, subtle halftone print texture, 1950s commercial art aesthetic, ${PLATE_TAIL}`,
    solo: (item) =>
      `mid-century retro print illustration: ${item} alone at center as a single discontinued item, flat gouache colors, clean uniform dark outlines, subtle halftone print texture, 1950s commercial art aesthetic, ${PLATE_TAIL}`,
  },
  naturalist: {
    combo: (item, pieces) =>
      `vintage naturalist field guide specimen plate: ${item} at center as the principal specimen, fully rendered in fine ink linework with complete muted watercolor wash and meticulous detail, secondary studies tucked in the margins as faint barely-tinted light pencil sketches: ${pieces}, the central specimen carries all the visual weight, thin hairline callout lines pointing at its details, antique scientific illustration plate, ${PLATE_TAIL}`,
    solo: (item) =>
      `vintage naturalist field guide specimen plate: ${item} drawn as a single catalogued specimen at center, fine ink linework with muted watercolor wash, thin hairline callout lines pointing at its worn details, antique scientific illustration plate, ${PLATE_TAIL}`,
  },
  croquis: {
    combo: (item, pieces) =>
      `fashion atelier sketchbook illustration: ${item} as the finished main study at center, confident ink outline with loose translucent watercolor wash bleeding past the lines, the only fully painted piece on the page, companion garments in the margin as quick unfinished pencil line sketches with no color: ${pieces}, a small fabric swatch pinned in one corner, designer croquis style, ${PLATE_TAIL}`,
    solo: (item) =>
      `fashion atelier sketchbook illustration: ${item} as a single hand-drawn study, confident ink outline with loose translucent watercolor wash bleeding past the lines, a small fabric swatch pinned in one corner, designer croquis style, ${PLATE_TAIL}`,
  },
  gouache: {
    combo: (item, pieces) =>
      `sophisticated editorial gouache illustration: ${item} painted at center with rich confident brushstrokes, the deepest color and the single hot pink accent reserved for it alone, companion pieces ${pieces} at the edges as pale ghosted thin washes that recede into the paper, clear focal hierarchy with one protagonist, refined fashion magazine illustration, muted palette, painterly, ${PLATE_TAIL}`,
    solo: (item) =>
      `sophisticated editorial gouache illustration: ${item} painted loosely with visible brushstrokes, alone at center, refined fashion magazine illustration, muted palette with a single hot pink accent, painterly, ${PLATE_TAIL}`,
  },
};

function pickPlateStyle(card) {
  return PLATE_STYLES[card.plate_style] ? card.plate_style : "catalog";
}

function buildLookPrompt(card) {
  const style = PLATE_STYLES[pickPlateStyle(card)];
  // Era folds INTO the item descriptor — never appended after PLATE_TAIL.
  const item = (card.category || "the photographed garment") +
               (card.era ? `, ${card.era} era` : "");
  // Three companions max — five invites a grid where the hero shrinks.
  const pieces = (card.wear_with || []).slice(0, 3).join(", ");
  if (card.verdict === "TOSS" || !pieces) return style.solo(item);
  return style.combo(item, pieces);
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
  sfxShutter();
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

  // Phase 2 · both verdicts get an illustrated plate — TOSS renders the item
  // alone as a condemned-specimen study, KEEP gets item + companions.
  kickOffLook(c);

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
const RACK_POLL_MS        = 45000;

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
  if (item.isStamp) sfxStamp(item.isToss); else sfxTick();
}

function updateRevealTimer() {
  const secs = Math.floor((Date.now() - revealStart) / 1000);
  revealTimer.textContent = secs + "s";
}

// Swap from reveal → settled card once the plate arrives or fails.
function settleCard({ imageUrl, failed }) {
  stopReveal();
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
  sfxSettle();
}

async function kickOffLook(card) {
  const myRun = ++revealRunId;
  const prompt = buildLookPrompt(card);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = await genImageLook(prompt, state.photoR2Url || null);
      if (myRun !== revealRunId) return;
      settleCard({ imageUrl: url });
      return;
    } catch (e) {
      if (myRun !== revealRunId) return;
      console.warn("genImageLook failed (attempt " + (attempt + 1) + ")", e);
    }
  }
  settleCard({ failed: true });
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

// The full styling brief rides along with the fit so the detail view can
// reproduce the verdict card for other stylists (undefined keys vanish in
// JSON.stringify, so empty cards cost nothing).
function pickBrief(c) {
  const b = {};
  if (c.archetype)                       b.archetype     = c.archetype;
  if (c.wear_with && c.wear_with.length) b.wear_with     = c.wear_with;
  if (c.skip && c.skip.length)           b.skip          = c.skip;
  if (c.where && c.where.length)         b.where         = c.where;
  if (c.why_toss)                        b.why_toss      = c.why_toss;
  if (c.but_if)                          b.but_if        = c.but_if;
  if (c.let_go)                          b.let_go        = c.let_go;
  if (c.reference)                       b.reference     = c.reference;
  if (c.care)                            b.care          = c.care;
  if (c.investment)                      b.investment    = c.investment;
  if (c.easter_egg)                      b.easter_egg    = c.easter_egg;
  if (c.color_pairing)                   b.color_pairing = c.color_pairing;
  return Object.keys(b).length ? b : undefined;
}

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
    brief: pickBrief(card),
    ts: Date.now(),
  };
  myMirror.fits = (myMirror.fits || []).slice(-11);
  myMirror.fits.push(fit);
  persistMirror();
  if (wall) {
    wall.fits.unshift({ ...fit, user: selfUser(), notes: [], curatedDefends: 0 });
    rerenderSocial();
  }
  return fit.id;
}

function updateFitLook(fitId, lookUrl) {
  if (!fitId || !myMirror) return;
  const f = (myMirror.fits || []).find(x => x && x.id === fitId);
  if (f) {
    f.look = lookUrl;
    persistMirror();
  }
  if (wall) {
    const w = wall.fits.find(x => x.id === fitId);
    if (w) {
      w.look = lookUrl;
      rerenderSocial();
    }
  }
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
    rows = (res && Array.isArray(res.data)) ? res.data
         : Array.isArray(res) ? res
         : [];
  } catch (e) {
    console.warn("scanRack: data/list failed", e);
    return;
  }
  buildWall(rows);
  // Skip the repaint when nothing changed — refresh polling must not make
  // the feed flicker or shift under the user's thumb.
  if (wallSig() === lastWallSig) return;
  rerenderSocial();
}

let lastWallSig = null;

function wallSig() {
  return (wall ? wall.fits : []).map(f =>
    f.id + ":" + (f.look || "") + ":" +
    f.notes.map(n => n.id + (n.curated ? "*" : "")).join(",")
  ).join("|");
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

  for (const f of fits) {
    f.notes.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const hm = heartsByUser[f.user.id];
    for (const n of f.notes) n.curated = !!(hm && hm.has(n.id));
    f.curatedDefends = f.verdict === "TOSS" ? f.notes.filter(n => n.curated).length : 0;
  }

  fits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  wall = { fits };
}

// ── home feed (the rack, inline) + closet ──

function rerenderSocial() {
  lastWallSig = wallSig();
  renderHomeFeed();
  if (closetOverlay.classList.contains("show")) renderCloset();
  if (fitOverlay.classList.contains("show")) renderFitDetail();
}

function renderHomeFeed() {
  homeFeed.innerHTML = "";
  const fits = wall ? wall.fits : [];
  if (!fits.length) {
    const d = document.createElement("div");
    d.className = "rack-empty";
    d.textContent = t(A.isInAigram ? "rack_empty" : "rack_outside");
    homeFeed.appendChild(d);
    return;
  }
  for (const f of fits) homeFeed.appendChild(rackCard(f));
}

let closetUser = null;

function openCloset(user) {
  sfxPage();
  closetUser = user;
  renderCloset();
  // Detail sits above the closet; opening a closet from a detail card
  // pops the detail so the closet is what you land on.
  closeFitDetail();
  closetOverlay.classList.add("show");
  closetOverlay.scrollTop = 0;
}

let detailFitId = null;

function openFitDetail(fit) {
  sfxPage();
  detailFitId = fit.id;
  renderFitDetail();
  fitOverlay.classList.add("show");
  fitOverlay.scrollTop = 0;
}

function closeFitDetail() {
  detailFitId = null;
  fitOverlay.classList.remove("show");
}

function renderFitDetail() {
  if (!detailFitId) return;
  const fit = (wall ? wall.fits : []).find(f => f.id === detailFitId);
  if (!fit) { closeFitDetail(); return; }
  fitDetailBody.innerHTML = "";
  fitDetailBody.appendChild(rackCard(fit, { detail: true }));
}

function renderCloset() {
  if (!closetUser) return;
  const isMe = closetUser.id === String(me.id || "");
  const fits = (wall ? wall.fits : []).filter(f => f.user.id === closetUser.id);

  closetAvatar.innerHTML = "";
  closetAvatar.appendChild(makeAvatar(closetUser));
  closetName.textContent = isMe ? t("your_closet") : (closetUser.name || "stylist");

  const keep = fits.filter(f => f.verdict !== "TOSS").length;
  const toss = fits.length - keep;
  const eraCount = {};
  for (const f of fits) if (f.era) eraCount[f.era] = (eraCount[f.era] || 0) + 1;
  const topEra = Object.keys(eraCount).sort((a, b) => eraCount[b] - eraCount[a])[0];
  const parts = [`${fits.length} ${t("fits_label")}`, `${keep} KEEP`, `${toss} TOSS`];
  // "mostly X" only when an era genuinely repeats — with all-distinct eras it lies
  if (topEra && eraCount[topEra] >= 2) parts.push(t("mostly_era").replace("%s", topEra));
  closetStats.textContent = parts.join(" · ");

  closetProfileBtn.classList.toggle("hidden", isMe || !A.openAigramProfile);

  closetFeed.innerHTML = "";
  for (const f of fits) closetFeed.appendChild(rackCard(f));
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
  } else {
    b.appendChild(makeAvatar(user));
    const s = document.createElement("span");
    s.className = "author-name";
    s.textContent = user.name || "stylist";
    b.appendChild(s);
  }
  // onClick (not pointerdown) — we're inside a scrollable feed
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openCloset(user);
  });
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
    b.addEventListener("click", () => openCloset(note.user));
  } else {
    b.style.cursor = "default";
  }
  return b;
}

function rackCard(fit, opts) {
  const detail = !!(opts && opts.detail);
  const meId = String(me.id || "");
  const isMine = fit.user.id === meId;
  const isToss = fit.verdict === "TOSS";

  const el = document.createElement("article");
  el.className = "rack-card" + (detail ? " rack-card--detail" : "");

  const ph = document.createElement("div");
  ph.className = "rack-card__photo";
  const img = document.createElement("img");
  // The generated plate is the face of the fit; the raw photo is the fallback
  // (pre-v8 fits and failed gens have no look).
  img.src = fit.look || fit.photo;
  img.alt = "";
  img.loading = "lazy";
  img.draggable = false;
  ph.appendChild(img);
  el.appendChild(ph);

  if (!detail) {
    ph.classList.add("is-tappable");
    ph.addEventListener("click", () => openFitDetail(fit));
  }

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
  cat.textContent = (fit.cat || "") + (detail && fit.era ? " · " + fit.era : "");
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

  if (detail && fit.brief) body.appendChild(briefBlock(fit));

  if (detail && (fit.notes.length || !isMine)) {
    const nl = document.createElement("div");
    nl.className = "card__section-label rack-card__notes-label";
    nl.textContent = t("notes_label");
    body.appendChild(nl);
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

// Reproduce the verdict card's brief inside the detail card, reusing the
// card__section / card__sub styles so both read as the same magazine page.
function briefBlock(fit) {
  const b = fit.brief;
  const wrap = document.createElement("div");
  wrap.className = "rack-card__brief";

  const section = (labelKey) => {
    const sec = document.createElement("section");
    sec.className = "card__section";
    const lab = document.createElement("div");
    lab.className = "card__section-label";
    lab.textContent = t(labelKey);
    sec.appendChild(lab);
    wrap.appendChild(sec);
    return sec;
  };
  const addList = (labelKey, arr, isSkip) => {
    if (!arr || !arr.length) return;
    const sec = section(labelKey);
    const ul = document.createElement("ul");
    ul.className = "card__list" + (isSkip ? " card__skip-list" : "");
    for (const item of arr) {
      const li = document.createElement("li");
      li.textContent = String(item);
      ul.appendChild(li);
    }
    sec.appendChild(ul);
  };
  const addPara = (labelKey, text) => {
    if (!text) return;
    const sec = section(labelKey);
    const p = document.createElement("p");
    p.className = "card__para";
    p.textContent = String(text);
    sec.appendChild(p);
  };

  if (fit.verdict === "TOSS") {
    addPara("why",    b.why_toss);
    addPara("but_if", b.but_if);
    addPara("let_go", b.let_go);
  } else {
    addList("wear_with", b.wear_with);
    addList("skip",      b.skip, true);
    addList("where",     b.where);
  }

  const subRows = [
    ["archetype_label", b.archetype],
    ["ref",   b.reference],
    ["care",  b.care],
    ["value", b.investment],
    ["note",  b.easter_egg],
    ["color", b.color_pairing],
  ].filter(r => r[1]);
  if (subRows.length) {
    const sub = document.createElement("div");
    sub.className = "card__sub";
    for (const [key, val] of subRows) {
      const row = document.createElement("div");
      row.className = "card__sub-row";
      const k = document.createElement("div");
      k.className = "card__sub-key";
      k.textContent = t(key);
      const v = document.createElement("div");
      v.className = "card__sub-val";
      v.textContent = String(val);
      row.appendChild(k);
      row.appendChild(v);
      sub.appendChild(row);
    }
    wrap.appendChild(sub);
  }

  return wrap;
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
  sfxTap();
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
  rerenderSocial();

  const tmpl = t(fit.verdict === "TOSS" ? "notify_defend" : "notify_pass")
    .replace("%s", chipText(chipKey));
  notifyUser(fit.user.id, "stylist_pass", tmpl, fit.look || fit.photo);
  sfxSend();
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
  rerenderSocial();

  notifyUser(note.user.id, "pass_kept", t("notify_heart"), fit.look || fit.photo);
  sfxHeart();
  toast(t("kept_note"));
}

// ─── SFX (synth-only, no assets) ─────────────────────────────────────
// Master-bus compressor + per-tone lowpass envelope + noise transients +
// breathing room tone. Audio only ever starts from a user gesture:
// ensureAudio() runs on the first tone()/noiseHit() call, and every first
// call site is gesture-driven (shutter, page, tap). Never call on mount.

let actx = null, audioBus = null;

function ensureAudio() {
  if (actx) {
    if (actx.state === "suspended") actx.resume().catch(() => {});
    return;
  }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.003;  comp.release.value = 0.12;
    const mg = actx.createGain(); mg.gain.value = 0.7;
    comp.connect(mg); mg.connect(actx.destination);
    audioBus = comp;
    startAmbient();
  } catch (e) { actx = null; }
}

function tone(freq, dur, type = "sine", delay = 0, peak = 0.12) {
  try {
    ensureAudio(); if (!actx) return;
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator(), g = actx.createGain(), f = actx.createBiquadFilter();
    o.type = type; o.frequency.value = freq;
    f.type = "lowpass"; f.Q.value = 0.6;
    f.frequency.setValueAtTime(2600, t0);
    f.frequency.exponentialRampToValueAtTime(560, t0 + dur);
    o.connect(f); f.connect(g); g.connect(audioBus);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.04);
  } catch (e) {}
}

function noiseHit(dur, peak = 0.08, delay = 0, lpCut = 4000) {
  try {
    ensureAudio(); if (!actx) return;
    const t0 = actx.currentTime + delay;
    const len = Math.max(1, Math.ceil(dur * actx.sampleRate));
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const s = actx.createBufferSource(); s.buffer = buf;
    const f = actx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = lpCut; f.Q.value = 0.5;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(audioBus);
    s.start(t0); s.stop(t0 + dur + 0.02);
  } catch (e) {}
}

// Atelier room tone — low indoor hum that breathes with real silent gaps
// (instant-play rule: no continuous drone, preload must stay silent).
let ambientStarted = false, ambientGain = null;

function startAmbient() {
  if (ambientStarted || !actx) return;
  ambientStarted = true;
  const a = actx.createOscillator(); a.type = "sine"; a.frequency.value = 92;
  const b = actx.createOscillator(); b.type = "sine"; b.frequency.value = 96;
  const f = actx.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = 150; f.Q.value = 0.4;
  ambientGain = actx.createGain(); ambientGain.gain.value = 0.0001;
  a.connect(f); b.connect(f); f.connect(ambientGain); ambientGain.connect(audioBus);
  a.start(); b.start();
  cycleAmbient(actx.currentTime + 0.5);
}

function cycleAmbient(at) {
  if (!ambientGain || !actx) return;
  const rise = 6 + Math.random() * 3, hold = 9 + Math.random() * 6;
  const fall = 7 + Math.random() * 3, quiet = 8 + Math.random() * 8;
  const peak = 0.012 + Math.random() * 0.008;
  const g = ambientGain.gain;
  g.cancelScheduledValues(at);
  g.setValueAtTime(0.0001, at);
  g.exponentialRampToValueAtTime(peak, at + rise);
  g.setValueAtTime(peak, at + rise + hold);
  g.exponentialRampToValueAtTime(0.0001, at + rise + hold + fall);
  setTimeout(() => cycleAmbient(actx.currentTime + 0.05),
             (rise + hold + fall + quiet) * 1000);
}

// Voice set — quiet, editorial. Peaks stay low on purpose.
function sfxShutter() {
  noiseHit(0.018, 0.10, 0, 6000);
  noiseHit(0.030, 0.06, 0.055, 2600);
  tone(140, 0.07, "sine", 0, 0.08);
}
function sfxTick() { tone(1240, 0.05, "sine", 0, 0.03); }
function sfxStamp(isToss) {
  noiseHit(0.03, 0.10, 0, 2400);
  if (isToss) {
    tone(220, 0.22, "triangle", 0.01, 0.14);
    tone(165, 0.30, "triangle", 0.10, 0.12);
  } else {
    tone(392, 0.16, "triangle", 0.01, 0.12);
    tone(587, 0.24, "triangle", 0.09, 0.14);
  }
}
function sfxSettle() {
  noiseHit(0.02, 0.04, 0, 3000);
  tone(523, 0.16, "sine", 0, 0.09);
  tone(784, 0.22, "sine", 0.07, 0.07);
}
function sfxPage()  { noiseHit(0.06, 0.045, 0, 1600); }
function sfxTap()   { tone(660, 0.05, "triangle", 0, 0.06); }
function sfxSend()  { tone(880, 0.08, "triangle", 0, 0.10); noiseHit(0.015, 0.05, 0, 4000); }
function sfxHeart() { tone(1175, 0.09, "sine", 0, 0.08); tone(1568, 0.14, "sine", 0.06, 0.08); }

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
  // Closet — modal close buttons use onClick (pointerdown bleeds through)
  $("closeCloset").addEventListener("click", () => closetOverlay.classList.remove("show"));
  $("closeFit").addEventListener("click", closeFitDetail);
  closetProfileBtn.addEventListener("click", () => {
    if (closetUser && A.openAigramProfile) A.openAigramProfile(closetUser.id);
  });
  $("passSheetCancel").addEventListener("click", closePassSheet);
  passSheet.addEventListener("click", (ev) => {
    if (ev.target === passSheet) closePassSheet();
  });
  renderHomeFeed(); // empty/outside state until the wall arrives
  scanRack();       // seed mirror + wall (no-op outside Aigram)
  // Keep the rack fresh: re-scan when the tab comes back to the foreground,
  // and poll while visible — but only start the timer after the first real
  // touch (preload rule: no unbounded pre-interaction timers).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scanRack();
  });
  document.addEventListener("pointerdown", () => {
    ensureAudio(); // first gesture unlocks the audio graph
    setInterval(() => {
      if (document.visibilityState === "visible") scanRack();
    }, RACK_POLL_MS);
  }, { once: true });
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
  rerenderSocial();
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
