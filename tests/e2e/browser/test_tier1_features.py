"""Tier 1 Browser & SEO E2E tests — Isolated Feature Happy Paths (F7–F15)."""

from __future__ import annotations

import json
import sys
import unittest
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright

from fixtures import (
    normal_teams_payload,
    normal_united_payload,
    united_victory_payload,
)
from server import LocalE2EServer, install_offline_routes, launch_browser


class Tier1BrowserFeaturesTest(unittest.TestCase):
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
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        return ctx, page, page_errors, console_errors, unexpected

    def test_f7_safe_rendering_and_crest_fallback(self) -> None:
        teams = normal_teams_payload(self.server.base_url)
        teams["teams"][0]["logo"] = f"{self.server.base_url}/missing-crest.png"
        self.server.set_api_response("/api/teams", teams)

        ctx, page, page_errors, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            grid_text = page.locator("#teams-grid").inner_text()
            self.assertIn("Arsenal FC", grid_text)
            self.assertIn("Premier League", grid_text)
            self.assertIn("England", grid_text)

            # Ensure no inline onerror attribute with innerHTML XSS pattern exists
            inline_onerror_count = page.evaluate(
                "() => document.querySelectorAll('#teams-grid [onerror], #streak-circles [onerror]').length"
            )
            self.assertEqual(inline_onerror_count, 0, "Crest fallback must not rely on inline onerror HTML attributes")
            self.assertEqual(page_errors, [], f"Unexpected page errors: {page_errors}")
        finally:
            ctx.close()

    def test_f8_united_status_and_closest_attempt(self) -> None:
        ctx, page, page_errors, console_errors, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.getElementById('united-streak').textContent.trim() === '2'")

            self.assertEqual(page.locator("#united-answer").inner_text().strip(), "NO")
            self.assertEqual(page.locator("#united-streak").inner_text().strip(), "2")
            self.assertEqual(page.locator("#united-form").inner_text().strip().replace("\n", ""), "WWLDW")
            self.assertTrue(page.locator("#closest-attempt").is_visible())
            self.assertEqual(page.locator("#best-streak-number").inner_text().strip(), "3")
            self.assertGreaterEqual(page.locator("#streak-circles > *").count(), 5)
            self.assertIn("2W Streak", page.locator("#united-status").inner_text())
            self.assertEqual(page_errors, [])
            self.assertEqual(console_errors, [])
        finally:
            ctx.close()

    def test_f8_victory_celebration_flow(self) -> None:
        self.server.set_api_response("/api/united", united_victory_payload(self.server.base_url))

        ctx, page, page_errors, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            overlay = page.locator("#celebration-overlay")
            overlay.wait_for(state="visible", timeout=5000)

            self.assertEqual(page.locator("#celebration-overlay").count(), 1)
            self.assertEqual(page.locator("#united-answer").inner_text().strip(), "YES")

            overlay_text = overlay.inner_text()
            self.assertIn("5", overlay_text, "Celebration overlay must reflect dynamic team count (5)")
            self.assertNotIn("61 other", overlay_text, "Celebration overlay must not hardcode 61")
            self.assertNotIn("72 other", overlay_text, "Celebration overlay must not hardcode 72")

            # Dismiss via button
            dismiss_btn = overlay.locator("button").filter(has_text="View").or_(overlay.locator("button").last).first
            dismiss_btn.click()
            page.wait_for_function("!document.getElementById('celebration-overlay')", timeout=3000)

            # Leaderboard remains intact in DOM
            self.assertTrue(page.locator("#leaderboard").is_visible())
            self.assertEqual(page.locator("#teams-grid > div").count(), 5)
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_f9_confetti_instantiation_and_cleanup(self) -> None:
        ctx, page, page_errors, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")

            result = page.evaluate(
                """async () => {
                    const canvas = document.createElement('canvas');
                    canvas.id = 'test-confetti-canvas';
                    document.body.appendChild(canvas);
                    const cannon = new window.ConfettiCannon(canvas);

                    // Verify shower() emits downward particles (vy >= 0)
                    cannon.shower(300);
                    await new Promise(r => setTimeout(r, 120));
                    const showerDownward = cannon.particles.length > 0 && cannon.particles.every(p => p.vy >= 0);

                    // Celebrate & verify running
                    cannon.celebrate();
                    const runningBeforeDestroy = cannon.isRunning && cannon.particles.length > 0;

                    // Destroy & verify cleanup
                    cannon.destroy();
                    const runningAfterDestroy = cannon.isRunning;
                    const particlesAfterDestroy = cannon.particles.length;

                    // Trigger resize after destroy (must not throw or mutate canvas)
                    let resizeCalls = 0;
                    const origResize = cannon.resize.bind(cannon);
                    cannon.resize = () => { resizeCalls++; origResize(); };
                    window.dispatchEvent(new Event('resize'));

                    await new Promise(r => setTimeout(r, 400));
                    const particlesLater = cannon.particles.length;
                    const runningLater = cannon.isRunning;
                    canvas.remove();

                    return {
                        showerDownward,
                        runningBeforeDestroy,
                        runningAfterDestroy,
                        particlesAfterDestroy,
                        resizeCalls,
                        particlesLater,
                        runningLater,
                    };
                }"""
            )

            self.assertTrue(result["showerDownward"], "ConfettiCannon.shower() particles must fall downward (vy >= 0)")
            self.assertTrue(result["runningBeforeDestroy"], "ConfettiCannon must run during celebrate()")
            self.assertFalse(result["runningAfterDestroy"], "destroy() must stop RAF loop")
            self.assertEqual(result["particlesAfterDestroy"], 0, "destroy() must clear particles")
            self.assertEqual(result["resizeCalls"], 0, "destroy() must remove window resize listener")
            self.assertEqual(result["particlesLater"], 0, "No untracked timers may spawn particles after destroy()")
            self.assertFalse(result["runningLater"], "RAF must stay stopped after destroy()")
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_f10_day_counter_and_date_formatting(self) -> None:
        ctx, page, page_errors, _, _ = self._new_page(timezone_id="Europe/London")
        try:
            page.clock.set_fixed_time("2025-03-15T12:00:00Z")
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # Oct 5, 2024 -> Mar 15, 2025 = 161 calendar days
            self.assertEqual(page.locator("#days-count").inner_text().strip(), "161")
            self.assertEqual(page.locator("#days-inline").inner_text().strip(), "161")

            # Arsenal achieved on 2025-01-15 -> Day 102, tooltip Jan 15
            arsenal_card = page.locator("#teams-grid > div", has_text="Arsenal FC").first
            self.assertIn("Day 102", arsenal_card.inner_text())
            tooltip_title = arsenal_card.locator("[title*='Jan']").first.get_attribute("title") or ""
            self.assertIn("Jan 15", tooltip_title)

            # Closest attempt date range
            dates_text = page.locator("#best-streak-dates").inner_text()
            self.assertIn("Jan 10", dates_text)
            self.assertIn("Jan 24", dates_text)

            body_text = page.locator("body").inner_text()
            self.assertNotIn("Invalid Date", body_text)
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_f11_leaderboard_search_filter_sort_tabs(self) -> None:
        ctx, page, page_errors, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # 1. Initial render
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5")

            # 2. Search "Arsenal" -> 1 card, hero #team-count stays "5", #results-summary reflects filtered count
            page.locator("#search-input").fill("Arsenal")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5", "Hero #team-count must not be overwritten by search")
            summary = page.locator("#results-summary")
            self.assertTrue(summary.is_visible(), "#results-summary must be visible")
            self.assertIn("1", summary.inner_text())

            # Clear search
            page.locator("#search-input").fill("")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # 3. Filter by PD -> Atlético de Madrid
            page.locator('.filter-btn[data-league="PD"]').click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertIn("Atlético de Madrid", page.locator("#teams-grid").inner_text())
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5")

            # Reset to All
            page.locator('.filter-btn[data-league="all"]').click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # 4. Sort dropdown reorders cards
            sort_select = page.locator("#sort-select, #leaderboard select").first
            self.assertTrue(sort_select.is_visible(), "Sort <select> control must exist in leaderboard")
            before_order = [
                page.locator("#teams-grid > div").nth(i).inner_text().splitlines()[0]
                for i in range(5)
            ]
            options = sort_select.locator("option").evaluate_all("els => els.map(e => e.value)")
            self.assertGreaterEqual(len(options), 2, "Sort dropdown should have multiple sort options")
            changed = False
            for opt in options[1:]:
                sort_select.select_option(opt)
                after_order = [
                    page.locator("#teams-grid > div").nth(i).inner_text().splitlines()[0]
                    for i in range(5)
                ]
                if after_order != before_order:
                    changed = True
                    break
            self.assertTrue(changed, "Changing sort option must visibly reorder #teams-grid cards")

            # 5. Tabs switch between Football and Other
            page.locator('.tab-btn[data-tab="other"]').click()
            self.assertTrue(page.locator("#other-tab").is_visible())
            self.assertFalse(page.locator("#football-tab").is_visible())

            page.locator('.tab-btn[data-tab="football"]').click()
            self.assertTrue(page.locator("#football-tab").is_visible())
            self.assertFalse(page.locator("#other-tab").is_visible())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_f12_accessibility_roles_and_focus(self) -> None:
        ctx, page, page_errors, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # Search input aria-label
            search_aria = page.locator("#search-input").get_attribute("aria-label") or ""
            self.assertTrue(len(search_aria.strip()) > 0, "#search-input must have a non-empty aria-label")

            # Tablist, tabs, tabpanels
            self.assertGreaterEqual(page.locator('[role="tablist"]').count(), 1)
            football_tab_btn = page.locator('.tab-btn[data-tab="football"]')
            other_tab_btn = page.locator('.tab-btn[data-tab="other"]')
            self.assertEqual(football_tab_btn.get_attribute("role"), "tab")
            self.assertEqual(other_tab_btn.get_attribute("role"), "tab")
            self.assertEqual(football_tab_btn.get_attribute("aria-selected"), "true")
            self.assertEqual(other_tab_btn.get_attribute("aria-selected"), "false")
            self.assertEqual(page.locator("#football-tab").get_attribute("role"), "tabpanel")
            self.assertEqual(page.locator("#other-tab").get_attribute("role"), "tabpanel")

            # Filter pills aria-pressed toggles on click
            pl_pill = page.locator('.filter-btn[data-league="PL"]')
            self.assertIn(pl_pill.get_attribute("aria-pressed"), ("true", "false"))
            self.assertEqual(pl_pill.get_attribute("aria-pressed"), "false")
            pl_pill.click()
            self.assertEqual(pl_pill.get_attribute("aria-pressed"), "true")

            # Celebration dialog role + Escape dismiss
            self.server.set_api_response("/api/united", united_victory_payload(self.server.base_url))
            page.reload(wait_until="networkidle")
            overlay = page.locator("#celebration-overlay")
            overlay.wait_for(state="visible", timeout=5000)
            self.assertEqual(overlay.get_attribute("role"), "dialog")
            self.assertEqual(overlay.get_attribute("aria-modal"), "true")

            page.keyboard.press("Escape")
            page.wait_for_function("!document.getElementById('celebration-overlay')", timeout=3000)
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def _http_get(self, url: str) -> tuple[int, dict[str, str], str]:
        import urllib.error
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status, dict(resp.headers.items()), resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers.items()), exc.read().decode("utf-8", errors="replace")

    def test_f13_crawl_files_and_meta_tags(self) -> None:
        # T1-SEO-01: robots.txt
        status, headers, robots = self._http_get(f"{self.server.base_url}/robots.txt")
        self.assertEqual(status, 200, f"GET /robots.txt returned {status}")
        self.assertIn("text/plain", headers.get("Content-Type", ""))
        self.assertIn("User-agent: *", robots)
        self.assertIn("Disallow: /api/", robots)
        self.assertIn("Sitemap: https://www.hasunitedwon5.com/sitemap.xml", robots)

        # T1-SEO-02: sitemap.xml
        status, _, sitemap_xml = self._http_get(f"{self.server.base_url}/sitemap.xml")
        self.assertEqual(status, 200, f"GET /sitemap.xml returned {status}")
        root = ET.fromstring(sitemap_xml)
        locs = [el.text for el in root.iter() if el.tag.endswith("loc") and el.text]
        self.assertIn("https://www.hasunitedwon5.com/", locs)

        # T1-SEO-03: favicon.svg
        status, headers, svg = self._http_get(f"{self.server.base_url}/favicon.svg")
        self.assertEqual(status, 200, f"GET /favicon.svg returned {status}")
        self.assertIn("image/svg+xml", headers.get("Content-Type", ""))
        self.assertIn("<svg", svg)

        # T1-SEO-04: site.webmanifest
        status, _, manifest_raw = self._http_get(f"{self.server.base_url}/site.webmanifest")
        self.assertEqual(status, 200, f"GET /site.webmanifest returned {status}")
        manifest = json.loads(manifest_raw)
        self.assertTrue(manifest.get("name") or manifest.get("short_name"))
        self.assertTrue(manifest.get("start_url"))
        self.assertTrue(isinstance(manifest.get("icons"), list) and len(manifest["icons"]) > 0)

        # T1-SEO-05 & T1-SEO-06: Meta tags in live DOM
        ctx, page, _, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")

            meta = page.evaluate(
                """() => ({
                    robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
                    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
                    ogLocale: document.querySelector('meta[property="og:locale"]')?.getAttribute('content') || '',
                    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
                    description: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim(),
                })"""
            )

            self.assertIn("index", meta["robots"].lower(), "Missing/invalid <meta name='robots'>")
            self.assertIn("follow", meta["robots"].lower(), "Missing/invalid <meta name='robots'>")
            self.assertTrue(len(meta["themeColor"].strip()) > 0, "Missing <meta name='theme-color'>")
            self.assertTrue(len(meta["ogLocale"].strip()) > 0, "Missing <meta property='og:locale'>")
            self.assertEqual(meta["canonical"], "https://www.hasunitedwon5.com/")
            self.assertTrue(len(meta["description"]) > 0, "Missing <meta name='description'>")
            self.assertLessEqual(
                len(meta["description"]),
                155,
                f"Meta description too long ({len(meta['description'])} > 155 chars)",
            )
        finally:
            ctx.close()

    def test_f14_f15_semantics_link_security_noscript_defer_and_preloads(self) -> None:
        ctx, page, _, _, _ = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # T1-SEO-07: Every target="_blank" link has rel containing noopener and noreferrer
            bad_links = page.evaluate(
                """() => [...document.querySelectorAll('a[target="_blank"]')]
                    .filter(a => {
                        const tokens = (a.getAttribute('rel') || '').toLowerCase().split(/\\s+/);
                        return !(tokens.includes('noopener') && tokens.includes('noreferrer'));
                    })
                    .map(a => a.outerHTML)"""
            )
            self.assertEqual(bad_links, [], f"Links missing rel='noopener noreferrer': {bad_links}")

            # T1-SEO-08: <noscript> fallback exists with meaningful text
            noscript_len = page.evaluate(
                "() => [...document.querySelectorAll('noscript')].map(n => n.textContent.trim()).join('').length"
            )
            self.assertGreater(noscript_len, 20, "Page must include a meaningful <noscript> fallback")

            # T1-SEO-09: Heading hierarchy (1 h1, no skipped heading levels)
            headings = page.evaluate(
                "() => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => Number(h.tagName.slice(1)))"
            )
            self.assertEqual(headings.count(1), 1, f"Expected exactly 1 <h1>, found {headings.count(1)}")
            for prev, curr in zip(headings, headings[1:]):
                self.assertLessEqual(
                    curr,
                    prev + 1,
                    f"Heading level skipped from h{prev} to h{curr} in {headings}",
                )

            # T1-SEO-10: <nav> has aria-label
            nav_aria = page.locator("nav").first.get_attribute("aria-label") or ""
            self.assertTrue(len(nav_aria.strip()) > 0, "<nav> must have a non-empty aria-label")

            # T1-SEO-11: confetti.js script has defer & rendered <img> elements have numeric width/height
            has_defer = page.evaluate(
                """() => {
                    const s = document.querySelector('script[src*="confetti.js"]');
                    return Boolean(s && s.hasAttribute('defer'));
                }"""
            )
            self.assertTrue(has_defer, "<script src='/confetti.js'> must have defer attribute")

            missing_dims = page.evaluate(
                """() => [...document.querySelectorAll('img')]
                    .filter(img => !img.getAttribute('width') || !img.getAttribute('height'))
                    .map(img => img.outerHTML)"""
            )
            self.assertEqual(missing_dims, [], f"Rendered <img> missing width/height attributes: {missing_dims}")

            # T1-SEO-12: Single Inter font preload link
            inter_preloads = page.evaluate(
                """() => [...document.querySelectorAll('link[rel="preload"][as="font"]')]
                    .map(l => l.getAttribute('href') || '')
                    .filter(href => href.toLowerCase().includes('inter'))"""
            )
            self.assertEqual(len(inter_preloads), 1, f"Expected exactly 1 Inter preload, found {inter_preloads}")
        finally:
            ctx.close()


if __name__ == "__main__":
    unittest.main()
