# Has United Won 5? 🔴

**The "Has United Won 5?" Tracker**

## The Story

On **October 5, 2024**, Manchester United fan [Frank Ilett](https://instagram.com/theunitedstrand) — known as "The United Strand" — made a bold vow: **he won't cut his hair until United wins 5 matches in a row.** 

Since then, Frank has grown a magnificent afro, amassed over 1.5 million followers, and become a symbol of long-suffering United fandom. Even players like Diogo Dalot are aware of his challenge and want to help him get that haircut!

This website tracks every football team that has achieved what United hasn't — **5+ consecutive wins** since Frank's vow. It's a leaderboard of humiliation, updated automatically whenever you visit.

> When United finally gets 5 in a row, Frank will donate his hair to the [Little Princess Trust](https://www.littleprincesses.org.uk/) 💇‍♂️❤️

---

## Features

- 📊 **Live Leaderboard** — 50+ teams sorted by who achieved 5 wins first
- ⚽ **12 Competitions** — Top 5 European leagues, Champions League, Brasileirão, and more
- 🔄 **Distributed Cron** — Visitors automatically trigger updates for "Big 5" leagues every 2 mins
- ⏰ **Daily Maintenance** — Automated full-scan at 06:00 UTC (Post-matches) to ensure data consistency
- 🔍 **Search & Filter** — Instant multi-select filtering by league and team name
- 🎉 **Easter Egg** — A special celebration awaits when United finally makes it
- 📅 **Day Tracking** — See how many days into Frank's vow each team achieved the streak

---

## Roadmap

- [ ] 🐦 **Twitter Bot** — Auto-tweet when a new team achieves 5+ wins
- [x] ⏰ **Cron Jobs** — Daily scheduled maintenance scans
- [x] 🔍 **Search & Filter** — Multi-select filtering and instant search
- [ ] 🏀 **NBA / 🏈 NFL** — Expand to other sports
- [ ] 📈 **Historical Charts** — Visualize when streaks started/ended

---

### ⚡️ Zero-Waste Architecture
- **Distributed Scanning**: Clients trigger scans, but Vercel caches the request for 10s, preventing API flooding.
- **Smart Guard**: Backend logic ABORTS scans if the target league is fresh (15m/60m thresholds), ensuring $0 waste.
- **Shared Brain**: All data is written to Supabase, so 1 user's scan updates the site for everyone instantly.

## 🛠 Tech Stack

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

## Credits

Built by [Armaan Sethi](https://github.com/ArmaanSethi) • Inspired by [The United Strand](https://instagram.com/theunitedstrand)

## License

MIT
