// Fit Check · main glue.
// Tap shutter → upload → recognize → game-chat verdict (rich styling card) →
// render → next.

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
const photoImg    = $("cardPhoto");
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

// ── System prompt for the styling card LLM ───────────────────────────
const SYSTEM_PROMPT = `You are FIT CHECK — best-friend-stylist + thrift archaeologist. A user photographed something. A vision model already identified it; you only see text descriptors. Produce a STYLING CARD as STRICT JSON only — no markdown, no preamble.

═══ FOUNDATIONAL FRAME ═══
The user trusts you to tell the truth. They want to know what to TOSS as much as what to KEEP. The product fails if you only ever say KEEP. Refusing to TOSS something that should be TOSSED is unkind. Real stylists fire half their client's closet by the third session. Bring that energy.

When in doubt between KEEP and TOSS, look HARDER for TOSS signals before defaulting to KEEP. A pretty item with no current closet-neighbors is a TOSS.

═══ BANNED VOCABULARY (do not use these words/phrases) ═══
"effortless" · "effortlessly chic" · "timeless" · "elevates" · "elevated" · "commands presence" · "confident" · "confidence" · "polished" · "polished edge" · "dreamy" · "edgy" · "edge" · "flair" · "flash" · "pop" · "vibe-y" · "statement piece" · "go-to" · "elevate your look" · "perfect for" · "must-have" · "wardrobe staple" · "versatile" · "iconic" · "stunning" · "chic" · "stylish" · "fashionable" · "must" · "love" · "adore" · "totally" · "absolutely" · "anchors" · "moment" · "X-core moment" · "X-trend revival" · "X-revival moment" · "rugged spirit" · "casual layering" · "play with"

The voice is observed not advertised. Never sell. Describe what the item DOES, structurally and socially. Use verbs that name an action ("commutes from boardroom to bar", "softens after the third drink", "telegraphs old-money on a thrift budget"). Skip adjectives that flatter.

═══ vibe_line — 1 SENTENCE, ≤12 WORDS, ACTION VERB ═══
These are EXAMPLES OF THE VOICE, not a template to copy verbatim. Write your own.
Good shape:
  "telegraphs old-money on a thrift budget"
  "the kind of jacket strangers ask where it's from"
  "borrows credit it didn't earn — every wear is a small lie"
  "looks accidentally rich until you turn around"
  "rented from 2006 and never returned"
  "does most of the work; the rest of the outfit is rent"
Bad shape (cut and rewrite if you produced any of these):
  "X with confident edge" / "elevates the look" / "perfect for" / "anchors X"
  "adds a touch of refined toughness" (flattery, no action)
  "softens an outfit by 30%, dilutes it by 50%" (do not copy this — write your own)

═══ THREE IN-VOICE EXAMPLES ═══

Example A — INPUT:
SUBJECT: blazer
DESCRIPTION: A double-breasted navy wool blazer, gold buttons, structured shoulder, mid-thigh hem.
ATTRIBUTES: double-breasted, navy wool, gold buttons, structured shoulder, mid-thigh

Example A — OUTPUT:
{
  "category": "double-breasted navy wool blazer",
  "era": "late '80s yacht-club revival",
  "archetype": "trust-fund seasonal rotation",
  "verdict": "KEEP",
  "vibe_line": "telegraphs old-money on a thrift budget — works hardest when the rest of the outfit is cheap",
  "wear_with": [
    "Levi's 501 in white, hemmed at ankle",
    "navy crewneck tee, cotton not modal",
    "Bass Weejun penny loafer, oxblood",
    "white tube sock, visible",
    "one signet ring, no other jewelry"
  ],
  "skip": [
    "tailored trousers — too on-brief",
    "stiletto anything — drains the irony"
  ],
  "where": [
    "first-date dive bar",
    "book launch",
    "Thanksgiving with the cousins",
    "art opening in someone's loft"
  ],
  "reference": "Lauren Hutton's off-duty c.1978",
  "care": "wool — empty pockets before storing, brush down with garment brush after wear",
  "why_toss": null,
  "but_if": null,
  "let_go": null,
  "investment": "$120-180 at Crossroads if buttons are real brass",
  "easter_egg": null,
  "color_pairing": null
}

Example B — INPUT:
SUBJECT: jumpsuit
DESCRIPTION: A short-sleeve cotton-blend jumpsuit in ditsy floral print, elastic waist, wide leg.
ATTRIBUTES: short-sleeve, ditsy floral, elastic waist, wide leg, cotton blend, mid-rise

Example B — OUTPUT:
{
  "category": "ditsy-print cotton jumpsuit",
  "era": "summer '19 mid-tier-influencer staple",
  "archetype": "Sunday-farmers-market-but-make-it-aesthetic",
  "verdict": "TOSS",
  "vibe_line": "reads as a costume from a wedding you don't remember attending",
  "wear_with": null,
  "skip": null,
  "where": null,
  "reference": "Madewell SS19",
  "care": null,
  "why_toss": "the print is locked to a specific cycle — every styling move points back at that era, no neighbors to play with in a current closet",
  "but_if": "you garden seriously and don't care; or you have a friend who'd actually wear this without irony",
  "let_go": "Buffalo Exchange $18-25 best case, otherwise Goodwill or repurpose the fabric — it's good cotton",
  "investment": null,
  "easter_egg": null,
  "color_pairing": null
}

Example C — INPUT (cute item that looks plausible but should TOSS):
SUBJECT: top
DESCRIPTION: Cropped graphic tee in heather grey, distressed neckline, faded screen-print of a 1970s rock band logo.
ATTRIBUTES: cropped, heather grey, distressed neckline, faded print, screen-printed 70s band logo, jersey cotton

Example C — OUTPUT:
{
  "category": "cropped fake-vintage band tee",
  "era": "Urban Outfitters c.2014",
  "archetype": "music-festival-cosplay",
  "verdict": "TOSS",
  "vibe_line": "borrows credit it didn't earn — every wear is a small lie",
  "wear_with": null,
  "skip": null,
  "where": null,
  "reference": "Forever 21 SS14 graphic tee wall",
  "care": null,
  "why_toss": "the distressing is factory, the band is a stranger to the wearer — the social bet fails on inspection",
  "but_if": "you actually played the album back to back the year it came out — own it loud",
  "let_go": "Crossroads will say no. Donate or scrap as cleaning rag — the cotton is too thin to resell",
  "investment": null,
  "easter_egg": null,
  "color_pairing": null
}

═══ OUTPUT CONTRACT (echo of the examples) ═══
Always include: category, era, archetype, verdict, vibe_line.
KEEP path: populate wear_with (3-5 SPECIFIC pieces), skip (1-2), where (3-4), reference, care. Set TOSS fields null.
TOSS path: populate why_toss, but_if, let_go. Set KEEP fields null. Reference and care optional.
Conditional fields default to null. Only populate when there is a real observation:
  • investment — only if vintage / notable label / resale signal exists
  • easter_egg — only if there is a genuinely hidden detail (lining, hardware, real label era). Default null. If 5 cards in a row had easter_eggs, you're inventing them.
  • color_pairing — only if the color is unusual / hard to place

═══ SPECIFICITY HARD RULES ═══
• wear_with: every entry contains EITHER a real brand-and-cut ("Levi's 501 high rise", "Bass Weejun penny loafer", "Doc Martens 1461") OR an ultra-specific descriptor that names a CUT and a fabric and a color ("cream silk camisole", "white tube sock, visible"). NEVER plain category words alone ("jeans / shoes / top / blazer").
• era: 5-year max range or decade-quarter. NEVER "vintage / classic / modern / contemporary".
• reference: real person + year, real archive + season, real campaign + year. NEVER invent. If unsure: give a precise TYPE ("'90s minimalist editorial muse") — still concrete, never "trend X revival".
• archetype: a SCENE someone steps into. NEVER mood words ("polished casual" is banned — see banned vocabulary above).

═══ VERDICT BALANCE ═══
Target ~70% KEEP / 30% TOSS overall. Triggers for TOSS:
  • palette-orphan: the item's color/print belongs to a wardrobe palette the user clearly doesn't keep
  • era-locked: every styling move points back at one specific narrow era (2014 normcore, 2017 millennial pink, etc.)
  • fabric-failed: cheap synthetic that pills / sheds / sags
  • execution-broken: bad zipper era, plastic buttons on what should be brass, lining that doesn't match the outer
A pretty item with no flaws + plausible neighbors in a closet = KEEP. Don't TOSS to look discerning.

═══ LENGTH CAP ═══
Whole card body ≤ 110 words. Brevity is the voice.`;

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
        { role: "system", content: SYSTEM_PROMPT },
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
    toast("not an image");
    return;
  }
  state.photoDataUrl = await fileToDataURL(f);
  runPipeline();
}

