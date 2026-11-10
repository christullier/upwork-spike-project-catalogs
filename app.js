/*
 * Catalog Cleaner — page logic.
 * Loads the sample file, sends rows to the worker, draws the result.
 */
(function () {
  "use strict";

  var DEFAULTS = { minImages: 3, maxPrice: 300, maxTitle: 200, capsPct: 60 };
  var RULE_IDS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];
  var LABEL = { remove: "Removed", flag: "Flagged", clean: "Clean" };
  var DATA_LABEL = { remove: "removed", flag: "flagged", clean: "clean" };
  var NUMBER = new Intl.NumberFormat("en-US");

  var state = {
    rows: [],
    decisions: [],
    ai: null,
    filter: "all",
    result: null,
    thresholds: Object.assign({}, DEFAULTS)
  };

  var worker = null;
  var sampleSeq = 0;
  var scaleSeq = 1000;
  var scale = null;          // { id, start, phase, done, total }
  var scaleTimer = null;
  var runTimer = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(value) {
    var n = Number(value);
    return (Number.isFinite(n) ? n : 0).toFixed(2);
  }

  function count(value) {
    return NUMBER.format(value || 0);
  }

  /* ---------- CSV ---------- */

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c !== "\r") {
        field += c;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ""; }); });
  }

  function rowsFromCsv(table) {
    if (!table.length) return [];
    var head = table[0].map(function (h) { return String(h).trim(); });
    return table.slice(1).map(function (cells) {
      var row = {};
      head.forEach(function (key, i) {
        var value = cells[i] == null ? "" : String(cells[i]).trim();
        row[key] = value;
      });
      row.price = Number(row.price) || 0;
      row.image_count = Number(row.image_count) || 0;
      row.bullet_count = Number(row.bullet_count) || 0;
      return row;
    });
  }

  function csvCell(value) {
    var s = String(value == null ? "" : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------- Rules ---------- */

  function ruleConfig() {
    var enabled = {};
    RULE_IDS.forEach(function (id) {
      var box = $("toggle-" + id);
      enabled[id] = !box || box.checked;
    });
    return Object.assign({}, state.thresholds, enabled);
  }

  function readThresholds() {
    var t = state.thresholds;
    var minImages = Number($("minImages").value);
    var maxPrice = Number($("maxPrice").value);
    var maxTitle = Number($("maxTitle").value);
    var capsPct = Number($("capsPct").value);
    t.minImages = Number.isFinite(minImages) ? Math.min(20, Math.max(1, Math.round(minImages))) : DEFAULTS.minImages;
    t.maxPrice = Number.isFinite(maxPrice) && maxPrice > 0 ? Math.min(100000, maxPrice) : DEFAULTS.maxPrice;
    t.maxTitle = Number.isFinite(maxTitle) ? Math.min(2000, Math.max(20, Math.round(maxTitle))) : DEFAULTS.maxTitle;
    t.capsPct = Number.isFinite(capsPct) ? Math.min(100, Math.max(10, Math.round(capsPct))) : DEFAULTS.capsPct;
  }

  function syncRuleState() {
    RULE_IDS.forEach(function (id) {
      var box = $("toggle-" + id);
      var item = box ? box.closest(".rule") : null;
      if (item) item.classList.toggle("is-off", !box.checked);
    });
  }

  /* ---------- Run ---------- */

  function runSample() {
    if (!worker || !state.rows.length) return;
    readThresholds();
    sampleSeq++;
    state.runId = sampleSeq;
    worker.postMessage({
      type: "run",
      id: sampleSeq,
      rows: state.rows,
      rules: ruleConfig(),
      ai: state.ai
    });
  }

  function scheduleSample() {
    syncRuleState();
    clearTimeout(runTimer);
    runTimer = setTimeout(runSample, 220);
  }

  function startScale() {
    if (!worker || scale) return;
    readThresholds();
    scaleSeq++;
    scale = { id: scaleSeq, start: performance.now(), phase: "make", done: 0, total: 250000 };
    $("scale-run").disabled = true;
    $("scale-rows").textContent = "—";
    $("scale-removed").textContent = "—";
    $("scale-flagged").textContent = "—";
    $("scale-clean").textContent = "—";
    $("scale-ms").textContent = "—";
    $("scale-rps").textContent = "—";
    setBar(0);
    renderScaleStatus();
    clearInterval(scaleTimer);
    scaleTimer = setInterval(renderScaleStatus, 120);
    worker.postMessage({
      type: "scale",
      id: scale.id,
      total: scale.total,
      seed: 20261110,
      rules: ruleConfig()
    });
  }

  function setBar(pct) {
    var value = Math.max(0, Math.min(100, pct));
    $("scale-bar").style.width = value + "%";
    $("scale-progress").setAttribute("aria-valuenow", String(Math.round(value)));
  }

  function renderScaleStatus() {
    if (!scale) return;
    var seconds = (performance.now() - scale.start) / 1000;
    var share = scale.done / scale.total;
    var pct = scale.phase === "make" ? share * 45 : 45 + share * 55;
    setBar(pct);
    var phase = scale.phase === "make" ? "Making rows" : "Checking rules";
    $("scale-status").textContent = phase + " · " + Math.round(share * 100) + "% · " + seconds.toFixed(1) + " s";
  }

  function finishScale(msg) {
    if (!scale || msg.id !== scale.id) return;
    clearInterval(scaleTimer);
    var seconds = msg.ms / 1000;
    var perSecond = msg.ms > 0 ? Math.round(msg.rows / (msg.ms / 1000)) : msg.rows;
    $("scale-status").textContent = "Done in " + seconds.toFixed(2) + " s";
    $("scale-rows").textContent = count(msg.rows);
    $("scale-removed").textContent = count(msg.removed);
    $("scale-flagged").textContent = count(msg.flagged);
    $("scale-clean").textContent = count(msg.clean);
    $("scale-ms").textContent = seconds.toFixed(2) + " s";
    $("scale-rps").textContent = count(perSecond);
    setBar(100);
    $("scale-run").disabled = false;
    scale = null;
  }

  /* ---------- Render ---------- */

  function render() {
    var result = state.result;
    if (!result) return;

    $("header-rows").textContent = count(result.rows) + " rows";
    $("count-removed").textContent = count(result.removed);
    $("count-flagged").textContent = count(result.flagged);
    $("count-clean").textContent = count(result.clean);
    var ms = result.ms;
    var taken = ms < 1 ? "<1 ms" : (ms < 10 ? ms.toFixed(1) : count(Math.round(ms))) + " ms";
    $("rules-sub").textContent = count(result.rows) + " rows read · " + taken;

    RULE_IDS.forEach(function (id) {
      var key = id.toUpperCase();
      var target = $("count-" + id);
      if (target) target.textContent = count((result.perRule && result.perRule[key]) || 0);
    });

    $("filter-all").textContent = count(result.rows);
    $("filter-remove").textContent = count(result.removed);
    $("filter-flag").textContent = count(result.flagged);
    $("filter-clean").textContent = count(result.clean);

    $("queue-summary").textContent = count(result.rows) + " items · " +
      count(result.removed) + " removed · " + count(result.flagged) + " flagged · " +
      count(result.clean) + " clean";

    $("download").disabled = false;
    renderTable();
  }

  function renderTable() {
    var body = $("rows-body");
    var shown = 0;
    var html = "";

    state.rows.forEach(function (row, i) {
      var decision = state.decisions[i] || { decision: "clean", rule: "", reason: "All rules pass" };
      if (state.filter !== "all" && decision.decision !== state.filter) return;
      shown++;
      var label = LABEL[decision.decision] || "Clean";
      var ruleTag = decision.rule
        ? '<span class="rid ' + (decision.decision === "remove" ? "rid-remove" : "rid-flag") + '">' + esc(decision.rule) + "</span>"
        : "";
      html +=
        '<tr tabindex="0" data-i="' + i + '">' +
          '<td class="cell-sku">' + esc(row.sku) + "</td>" +
          '<td class="cell-title" title="' + esc(row.title) + '">' + esc(row.title) +
            '<span class="cell-meta">' + esc(row.category) + " · $" + money(row.price) + " · " +
            esc(row.image_count) + " images</span></td>" +
          '<td class="cell-cat">' + esc(row.category) + "</td>" +
          '<td class="right cell-price">$' + money(row.price) + "</td>" +
          '<td class="cell-images">' + esc(row.image_count) + "</td>" +
          '<td><span class="badge badge-' + decision.decision + '">' + label + "</span></td>" +
          '<td class="cell-reason" title="' + esc(decision.reason) + '">' + ruleTag + esc(decision.reason) + "</td>" +
        "</tr>";
    });

    if (!shown) {
      html = '<tr><td colspan="7" class="empty">No items in this filter.</td></tr>';
    }
    body.innerHTML = html;

    Array.prototype.forEach.call(document.querySelectorAll("#filter .chip"), function (chip) {
      var active = chip.getAttribute("data-filter") === state.filter;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  /* ---------- Detail ---------- */

  function openDetail(index) {
    var row = state.rows[index];
    if (!row) return;
    var d = state.decisions[index] || { decision: "clean", rule: "", reason: "All rules pass" };

    $("detail-sku").textContent = row.sku;
    $("detail-title").textContent = row.title;

    var box = $("detail-decision");
    box.className = "dialog-decision is-" + d.decision;
    box.innerHTML =
      '<span class="badge badge-' + d.decision + '">' + (LABEL[d.decision] || "Clean") + "</span>" +
      "<span>" + esc(d.reason) + "</span>" +
      (d.rule ? '<span class="rid">' + esc(d.rule) + "</span>" : "");

    var fields = [
      ["ASIN", row.asin],
      ["Brand", row.brand || "—"],
      ["Category", row.category],
      ["Price", "$" + money(row.price)],
      ["Image count", row.image_count],
      ["Bullet count", row.bullet_count],
      ["GTIN", row.gtin],
      ["Decision", LABEL[d.decision] || "Clean"],
      ["Rule", d.rule || "—"]
    ];

    var html = '<dl class="kv">';
    fields.forEach(function (pair) {
      html += "<dt>" + esc(pair[0]) + "</dt><dd>" + esc(pair[1]) + "</dd>";
    });
    html += "</dl>";

    var verdict = state.ai && state.ai.verdicts ? state.ai.verdicts[row.sku] : null;
    if (verdict) {
      html += '<p class="ai-line"><b>AI verdict (sample): ' + esc(verdict.verdict) + "</b><br>" +
        esc((verdict.reasons || []).join(" ")) + "</p>";
    }
    $("detail-body").innerHTML = html;

    var dialog = $("detail");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  /* ---------- Download ---------- */

  function download() {
    if (!state.rows.length) return;
    var head = ["sku", "asin", "title", "brand", "category", "price", "image_count",
      "bullet_count", "gtin", "decision", "reason", "rule"];
    var lines = [head.join(",")];

    state.rows.forEach(function (row, i) {
      var d = state.decisions[i] || { decision: "clean", rule: "", reason: "All rules pass" };
      lines.push([
        row.sku, row.asin, row.title, row.brand, row.category, money(row.price),
        row.image_count, row.bullet_count, row.gtin,
        DATA_LABEL[d.decision] || "clean", d.reason, d.rule
      ].map(csvCell).join(","));
    });

    var blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "decisions.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- Events ---------- */

  function bind() {
    RULE_IDS.forEach(function (id) {
      var box = $("toggle-" + id);
      if (box) box.addEventListener("change", scheduleSample);
    });

    ["minImages", "maxPrice", "maxTitle", "capsPct"].forEach(function (id) {
      var input = $(id);
      if (input) input.addEventListener("input", scheduleSample);
    });

    $("reset-rules").addEventListener("click", function () {
      RULE_IDS.forEach(function (id) {
        var box = $("toggle-" + id);
        if (box) box.checked = true;
      });
      $("minImages").value = DEFAULTS.minImages;
      $("maxPrice").value = DEFAULTS.maxPrice;
      $("maxTitle").value = DEFAULTS.maxTitle;
      $("capsPct").value = DEFAULTS.capsPct;
      state.thresholds = Object.assign({}, DEFAULTS);
      scheduleSample();
    });

    $("filter").addEventListener("click", function (event) {
      var chip = event.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.getAttribute("data-filter");
      renderTable();
    });

    $("download").addEventListener("click", download);
    $("scale-run").addEventListener("click", startScale);
    $("detail-close").addEventListener("click", function () { $("detail").close(); });

    $("detail").addEventListener("click", function (event) {
      if (event.target === $("detail")) $("detail").close();
    });

    $("rows-body").addEventListener("click", function (event) {
      var tr = event.target.closest("tr[data-i]");
      if (tr) openDetail(Number(tr.getAttribute("data-i")));
    });

    $("rows-body").addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var tr = event.target.closest("tr[data-i]");
      if (!tr) return;
      event.preventDefault();
      openDetail(Number(tr.getAttribute("data-i")));
    });
  }

  /* ---------- Start ---------- */

  function fail(message) {
    var box = $("load-error");
    box.textContent = message;
    box.hidden = false;
    $("queue-summary").textContent = "The sample catalog did not load.";
  }

  function onMessage(event) {
    var msg = event.data || {};

    if (msg.type === "progress") {
      if (scale && msg.id === scale.id) {
        scale.phase = msg.phase;
        scale.done = msg.done;
        scale.total = msg.total;
        renderScaleStatus();
      }
      return;
    }

    if (msg.type !== "result") return;

    if (scale && msg.id === scale.id) {
      finishScale(msg);
      return;
    }

    if (msg.id !== state.runId) return;
    state.result = msg;
    state.decisions = msg.decisions || [];
    render();
  }

  function load() {
    worker = new Worker("worker.js");
    worker.onmessage = onMessage;
    worker.onerror = function (event) {
      fail("The rule engine stopped: " + (event.message || "unknown error") + ".");
    };

    Promise.all([
      fetch("data/sample-catalog.csv").then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " for the catalog file");
        return r.text();
      }),
      fetch("data/ai-sample.json").then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " for the AI sample file");
        return r.json();
      })
    ]).then(function (files) {
      state.rows = rowsFromCsv(parseCsv(files[0]));
      state.ai = files[1];
      if (!state.rows.length) throw new Error("The sample catalog has no rows.");
      runSample();
    }).catch(function (err) {
      fail("Could not load the sample data. " + err.message + ". Open the folder with a static server.");
    });
  }

  function init() {
    els = {};
    bind();
    syncRuleState();
    load();
    requestAnimationFrame(function () { document.body.classList.add("is-ready"); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
