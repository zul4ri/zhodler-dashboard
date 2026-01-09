# Zhodler 2026F Dashboard

A personal cryptocurrency/DeFi portfolio tracker with real-time Google Sheets integration.

## Features

- 📊 Real-time portfolio tracking via Google Sheets
- 📈 11 interactive widgets (KPIs, charts, goals, projections)
- 🎨 10 color themes (Dark, Light, Ocean, Sunset, Neon, Corporate, Moody, Navy Gold, Gold, HAL)
- 🔒 Privacy mode to blur sensitive data
- 📱 Responsive design for mobile/tablet/desktop
- 🖱️ Drag-and-drop widget layout

## Quick Deploy

### Option 1: Netlify (Fastest)
1. Go to [netlify.com/drop](https://app.netlify.com/drop)
2. Drag the entire `zhodler-deploy` folder onto the page
3. Done! You'll get a URL instantly

### Option 2: GitHub Pages
1. Create a new GitHub repository
2. Upload all files from this folder
3. Go to Settings → Pages → Enable from `main` branch
4. Access at `https://yourusername.github.io/repo-name/`

### Option 3: Vercel
1. Go to [vercel.com](https://vercel.com)
2. Import from GitHub or drag & drop folder
3. Deploy with one click

## Configuration

### Google Sheets Setup
1. Open your Google Sheets document
2. Go to **File → Share → Publish to web**
3. Click **Publish** (entire document)
4. Copy your spreadsheet URL
5. Paste it in the dashboard's Settings (⚙️ icon)

### Required Sheets
- `Performance` - Portfolio performance metrics
- `BTCCrypto` - BTC holdings and collateral
- `Loans` - DeFi loan details
- `AssetDistro` - Asset distribution
- `Split folio` - Shared portfolio assets
- `Goals` - Financial goals
- `Projections` - Portfolio projections
- `TimePassed` - Time tracking

## Usage

- **Change theme**: Use dropdown in header
- **Privacy mode**: Click 🔒 button to blur sensitive data
- **Rearrange widgets**: Drag by header, resize from edges
- **Reset layout**: Click ↩️ Reset Layout button
- **Refresh data**: Click 🔄 Refresh button

## License

Personal use only.
