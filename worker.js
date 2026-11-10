/*
 * Catalog Cleaner — rule engine.
 * Runs in a Web Worker so the page stays live on large files.
 *
 * Messages in:
 *   { type: "run",   id, rows, rules, ai }              -> sample file
 *   { type: "scale", id, total, seed, rules }           -> generated rows
 * Messages out:
 *   { type: "progress", id, phase, done, total }
 *   { type: "result",   id, rows, removed, flagged, clean, perRule, ms, decisions? }
 */

var CHUNK = 5000;

var ALLOWED = [
  "Dresses", "Tops", "Bottoms", "Outerwear", "Bags",
  "Beauty", "Shoes", "Jewelry", "Watches"
];
var ALLOWED_SET = new Set(ALLOWED);
var BANNED = ["best", "free shipping", "#1", "hot sale"];

var DEFAULTS = {
  minImages: 3,
  maxPrice: 300,
  maxTitle: 200,
  capsPct: 60
};

function number(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(n) {
  return number(n).toFixed(2);
}

/* Share of letters that are upper case. */
function capsRatio(title) {
  var text = String(title || "");
  var letters = 0;
  var caps = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) { letters++; caps++; }
    else if (c >= 97 && c <= 122) { letters++; }
  }
  return letters ? caps / letters : 0;
}

function bannedWord(title) {
  var lower = String(title || "").toLowerCase();
  for (var i = 0; i < BANNED.length; i++) {
    if (lower.indexOf(BANNED[i]) !== -1) return BANNED[i];
  }
  return null;
}

/*
 * Rules run in this order. Removal rules come first, so a row that fails
 * a removal rule is removed even when a flag rule also matches.
 * Each rule returns { decision, rule, reason } or null.
 */
function checkRules(row, rules, duplicateGtin, verdict) {
  var images = number(row.image_count);
  var price = number(row.price);
  var title = String(row.title || "");

  if (rules.r2 && images < rules.minImages) {
    return { decision: "remove", rule: "R2", reason: "Image count below " + rules.minImages };
  }
  if (rules.r4) {
    if (price <= 0) return { decision: "remove", rule: "R4", reason: "Price is 0" };
    if (price > rules.maxPrice) {
      return { decision: "remove", rule: "R4", reason: "Price " + money(price) + " is above " + rules.maxPrice };
    }
  }
  if (rules.r6 && duplicateGtin) {
    return { decision: "remove", rule: "R6", reason: "Duplicate GTIN" };
  }
  if (rules.r7 && !ALLOWED_SET.has(String(row.category || "").trim())) {
    return { decision: "remove", rule: "R7", reason: "Category not allowed" };
  }

  if (rules.r1 && !String(row.brand || "").trim()) {
    return { decision: "flag", rule: "R1", reason: "Brand is missing" };
  }
  if (rules.r3) {
    if (title.length > rules.maxTitle) {
      return { decision: "flag", rule: "R3", reason: "Title is longer than " + rules.maxTitle + " characters" };
    }
    var ratio = capsRatio(title);
    if (ratio * 100 > rules.capsPct) {
      return { decision: "flag", rule: "R3", reason: "Title is " + Math.round(ratio * 100) + "% capital letters" };
    }
  }
  if (rules.r5) {
    var word = bannedWord(title);
    if (word) return { decision: "flag", rule: "R5", reason: "Banned word in title: " + word };
  }
  if (rules.r8 && verdict && verdict.verdict === "flag") {
    var why = (verdict.reasons && verdict.reasons[0]) || "Title or price looks wrong";
    return { decision: "flag", rule: "R8", reason: "AI check: " + why };
  }
  return null;
}

function emptyCounts() {
  return { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0 };
}

function normalizeRules(input) {
  var r = input || {};
  return {
    r1: r.r1 !== false,
    r2: r.r2 !== false,
    r3: r.r3 !== false,
    r4: r.r4 !== false,
    r5: r.r5 !== false,
    r6: r.r6 !== false,
    r7: r.r7 !== false,
    r8: r.r8 !== false,
    minImages: number(r.minImages) || DEFAULTS.minImages,
    maxPrice: number(r.maxPrice) || DEFAULTS.maxPrice,
    maxTitle: number(r.maxTitle) || DEFAULTS.maxTitle,
    capsPct: number(r.capsPct) || DEFAULTS.capsPct
  };
}

