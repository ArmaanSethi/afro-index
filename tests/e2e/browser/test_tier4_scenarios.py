"""Tier 4 Browser E2E tests — Full Real-World User & Crawler Journeys."""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright

from fixtures import (
    normal_teams_payload,
    normal_united_payload,
    teams_with_united_winner_payload,
    united_victory_payload,
)
from server import LocalE2EServer, install_offline_routes, launch_browser


class Tier4BrowserScenariosTest(unittest.TestCase):
    server: LocalE2EServer
    pw: object
    browser: object

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = LocalE2EServer().start()
        cls.pw = sync_playwright().start()
        cls.browser = launch_browser(cls.pw)

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            if getattr(cls, "browser", None):
                cls.browser.close()
        finally:
            try:
                if getattr(cls, "pw", None):
                    cls.pw.stop()
            finally:
                if getattr(cls, "server", None):
                    cls.server.stop()

    def setUp(self) -> None:
        self.server.reset()
        self.server.set_api_response("/api/teams", normal_teams_payload(self.server.base_url))
        self.server.set_api_response("/api/united", normal_united_payload(self.server.base_url))

    def _new_page(self, **context_kwargs):
        ctx = self.browser.new_context(**context_kwargs)
        unexpected = install_offline_routes(ctx, self.server.base_url)
        page = ctx.new_page()
        page_errors: list[str] = []
        console_errors: list[str] = []
        http_errors: list[tuple[int, str]] = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("response", lambda resp: http_errors.append((resp.status, resp.url)) if resp.status >= 400 else None)
        return ctx, page, page_errors, console_errors, http_errors, unexpected

    def test_journey1_first_time_visitor_discovery(self) -> None:
        ctx, page, page_errors, console_errors, http_errors, unexpected = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # Hero hydration
            self.assertEqual(page.locator("#united-answer").inner_text().strip(), "NO")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5")
            self.assertEqual(page.locator("#leagues-count").inner_text().strip(), "12")
            self.assertEqual(page.locator("#united-streak").inner_text().strip(), "2")

            # Search diacritic -> clear -> multi-filter PL + PD -> sort
            page.locator("#search-input").fill("atletico")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5")
            self.assertIn("1", page.locator("#results-summary").inner_text())

            page.locator("#search-input").fill("")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            page.locator('.filter-btn[data-league="PL"]').click()
            page.locator('.filter-btn[data-league="PD"]').click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 3")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5")

            # Expand FAQ <details>
            first_faq = page.locator("details").first
            first_faq.locator("summary").click()
            self.assertTrue(first_faq.evaluate("el => el.open"), "FAQ <details> must open on click")

            # Switch to Other tab and back
            page.locator('.tab-btn[data-tab="other"]').click()
            self.assertTrue(page.locator("#other-tab").is_visible())
            page.locator('.tab-btn[data-tab="football"]').click()
            self.assertTrue(page.locator("#football-tab").is_visible())

            self.assertEqual(page_errors, [])
            self.assertEqual(console_errors, [])
            self.assertEqual(http_errors, [])
            self.assertEqual(unexpected, [])
        finally:
            ctx.close()

    def test_journey2_power_user_across_refresh_cycles(self) -> None:
        ctx, page, page_errors, console_errors, _, _ = self._new_page()
        try:
            page.clock.install()
            page.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            page.clock.run_for(500)
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # Filter PL + BL1
            page.locator('.filter-btn[data-league="PL"]').click()
            page.locator('.filter-btn[data-league="BL1"]').click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 3")

            # Cycle 1: Backend adds Newcastle (PL) -> total 6, filtered 4
            cycle1 = normal_teams_payload(self.server.base_url)
            cycle1["teams"].append(
                {
                    "team_id": 67,
                    "name": "Newcastle United FC",
                    "logo": f"{self.server.base_url}/mock-crest/67.png",
                    "country_name": "England",
                    "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
                    "league_id": "PL",
                    "league_name": "Premier League",
                    "form": "WWWWW",
                    "has_5_wins": True,
                    "max_streak": 5,
                    "streak_achieved_date": "2025-02-25",
                    "first_detected": "2025-02-25T18:00:00Z",
                    "last_checked": "2025-03-15T12:00:00Z",
                }
            )
            cycle1["winnersCount"] = len(cycle1["teams"])
            self.server.set_api_response("/api/teams", cycle1)
            self.server.clear_requests()

            page.clock.run_for(185_000)
            page.wait_for_function("document.getElementById('team-count').textContent.trim() === '6'")
            self.assertEqual(page.locator("#teams-grid > div").count(), 4)
            self.assertIn("Newcastle United FC", page.locator("#teams-grid").inner_text())

            # Cycle 2: Backend drops BL1 -> stale BL1 filter pruned, PL filter stays active (3 PL teams)
            cycle2 = normal_teams_payload(self.server.base_url)
            cycle2["teams"] = [t for t in cycle1["teams"] if t["league_id"] != "BL1"]
            cycle2["winnersCount"] = len(cycle2["teams"])
            self.server.set_api_response("/api/teams", cycle2)

            page.clock.run_for(185_000)
            page.wait_for_function("document.getElementById('team-count').textContent.trim() === '5'")
            self.assertEqual(page.locator("#teams-grid > div").count(), 3)
            self.assertEqual(page.locator('.filter-btn[data-league="PL"]').get_attribute("aria-pressed"), "true")

            self.assertEqual(page_errors, [])
            self.assertEqual(console_errors, [])
        finally:
            ctx.close()

    def test_journey3_api_outage_and_recovery(self) -> None:
        self.server.set_api_response("/api/teams", {"error": "Service Unavailable"}, status=500)
        self.server.set_api_response("/api/united", {"error": "Service Unavailable"}, status=500)

        ctx, page, page_errors, _, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            page.wait_for_function("document.getElementById('loading-state').classList.contains('hidden')", timeout=5000)

            empty_state = page.locator("#empty-state")
            self.assertTrue(empty_state.is_visible())
            self.assertNotIn("Loading teams", empty_state.inner_text())

            united_retry_btn = page.locator("#united-retry-btn, #retry-united-status-btn").first
            united_retry_btn.wait_for(state="visible", timeout=5000)

            # Backend recovers
            self.server.set_api_response("/api/teams", normal_teams_payload(self.server.base_url))
            self.server.set_api_response("/api/united", normal_united_payload(self.server.base_url))

            # Click retry buttons for both leaderboard and United status (or reload if absent)
            retry_btn = empty_state.locator("button").first
            if retry_btn.count() > 0 and retry_btn.is_visible():
                retry_btn.click()
                if united_retry_btn.count() > 0 and united_retry_btn.is_visible():
                    united_retry_btn.click()
            else:
                page.reload(wait_until="domcontentloaded")

            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5", timeout=5000)
            page.wait_for_function("document.getElementById('united-answer').textContent.trim() === 'NO'", timeout=5000)
            self.assertEqual(page.locator("#united-answer").inner_text().strip(), "NO")
            self.assertEqual(page.locator("#united-form").inner_text().strip().replace("\n", ""), "WWLDW")
            self.assertFalse(page.locator("#empty-state").is_visible())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_journey4_united_victory_full_celebration_lifecycle(self) -> None:
        self.server.set_api_response("/api/teams", teams_with_united_winner_payload(self.server.base_url))
        self.server.set_api_response(
            "/api/united",
            united_victory_payload(self.server.base_url, achievement_date="2025-03-15T16:30:00Z"),
        )

        ctx, page, page_errors, console_errors, _, _ = self._new_page(timezone_id="Europe/London")
        navigations = 0

        def _on_nav(frame):
            nonlocal navigations
            if frame == page.main_frame:
                navigations += 1

        page.on("framenavigated", _on_nav)

        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            overlay = page.locator("#celebration-overlay")
            overlay.wait_for(state="visible", timeout=5000)

            self.assertEqual(page.locator("#united-answer").inner_text().strip(), "YES")
            self.assertEqual(page.locator("#celebration-overlay").count(), 1)
            self.assertEqual(overlay.get_attribute("role"), "dialog")

            ov_text = overlay.inner_text()
            self.assertIn("16:30:00", ov_text)
            self.assertIn("161", ov_text)

            # Dismiss via Escape
            navs_before = navigations
            page.keyboard.press("Escape")
            page.wait_for_function("!document.getElementById('celebration-overlay')", timeout=3000)
            page.wait_for_timeout(500)

            self.assertEqual(navigations, navs_before, "Escape dismiss must NOT trigger reload loop")
            self.assertEqual(page.locator("#confetti-canvas").count(), 0, "Confetti canvas should be cleaned up on dismiss")

            # Leaderboard & Man United card remain fully browsable & searchable
            self.assertTrue(page.locator("#leaderboard").is_visible())
            page.locator("#search-input").fill("Manchester United")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertIn("Manchester United FC", page.locator("#teams-grid").inner_text())

            self.assertEqual(page_errors, [])
            self.assertEqual(console_errors, [])
        finally:
            ctx.close()

    def test_journey5_crawler_seo_and_performance_audit(self) -> None:
        ctx, page, page_errors, console_errors, http_errors, unexpected = self._new_page()
        font_urls: set[str] = set()
        page.on(
            "response",
            lambda resp: font_urls.add(resp.url) if "/fonts/" in resp.url else None,
        )

        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")
            page.evaluate("() => document.fonts.ready")

            # 1. Runtime cleanliness
            self.assertEqual(console_errors, [], f"Console errors: {console_errors}")
            self.assertEqual(page_errors, [], f"Page errors: {page_errors}")
            self.assertEqual(http_errors, [], f"HTTP 4xx/5xx errors: {http_errors}")
            self.assertEqual(unexpected, [], f"Unexpected external requests: {unexpected}")

            # 2. 3 valid JSON-LD structured data blocks
            ld_texts = page.locator('script[type="application/ld+json"]').all_inner_texts()
            self.assertEqual(len(ld_texts), 3, f"Expected 3 JSON-LD blocks, found {len(ld_texts)}")
            parsed_ld = [json.loads(t) for t in ld_texts]
            types = {doc.get("@type") for doc in parsed_ld}
            self.assertEqual(types, {"WebSite", "Person", "FAQPage"})

            website_ld = next(d for d in parsed_ld if d.get("@type") == "WebSite")
            self.assertEqual(website_ld.get("url"), "https://www.hasunitedwon5.com/")

            faq_ld = next(d for d in parsed_ld if d.get("@type") == "FAQPage")
            self.assertGreaterEqual(len(faq_ld.get("mainEntity", [])), 4)

            # 3. All visible <img> loaded cleanly
            broken_imgs = page.evaluate(
                """() => [...document.querySelectorAll('img')]
                    .filter(img => img.offsetParent !== null && (!img.complete || img.naturalWidth === 0))
                    .map(img => img.src)"""
            )
            self.assertEqual(broken_imgs, [], f"Broken visible images: {broken_imgs}")

            # 4. Single Inter font downloaded
            inter_fonts = [u for u in font_urls if re.search(r"/fonts/inter-.*\.woff2", u, re.I)]
            self.assertEqual(
                len(inter_fonts),
                1,
                f"Expected exactly 1 Inter font file downloaded, got {inter_fonts}",
            )

            # 5. Canonical www. share URLs in celebration overlay
            self.server.set_api_response("/api/united", united_victory_payload(self.server.base_url))
            page.reload(wait_until="networkidle")
            overlay = page.locator("#celebration-overlay")
            overlay.wait_for(state="visible", timeout=5000)
            hrefs = overlay.evaluate("el => [...el.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')")
            share_hrefs = [unquote(h) for h in hrefs if "hasunitedwon5.com" in unquote(h)]
            self.assertTrue(len(share_hrefs) > 0)
            for sh in share_hrefs:
                self.assertIn("https://www.hasunitedwon5.com", sh)
                self.assertNotIn("https://hasunitedwon5.com", sh)
        finally:
            ctx.close()

        # 6. No-JS crawler pass
        nojs_ctx = self.browser.new_context(java_script_enabled=False)
        try:
            install_offline_routes(nojs_ctx, self.server.base_url)
            nojs_page = nojs_ctx.new_page()
            nojs_page.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            self.assertEqual(nojs_page.locator("h1").count(), 1)
            self.assertTrue(len(nojs_page.locator("h1").inner_text().strip()) > 0)
            self.assertGreaterEqual(nojs_page.locator("details").count(), 4)
            noscript_texts = [t.strip() for t in nojs_page.locator("body noscript").all_inner_texts() if t.strip()]
            noscript_text = " ".join(noscript_texts)
            self.assertGreater(len(noscript_text), 20, "No-JS crawler must see meaningful <noscript> fallback")
        finally:
            nojs_ctx.close()


if __name__ == "__main__":
    unittest.main()
