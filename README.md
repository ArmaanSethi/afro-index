# The Afro Index 🔴

**Live:** [afro-index.vercel.app](https://afro-index.vercel.app)

A leaderboard tracking every football team that has achieved 5+ consecutive wins since October 5, 2024 — the day Manchester United fan Frank Ilett vowed not to cut his hair until United won 5 in a row.

## Features

- 📊 **Live Leaderboard** — 56+ teams sorted by win streak
- ⚽ **12 Competitions** — Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League, and more
- 🔄 **Auto-Scan** — Automatically refreshes data when visitors load the page
- 🎯 **Smart Priority** — Scans oldest-updated leagues first
- 📱 **Dark Mode UI** — Responsive glassmorphism design

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML + Tailwind CSS |
| Backend | Vercel Serverless Functions |
| Database | Supabase (PostgreSQL) |
| API | [football-data.org](https://football-data.org) |

## Quick Start

```bash
# Clone
git clone https://github.com/ArmaanSethi/afro-index.git
cd afro-index

# Install Vercel CLI
npm i -g vercel

# Create .env.local
echo "SUPABASE_URL=your_url" > .env.local
echo "SUPABASE_SERVICE_KEY=your_key" >> .env.local
echo "FOOTBALL_DATA_API_KEY=your_key" >> .env.local

# Run locally
vercel dev
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/teams` | Returns qualifying teams sorted by streak |
| `GET /api/scan` | Scans the highest priority competition |
| `GET /api/scan?competition=PL` | Scans a specific competition |

## Supported Competitions

PL, PD, BL1, SA, FL1, DED, PPL, ELC, CL, EC, WC, BSA

## License

MIT