/* Process rows in blocks and post progress after each block. */
function processRows(id, rows, rules, verdicts, keepDecisions, startedAt) {
  var counts = emptyCounts();
  var seen = new Set();
  var decisions = keepDecisions ? new Array(rows.length) : null;
  var removed = 0;
  var flagged = 0;
  var total = rows.length;
  var started = startedAt || performance.now();

  for (var start = 0; start < total; start += CHUNK) {
    var end = Math.min(start + CHUNK, total);
    for (var i = start; i < end; i++) {
      var row = rows[i];
      var gtin = String(row.gtin || "").trim();
      var duplicate = false;
      if (gtin) {
        if (seen.has(gtin)) duplicate = true;
        else seen.add(gtin);
      }
      var verdict = verdicts ? verdicts[String(row.sku)] : null;
      var hit = checkRules(row, rules, duplicate, verdict);
      if (hit) {
        counts[hit.rule]++;
        if (hit.decision === "remove") removed++;
        else flagged++;
      } else {
        hit = { decision: "clean", rule: "", reason: "All rules pass" };
      }
      if (decisions) decisions[i] = hit;
    }
    if (end < total) {
      self.postMessage({ type: "progress", id: id, phase: "check", done: end, total: total });
    }
  }

  self.postMessage({
    type: "result",
    id: id,
    rows: total,
    removed: removed,
    flagged: flagged,
    clean: total - removed - flagged,
    perRule: counts,
    ms: performance.now() - started,
    decisions: decisions
  });
}

/* ---------- Scale test data ---------- */

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var BASE = [
  ["Silk Wrap Dress", "Luna Wear", "Dresses", 89],
  ["Cotton Crew T-Shirt", "Basil", "Tops", 24],
  ["Leather Crossbody Bag", "Marlo", "Bags", 145],
  ["Gold Hoop Earrings Set", "Aurel", "Jewelry", 64],
  ["Suede Chelsea Boots", "Stride", "Shoes", 138],
  ["Hydrating Face Serum", "Vela", "Beauty", 38],
  ["Minimalist Steel Watch", "Orin", "Watches", 165],
  ["High-Rise Straight Jeans", "Dune", "Bottoms", 62],
  ["Quilted Puffer Jacket", "Nordia", "Outerwear", 128],
  ["Pleated Midi Skirt", "Luna Wear", "Bottoms", 74],
  ["Pearl Drop Necklace", "Aurel", "Jewelry", 96],
  ["Canvas Low-Top Sneakers", "Stride", "Shoes", 64],
  ["Matte Liquid Foundation", "Vela", "Beauty", 29],
  ["Floral Wrap Blouse", "Basil", "Tops", 42],
  ["Quilted Shoulder Bag", "Marlo", "Bags", 118],
  ["Chronograph Leather Watch", "Orin", "Watches", 210]
];

var LONG_TITLE =
  "Limited Edition Hand Finished Italian Leather Shoulder Bag With Adjustable Strap, " +
  "Gold Hardware, Interior Zip Pocket And Dust Bag, Designed For Everyday Use, Weekend Travel And Gift Giving, With A Refined Finish";

/* Defects sit on fixed cycles, so every run makes the same data. */
function scaleRow(i, next) {
  var base = BASE[i % BASE.length];
  var title = base[0];
  var brand = base[1];
  var category = base[2];
  var price = Math.round(base[3] * (90 + next() * 20)) / 100;

  var images;
  if (i % 37 === 0) images = 2;
  else if (i % 211 === 0) images = 1;
  else images = 3 + Math.floor(next() * 4);

  if (i % 53 === 0) price = 0;
  else if (i % 61 === 0) price = 349;
  if (i % 71 === 0) category = "Electronics";
  if (i % 41 === 0) brand = "";
  if (i % 47 === 0) title = title + " best seller";
  if (i % 59 === 0) title = title.toUpperCase();
  if (i % 97 === 0) title = LONG_TITLE;

  var gtin = i % 1000 === 0 && i > 0
    ? "0" + String(100000000000 + i - 1)
    : "0" + String(100000000000 + i);

  return {
    sku: "SC-" + String(i + 1).padStart(7, "0"),
    asin: "B" + String(i).padStart(9, "0"),
    title: title,
    brand: brand,
    category: category,
    price: price,
    image_count: images,
    bullet_count: 3 + Math.floor(next() * 3),
    gtin: gtin
  };
}

function runScale(id, total, seed, rules) {
  var next = mulberry32(seed);
  var rows = [];
  var started = performance.now();

  for (var start = 0; start < total; start += CHUNK) {
    var end = Math.min(start + CHUNK, total);
    for (var i = start; i < end; i++) rows.push(scaleRow(i, next));
    self.postMessage({ type: "progress", id: id, phase: "make", done: end, total: total });
  }

  processRows(id, rows, rules, null, false, started);
}

self.onmessage = function (event) {
  var msg = event.data || {};
  var rules = normalizeRules(msg.rules);

  if (msg.type === "run") {
    processRows(msg.id, msg.rows || [], rules, (msg.ai && msg.ai.verdicts) || null, true);
  } else if (msg.type === "scale") {
    runScale(msg.id, number(msg.total) || 250000, number(msg.seed) || 42, rules);
  }
};
