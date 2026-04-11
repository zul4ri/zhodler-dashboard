# Zhodler Dashboard

A personal crypto/TradFi portfolio tracker with live Google Sheets integration. Single `index.html` — no build step, no server.

## Stack

| Layer | Library |
|---|---|
| Layout engine | GridStack v10 |
| Charts | Chart.js v4.4.1 |
| Data source | Google Sheets gviz API (`Dashboard_Data` sheet) |

---

## Widgets (10 total)

| Widget | Description |
|---|---|
| **Global Metrics** | Days tracking, year progress |
| **BTC Overview** | Holdings, price, BTC value, YTD & all-time % |
| **Summary** | Total assets, invested, NW, YTD/AT gains, daily/monthly averages |
| **Debt & Liabilities** | Total debt, crypto/TradFi breakdown, DeFi/CeFi LTV & liquidation price |
| **Projections** | EOY, 1-year, 5-year net worth estimates |
| **Net Worth Velocity** | Annualised, monthly, and daily growth rates + acceleration momentum |
| **Milestone Timeline** | Visual progress bar to $1M across 7 milestones ($50K → $1M), with ETA per milestone |
| **Assets Distribution** | Doughnut chart + table of all individual assets |
| **Yearly Performance** | Bar chart + table of net worth and total assets by year |
| **Monte Carlo FIRE Simulation** | 800-simulation fan chart, P10/P25/P50/P90 outcomes, FIRE probability & median year |

---

## Filter Pills

Four filter buttons in the header control which data all filter-aware widgets display:

| Filter | Data shown |
|---|---|
| **Total Portfolio** | Full portfolio aggregates |
| **Crypto** | Crypto sub-portfolio (DeFi + CeFi breakdown) |
| **TradFi** | Traditional finance sub-portfolio |
| **Liquid** | All assets excluding Real Estate and Motorbike types |

**Filter-aware widgets** (update on every filter switch):
Summary, Debt & Liabilities, Projections, Net Worth Velocity, Milestone Timeline, Monte Carlo FIRE Simulation, Yearly Performance

> The Liquid filter computes asset totals directly from individual asset rows in the sheet. Growth rates (velocity, Monte Carlo) use portfolio-wide averages as an approximation since per-liquid historical data is not in the sheet.

---

## Themes (4)

| Theme | Accent |
|---|---|
| **Zhodler** (default) | Purple |
| **Cyan** | Cyan / blue |
| **Neon** | Purple / green |
| **Cyber** | Teal / green |

---

## Header Controls

| Control | Function |
|---|---|
| Filter pills | Switch data view (Portfolio / Crypto / TradFi / Liquid) |
| Theme dots | Switch colour theme |
| 🔓 Unlocked / 🔒 Locked | Toggle layout lock (prevents accidental moves) |
| ✎ Edit Layout | Enable drag & resize mode |
| 👁 | Toggle privacy mode (blurs all sensitive values) |
| ↺ | Refresh data from Google Sheets |
| ⚙ | Open Settings modal |

---

## Configuration

### Google Sheet

The dashboard reads a single sheet named `Dashboard_Data` from your spreadsheet.

1. Open Settings (⚙) and paste your spreadsheet URL or ID.
2. Click **Save & Reload**.

Default sheet ID: `19FOCRgYHY94QN3Jf7NaeMpGsEbQUdu9bKboYvy4fVpk`

The sheet must be published to the web (File → Share → Publish to web) so the gviz API can read it without authentication.

### Required Sheet: `Dashboard_Data`

The dashboard maps specific row/column indices in `Dashboard_Data`. Key sections:

| Rows | Content |
|---|---|
| 0–1 | Days tracking, year progress |
| 3–14 | Portfolio totals, YTD/AT gains, daily/monthly averages |
| 27–40 | Crypto totals (DeFi, CeFi, YTD/AT breakdown) |
| 41–52 | TradFi totals |
| 54–57 | BTC holdings and price |
| 59–71 | Debt breakdown (crypto, DeFi, CeFi, TradFi, bank) |
| 73–78 | Portfolio and crypto projections (EOY, 1yr, 5yr) |
| 81–92 | Individual assets (name, qty, value, type, platform, status) |
| 95–98 | Yearly snapshots (NW, YoY%, total assets, BTC) |

---

## Layout Management

- **Drag** widgets by their header bar (Edit Layout mode must be on)
- **Resize** from the bottom-right corner (Edit Layout mode must be on)
- **Save**: layout auto-saves to `localStorage` when you exit Edit Layout mode
- **Reset**: Settings ⚙ → Reset Layout
- **Export**: Settings ⚙ → Export Layout (saves a `.json` file)
- **Import**: Settings ⚙ → Import Layout (loads a `.json` file — useful to sync across devices)

---

## Deployment

The dashboard is a single `index.html` file. Host it anywhere that serves static files:

- **GitHub Pages** — push to a repo, enable Pages under Settings → Pages
- **Netlify Drop** — drag the file to [app.netlify.com/drop](https://app.netlify.com/drop)
- **Vercel** — import from GitHub or drag & drop

---

## License

Personal use only.
