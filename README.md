# The Afro Index 🔴

**[afro-index.vercel.app](https://afro-index.vercel.app)**

## The Story

On **October 5, 2024**, Manchester United fan [Frank Ilett](https://youtube.com/@TheUnitedStrand) — known as "The United Strand" — made a bold vow: **he won't cut his hair until United wins 5 matches in a row.** 

Since then, Frank has grown a magnificent afro, amassed 1.5 million followers, and become a symbol of long-suffering United fandom. Even players like Diogo Dalot are aware of his challenge and want to help him get that haircut!

The Afro Index tracks every football team that has achieved what United hasn't — **5+ consecutive wins** since Frank's vow. It's a leaderboard of humiliation, updated automatically whenever you visit the site.

> When United finally gets 5 in a row, Frank will donate his hair to the [Little Princess Trust](https://www.littleprincesses.org.uk/) 💇‍♂️❤️

---

## Features

- 📊 **Live Leaderboard** — 50+ teams sorted by who achieved 5 wins first
- ⚽ **12 Competitions** — Top 5 European leagues, Champions League, Brasileirão, and more
- 🔄 **Auto-Scan** — Refreshes data automatically when you visit
- � **Easter Egg** — A special celebration awaits when United finally makes it
- � **Day Tracking** — See how many days into Frank's vow each team achieved the streak

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML + Tailwind CSS |
| Backend | Vercel Serverless Functions |
| Database | Supabase (PostgreSQL) |
| API | [football-data.org](https://football-data.org) |

---

## Local Development

```bash
git clone https://github.com/ArmaanSethi/afro-index.git
cd afro-index

# Create .env.local with your keys
echo "SUPABASE_URL=your_url" > .env.local
echo "SUPABASE_SERVICE_KEY=your_key" >> .env.local
echo "FOOTBALL_DATA_API_KEY=your_key" >> .env.local

# Run locally
npx vercel dev
```

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/teams` | Returns qualifying teams sorted by achievement date |
| `GET /api/scan` | Scans the next league in priority queue |

---

## License

MIT — Built with ❤️ for the United faithful.
