# Catalog Cleaner

A working demo of a catalog cleaning agent for Amazon flat files. It is a static
site with no build step, no server code, no API key and no login.

## What the demo shows

The page loads a 40-row sample catalog. It applies 8 rules and gives each item one
decision: removed, flagged or clean. Each decision has a reason. The sample result
is **11 removed, 9 flagged, 20 clean**.

- **Rules panel.** Each rule has an on/off switch and a count of the rows it
  decided. Four thresholds are editable: minimum image count, maximum price,
  maximum title length and maximum share of capital letters. Removal rules run
  before flag rules, so the first match sets the decision.
- **Review queue.** A table with SKU, title, category, price, image count, decision
  and reason. The filter shows all rows or one decision. A click on a row opens the
  full item data, the rule and the reason.
- **decisions.csv.** One row for each item, with the decision, the reason and the
  rule. The file opens in a spreadsheet.
- **Scale test.** The browser makes 250,000 rows from a fixed seed and checks them
  with the same rule engine in a Web Worker. The panel shows the row count, the
  removals, the flags, the run time and the rows per second. The progress bar moves
  and the page stays active.

## Rules

| Rule | Action | Test |
| --- | --- | --- |
| R1 | Flag | Brand is missing |
| R2 | Remove | Image count is below the minimum (default 3) |
| R3 | Flag | Title is longer than the limit (default 200), or more than 60% capital letters |
| R4 | Remove | Price is 0, or above the limit (default 300 USD) |
| R5 | Flag | Title has a banned word: best, free shipping, #1, hot sale |
| R6 | Remove | The same GTIN occurs again; the later row is removed |
| R7 | Remove | Category is not in the allowed list |
| R8 | Flag | AI check: no brand word in the title, or a price far from the category median |

Allowed categories: Dresses, Tops, Bottoms, Outerwear, Bags, Beauty, Shoes,
Jewelry, Watches.

## The AI rule

R8 reads `data/ai-sample.json`. That file holds 9 sample verdicts for 9 SKUs. The
page shows the note: "Sample AI output. In production a model call replaces this
file."

The demo does not make a model call. In production, a batch model call replaces the
sample file and returns the same verdict format. The scale test runs R1 to R7 only,
because R8 needs one model call for each item.

## Run it

Open `index.html` through a local static server, because the browser must fetch the
sample files:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Files

```
index.html            page
styles.css            layout and styles
app.js                CSV load, table, filters, CSV download, scale test
worker.js             rule engine and scale data (Web Worker)
data/sample-catalog.csv   40-row sample file
data/ai-sample.json       9 sample AI verdicts
```

## Deploy

Cloudflare Pages, static files: no build command, output directory `/`.