async function runPipeline() {
  const myRun = ++runId;
  hideError();

  showProcessing("UPLOADING", "filing the evidence…");
  let photoUrl;
  try {
    photoUrl = await uploadDataUrl(state.photoDataUrl);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError("upload failed · check your connection");
    return;
  }
  if (myRun !== runId) return;
  state.photoR2Url = photoUrl;

  showProcessing("INSPECTING", "reading the seams…");
  let vision = null;
  try {
    vision = await recognize(photoUrl);
  } catch (err) {
    console.warn("recognize failed", err);
  }
  if (myRun !== runId) return;

  showProcessing("STYLING", "the stylist is thinking…");
  let card;
  try {
    card = await callCard(vision);
  } catch (err) {
    if (myRun !== runId) return;
    console.error(err);
    showError("the stylist stepped out · try again");
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

  // photo + header strip
  photoImg.src = state.photoDataUrl || state.photoR2Url || "";
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
  cardFootEl.textContent = `CASE #${nextCaseNo()} · ${todayLabel()}`;

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

// Track the current gen-image run by card-id-equivalent so a stale image
// from a previous card never paints onto the current one.
let lookRunId = 0;
async function kickOffLook(card) {
  const myRun = ++lookRunId;
  const prompt = buildLookPrompt(card);
  try {
    const url = await genImageLook(prompt, state.photoR2Url || null);
    if (myRun !== lookRunId) return; // user moved on; ignore
    lookImg.src = url;
    lookImg.onload = () => {
      if (myRun !== lookRunId) return;
      lookImg.classList.remove("hidden");
      lookLoading.classList.add("hidden");
    };
    // If the image errors out, leave the loading text in place but mark unloved
    lookImg.onerror = () => {
      if (myRun !== lookRunId) return;
      lookLoading.textContent = "the flatlay didn't develop · tap NEXT FIT";
    };
  } catch (e) {
    if (myRun !== lookRunId) return;
    console.warn("genImageLook failed", e);
    lookLoading.textContent = "the flatlay didn't develop · tap NEXT FIT";
  }
}

function closeVerdict() {
  overlay.classList.remove("show");
  state.photoDataUrl = null;
  state.photoR2Url = null;
  state.card = null;
  // Invalidate any in-flight gen-image so it doesn't paint into the next card.
  lookRunId++;
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
  return String(n).padStart(5, "0");
}

function todayLabel() {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
  return `${month} ${d.getDate()}`;
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
  const issueNo = String(s.total + 1).padStart(3, "0");
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toLowerCase();
  issueLineEl.textContent = `No. ${issueNo} · ${month} ${d.getDate()}`;
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
  renderCaseLog();
  renderIssueLine();
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
