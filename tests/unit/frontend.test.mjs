import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const CONFETTI_JS_PATH = path.join(ROOT, 'public/confetti.js');

const indexHtmlSource = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const confettiJsSource = fs.readFileSync(CONFETTI_JS_PATH, 'utf8');

function extractInlineScript(html) {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match && match[1].trim().length > 0, 'Expected bare inline <script> block in index.html');
    return match[1];
}

// Lightweight DOM + timer harness to execute the real index.html script in VM
class FakeClassList {
    constructor(el) {
        this._el = el;
        this._set = new Set();
    }
    _syncFromClassName(str) {
        this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _syncToClassName() {
        this._el._className = [...this._set].join(' ');
    }
    add(...tokens) {
        tokens.forEach(t => { if (t) this._set.add(t); });
        this._syncToClassName();
    }
    remove(...tokens) {
        tokens.forEach(t => this._set.delete(t));
        this._syncToClassName();
    }
    contains(token) {
        return this._set.has(token);
    }
    toggle(token, force) {
        if (force === undefined) {
            if (this._set.has(token)) {
                this._set.delete(token);
                this._syncToClassName();
                return false;
            }
            this._set.add(token);
            this._syncToClassName();
            return true;
        }
        if (force) this._set.add(token);
        else this._set.delete(token);
        this._syncToClassName();
        return Boolean(force);
    }
}

class FakeElement {
    constructor(tagName, id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this._className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.attributes = new Map();
        this.style = {};
        this.value = '';
        this.textContent = '';
        this._innerHTML = '';
        this.children = [];
        this.parentElement = null;
        this.listeners = new Map();
        this.isConnected = true;
        this.focused = false;
        this.innerHtmlWrites = 0;
    }

    get className() {
        return this._className;
    }
    set className(val) {
        this._className = String(val || '');
        this.classList._syncFromClassName(this._className);
    }

    get innerHTML() {
        return this._innerHTML;
    }
    set innerHTML(val) {
        this.innerHtmlWrites += 1;
        this._innerHTML = String(val ?? '');
        this.children = [];
        // Parse minimal id="..." elements from innerHTML so getElementById finds dynamically rendered buttons/stats
        const tagRegex = /<(button|div|span|a|img)\b([^>]*)>/gi;
        let m;
        while ((m = tagRegex.exec(this._innerHTML)) !== null) {
            const tag = m[1];
            const attrs = m[2];
            const idMatch = attrs.match(/\bid="([^"]+)"/);
            if (idMatch) {
                const child = new FakeElement(tag, idMatch[1]);
                child.parentElement = this;
                this.children.push(child);
            }
        }
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
        if (name === 'class') this.className = String(value);
    }
    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    removeAttribute(name) {
        this.attributes.delete(name);
    }
    hasAttribute(name) {
        return this.attributes.has(name);
    }

    appendChild(child) {
        child.parentElement = this;
        child.isConnected = true;
        this.children.push(child);
        return child;
    }

    remove() {
        this.isConnected = false;
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(c => c !== this);
            this.parentElement = null;
        }
    }

    replaceWith(newNode) {
        if (!this.parentElement) return;
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) {
            newNode.parentElement = this.parentElement;
            this.parentElement.children[idx] = newNode;
        }
        this.parentElement = null;
    }

    focus() {
        this.focused = true;
    }

    addEventListener(type, fn, capture = false) {
        const key = `${type}:${Boolean(capture)}`;
        if (!this.listeners.has(key)) this.listeners.set(key, []);
        this.listeners.get(key).push(fn);
    }

    removeEventListener(type, fn, capture = false) {
        const key = `${type}:${Boolean(capture)}`;
        if (!this.listeners.has(key)) return;
        this.listeners.set(key, this.listeners.get(key).filter(f => f !== fn));
    }

    dispatchEvent(event, capture = false) {
        const key = `${event.type}:${Boolean(capture)}`;
        const handlers = this.listeners.get(key) || [];
        for (const fn of [...handlers]) {
            fn(event);
        }
    }

    click() {
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {} });
    }
}

function createFrontendHarness(options = {}) {
    const hostname = options.hostname ?? 'www.hasunitedwon5.com';
    const search = options.search ?? '';
    const fetchImpl = options.fetch ?? (async (url) => ({
        ok: true,
        status: 200,
        async json() {
            if (url.includes('/teams')) {
                return { success: true, teams: [], leaguesScanned: 0, recentScans: [] };
            }
            if (url.includes('/united')) {
                return { hasWon5: false, currentStreak: 0, bestStreak: 0, form: '', lastUpdated: new Date().toISOString() };
            }
            return { success: true };
        }
    }));

    const elementsById = new Map();
    const makeEl = (tag, id, className = '') => {
        const el = new FakeElement(tag, id);
        if (className) el.className = className;
        if (id) elementsById.set(id, el);
        return el;
    };

    const body = makeEl('body', '');
    makeEl('input', 'search-input');
    const clearBtn = makeEl('button', 'clear-search-btn', 'hidden');
    const sortSel = makeEl('select', 'sort-select');
    sortSel.value = 'earliest';
    const filterContainer = makeEl('div', 'filter-container');
    makeEl('div', 'results-summary');
    const teamCount = makeEl('span', 'team-count');
    teamCount.textContent = '--';
    makeEl('div', 'days-count');
    const leaguesCount = makeEl('div', 'leagues-count');
    leaguesCount.textContent = '--';
    makeEl('div', 'leagues-status');
    makeEl('span', 'days-inline');
    makeEl('div', 'teams-grid');
    makeEl('div', 'empty-state', 'hidden');
    makeEl('div', 'loading-state');
    const unitedAnswer = makeEl('div', 'united-answer', 'text-united-red glow-red');
    unitedAnswer.textContent = 'NO';
    makeEl('div', 'united-form');
    makeEl('div', 'united-streak');
    makeEl('div', 'united-status');
    makeEl('div', 'closest-attempt', 'hidden');
    makeEl('span', 'best-streak-number');
    makeEl('div', 'best-streak-dates');
    makeEl('div', 'streak-circles');

    const footballTab = makeEl('div', 'football-tab', 'tab-content');
    const otherTab = makeEl('div', 'other-tab', 'tab-content hidden');
    const tabFootballBtn = makeEl('button', 'tab-football', 'tab-btn tab-active');
    tabFootballBtn.dataset.tab = 'football';
    tabFootballBtn.setAttribute('aria-selected', 'true');
    const tabOtherBtn = makeEl('button', 'tab-other', 'tab-btn text-gray-400');
    tabOtherBtn.dataset.tab = 'other';
    tabOtherBtn.setAttribute('aria-selected', 'false');

    const docListeners = new Map();

    function findByIdInTree(node, id) {
        if (node.id === id) return node;
        for (const child of node.children) {
            const found = findByIdInTree(child, id);
            if (found) return found;
        }
        return null;
    }

    function collectAllNodes(root, out = []) {
        out.push(root);
        for (const child of root.children) {
            collectAllNodes(child, out);
        }
        return out;
    }

    const documentMock = {
        body,
        activeElement: elementsById.get('search-input'),
        createElement(tag) {
            return new FakeElement(tag);
        },
        getElementById(id) {
            if (elementsById.has(id)) return elementsById.get(id);
            const inBody = findByIdInTree(body, id);
            if (inBody) return inBody;
            for (const el of elementsById.values()) {
                const found = findByIdInTree(el, id);
                if (found) return found;
            }
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.tab-btn') return [tabFootballBtn, tabOtherBtn];
            if (selector === '.tab-content') return [footballTab, otherTab];
            if (selector === '.filter-btn') {
                return filterContainer.children.filter(c => c.classList.contains('filter-btn'));
            }
            if (selector === '.screen-flash') {
                return collectAllNodes(body).filter(n => n.classList.contains('screen-flash'));
            }
            return [];
        },
        addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            if (!docListeners.has(type)) return;
            docListeners.set(type, docListeners.get(type).filter(f => f !== fn));
        },
        dispatchEvent(event) {
            const handlers = docListeners.get(event.type) || [];
            for (const fn of [...handlers]) fn(event);
        },
        getListenerCount(type) {
            return (docListeners.get(type) || []).length;
        }
    };

    // Controllable fake timers
    let nowMs = options.nowMs ?? Date.now();
    let nextTimerId = 1;
    const timeouts = new Map();
    const intervals = new Map();

    const setTimeoutMock = (fn, delay = 0) => {
        const id = nextTimerId++;
        timeouts.set(id, { fn, runAt: nowMs + Math.max(0, Number(delay) || 0) });
        return id;
    };
    const clearTimeoutMock = (id) => { timeouts.delete(id); };
    const setIntervalMock = (fn, delay = 0) => {
        const id = nextTimerId++;
        const interval = Math.max(1, Number(delay) || 1);
        intervals.set(id, { fn, interval, runAt: nowMs + interval });
        return id;
    };
    const clearIntervalMock = (id) => { intervals.delete(id); };

    function advanceTimers(ms) {
        const target = nowMs + ms;
        while (true) {
            let earliest = null;
            for (const [id, t] of timeouts.entries()) {
                if (t.runAt <= target && (!earliest || t.runAt < earliest.runAt)) {
                    earliest = { type: 'timeout', id, ...t };
                }
            }
            for (const [id, iv] of intervals.entries()) {
                if (iv.runAt <= target && (!earliest || iv.runAt < earliest.runAt)) {
                    earliest = { type: 'interval', id, ...iv };
                }
            }
            if (!earliest) break;
            nowMs = earliest.runAt;
            if (earliest.type === 'timeout') {
                timeouts.delete(earliest.id);
                earliest.fn();
            } else {
                earliest.runAt += earliest.interval;
                intervals.set(earliest.id, { fn: earliest.fn, interval: earliest.interval, runAt: earliest.runAt });
                earliest.fn();
            }
        }
        nowMs = target;
    }

    // Mock localStorage
    const storageMap = new Map(Object.entries(options.localStorage || {}));
    const localStorageMock = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => { storageMap.set(k, String(v)); },
        removeItem: (k) => { storageMap.delete(k); },
        clear: () => { storageMap.clear(); }
    };

    // Spy ConfettiCannon
    const confettiInstances = [];
    class SpyConfettiCannon {
        constructor(canvas) {
            this.canvas = canvas;
            this.celebrateCalls = 0;
            this.showerCalls = 0;
            this.destroyCalls = 0;
            confettiInstances.push(this);
        }
        celebrate() { this.celebrateCalls += 1; }
        shower() { this.showerCalls += 1; }
        destroy() { this.destroyCalls += 1; }
    }

    const fetchCalls = [];
    const trackedFetch = async (url, init) => {
        fetchCalls.push(url);
        return fetchImpl(url, init);
    };

    const windowMock = {
        location: { hostname, search },
        ConfettiCannon: SpyConfettiCannon
    };

    const context = {
        window: windowMock,
        document: documentMock,
        localStorage: localStorageMock,
        navigator: { clipboard: { writeText: async () => {} } },
        fetch: trackedFetch,
        URL,
        URLSearchParams,
        Intl,
        Date,
        Math,
        Set,
        Map,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Promise,
        Error,
        encodeURIComponent,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
        setInterval: setIntervalMock,
        clearInterval: clearIntervalMock,
        ConfettiCannon: SpyConfettiCannon
    };
    context.globalThis = context;

    const inlineScript = extractInlineScript(indexHtmlSource);
    const epilogue = `
;globalThis.__test = {
    escapeHtml, safeUrl, getUkCalendarDateUtc, calculateDays, updateDays,
    timeAgo, renderForm, renderTeamCard, renderClosestAttempt, renderUnitedData,
    getUnitedStatusHTML, normalizeSearchText, sortTeams, resetSearchAndFilters,
    filterTeams, setupFilters, updateFilterVisuals,
    loadTeams, loadUnitedStatus, triggerCelebration, dismissCelebration,
    getAllTeams: () => allTeams,
    setAllTeams: (v) => { allTeams = v; },
    getActiveFilters: () => activeFilters,
    getCelebrationTriggered: () => celebrationTriggered
};`;

    vm.runInNewContext(inlineScript + epilogue, context, { filename: 'index.html' });

    return {
        api: context.__test,
        document: documentMock,
        elementsById,
        localStorage: localStorageMock,
        storageMap,
        confettiInstances,
        fetchCalls,
        advanceTimers,
        clearBtn,
        sortSel,
        tabFootballBtn,
        tabOtherBtn,
        footballTab,
        otherTab
    };
}

// ============================================================================
// 1. Security & XSS (F7)
// ============================================================================
describe('F7: Frontend XSS Protection & URL Validation', () => {
    it('escapeHtml escapes all 5 HTML metacharacters and handles null/undefined/numbers', () => {
        const { api } = createFrontendHarness();
        assert.equal(
            api.escapeHtml('<img src="x" onerror=\'alert(1)\'> & test'),
            '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; test'
        );
        assert.equal(api.escapeHtml(null), '');
        assert.equal(api.escapeHtml(undefined), '');
        assert.equal(api.escapeHtml(42), '42');
    });

    it('safeUrl allows https, http, and single-slash relative paths; rejects dangerous schemes', () => {
        const { api } = createFrontendHarness();
        assert.equal(api.safeUrl('https://crests.football-data.org/66.png'), 'https://crests.football-data.org/66.png');
        assert.equal(api.safeUrl('http://example.com/logo.png'), 'http://example.com/logo.png');
        assert.equal(api.safeUrl('/united-crest.png'), '/united-crest.png');

        assert.equal(api.safeUrl('javascript:alert(1)'), '');
        assert.equal(api.safeUrl('  JAVASCRIPT:alert(1)  '), '');
        assert.equal(api.safeUrl('data:text/html,<script>alert(1)</script>'), '');
        assert.equal(api.safeUrl('vbscript:msgbox(1)'), '');
        assert.equal(api.safeUrl('//evil.com/x.png'), '');
        assert.equal(api.safeUrl('/\\evil.com/x.png'), '');
        assert.equal(api.safeUrl('https://example.com/\u0000bad'), '');
        assert.equal(api.safeUrl(''), '');
        assert.equal(api.safeUrl(null), '');
    });

    it('renderTeamCard escapes malicious fields and neutralizes javascript: URLs without inline onerror', () => {
        const { api } = createFrontendHarness();
        const html = api.renderTeamCard({
            name: '"><img src=x onerror=alert(1)>',
            logo: 'javascript:alert(1)',
            country_flag: 'data:text/html,<svg onload=alert(1)>',
            country_name: '<script>evil()</script>',
            league_id: 'PL',
            league_name: '<b>Premier</b>',
            max_streak: 6,
            streak_achieved_date: '2025-01-15'
        });
        assert.ok(!html.includes('<script>evil()'));
        assert.ok(!html.includes('<img src=x'));
        assert.ok(!html.includes('javascript:'));
        assert.ok(!html.includes('data:text/html'));
        assert.ok(html.includes('title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'));
        assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
        assert.ok(html.includes('&lt;b&gt;Premier&lt;/b&gt;'));

        // Valid logo renders <img> with data-fallback-icon instead of inline onerror=
        const validLogoHtml = api.renderTeamCard({
            name: 'Arsenal',
            logo: 'https://crests.football-data.org/57.png',
            league_id: 'PL',
            league_name: 'Premier League'
        });
        assert.ok(validLogoHtml.includes('data-fallback-icon="⚽"'));
        assert.ok(!/\sonerror=/i.test(validLogoHtml), 'Valid logo <img> must not use inline onerror=');
    });

    it('renderClosestAttempt escapes opponent/tla/score and uses capturing error listener instead of inline onerror', () => {
        const { api, elementsById } = createFrontendHarness();
        api.renderClosestAttempt({
            bestStreak: 2,
            bestStreakDetails: {
                startDate: '2025-01-10',
                endDate: '2025-01-15',
                matches: [
                    {
                        opponent: 'Evil <script>x</script>',
                        opponentTla: "A'\"<",
                        opponentCrest: 'https://crests.football-data.org/1.png',
                        score: '2-0 <img src=x>',
                        home: true
                    }
                ]
            }
        });
        const circlesEl = elementsById.get('streak-circles');
        assert.ok(!circlesEl.innerHTML.includes('onerror='));
        assert.ok(!circlesEl.innerHTML.includes('<script>x</script>'));
        assert.ok(circlesEl.innerHTML.includes('data-fallback-tla='));

        // Verify capturing error listener swaps broken <img> with safe textContent <span>
        const brokenImg = new FakeElement('img');
        brokenImg.dataset.fallbackTla = '<XSS>';
        circlesEl.appendChild(brokenImg);
        circlesEl.dispatchEvent({ type: 'error', target: brokenImg }, true);
        const replaced = circlesEl.children.find(c => c.tagName === 'SPAN');
        assert.ok(replaced, 'Broken crest image should be replaced with fallback span');
        assert.equal(replaced.textContent, '<XSS>');
    });

    it('renderForm escapes unexpected characters and index.html has zero inline onerror/onclick handlers', () => {
        const { api } = createFrontendHarness();
        assert.equal(api.renderForm('W<'), '<span class="text-neon-green">W</span>&lt;');
        assert.equal(api.renderForm(null), '');
        assert.ok(!/\sonerror=/i.test(indexHtmlSource), 'index.html must not contain inline onerror=');
        assert.ok(!/\sonclick=/i.test(indexHtmlSource), 'index.html must not contain inline onclick=');
    });

    it('guards LEAGUE_FLAGS and SHORT_LEAGUE_NAMES against Object.prototype key lookups', async () => {
        const harness = createFrontendHarness({
            fetch: async (url) => {
                if (url.includes('/teams')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return {
                                success: true,
                                teams: [
                                    {
                                        team_id: 100,
                                        name: 'Proto FC',
                                        league_id: 'toString',
                                        league_name: 'constructor',
                                        country_name: 'Nowhere',
                                        max_streak: 5
                                    }
                                ],
                                leaguesScanned: 1,
                                recentScans: [
                                    {
                                        league_id: '__proto__',
                                        league_name: 'constructor',
                                        teams_scanned: 10,
                                        teams_qualified: 1,
                                        scanned_at: new Date().toISOString()
                                    }
                                ]
                            };
                        }
                    };
                }
                return { ok: true, status: 200, async json() { return { hasWon5: false }; } };
            }
        });

        for (const protoKey of ['toString', 'constructor', '__proto__']) {
            const cardHtml = harness.api.renderTeamCard({
                team_id: 101,
                name: 'Proto FC',
                league_id: protoKey,
                league_name: 'constructor',
                country_name: 'Nowhere',
                max_streak: 5
            });
            assert.ok(cardHtml.includes('⚽'), `Expected fallback ⚽ for league_id="${protoKey}"`);
            assert.ok(!cardHtml.includes('[native code]'), `Must not leak native prototype function for league_id="${protoKey}"`);
            assert.ok(cardHtml.includes('constructor'), 'SHORT_LEAGUE_NAMES must preserve literal league_name "constructor"');
        }

        await harness.api.loadTeams(false);
        const filterHtml = harness.elementsById.get('filter-container').children.map(c => c.innerHTML).join('');
        const scansHtml = harness.elementsById.get('leagues-status').innerHTML;
        assert.ok(!filterHtml.includes('[native code]'), 'Filter pills must not leak Object.prototype properties');
        assert.ok(scansHtml.includes('⚽'), 'Recent scans must fall back to ⚽ for prototype league_id keys');
        assert.ok(!scansHtml.includes('[native code]'), 'Recent scans must not leak Object.prototype properties');
    });
});

// ============================================================================
// 2. Timezone & Date Accuracy (F10)
// ============================================================================
describe('F10: Timezone & Date Accuracy', () => {
    it('calculateDays computes DST-safe Europe/London calendar days', () => {
        const { api } = createFrontendHarness();
        // Vow day Oct 5, 2024 (BST)
        assert.equal(api.calculateDays(new Date('2024-10-05T00:30:00Z')), 0);
        // Next UK day Oct 6, 2024 00:00 BST
        assert.equal(api.calculateDays(new Date('2024-10-06T00:00:00+01:00')), 1);
        // Across BST -> GMT fall-back (Oct 27 -> Oct 28, 2024)
        assert.equal(api.calculateDays(new Date('2024-10-27T12:00:00Z')), 22);
        assert.equal(api.calculateDays(new Date('2024-10-28T00:30:00Z')), 23);
        // Winter GMT midnight check (2025-01-01T23:30:00Z is still Jan 1 in GMT)
        assert.equal(api.calculateDays(new Date('2025-01-01T23:30:00Z')), 88);
        // Across GMT -> BST spring-forward (Mar 30 -> Mar 31, 2025)
        assert.equal(api.calculateDays(new Date('2025-03-30T12:00:00Z')), 176);
        assert.equal(api.calculateDays(new Date('2025-03-31T00:30:00Z')), 177);
        // Summer BST midnight check (2025-07-01T23:30:00Z is July 2 in BST = 00:30 BST)
        assert.equal(api.calculateDays(new Date('2025-07-01T23:30:00Z')), 270);
        // Pre-vow date clamps to 0 (no Math.abs bug)
        assert.equal(api.calculateDays(new Date('2024-10-01T12:00:00Z')), 0);
    });

    it('timeAgo handles valid, missing, and invalid dates without NaNd ago', () => {
        const { api } = createFrontendHarness();
        assert.equal(api.timeAgo(null), 'Unknown');
        assert.equal(api.timeAgo(''), 'Unknown');
        assert.equal(api.timeAgo('not-a-date'), 'Unknown');
        assert.equal(api.timeAgo(new Date(Date.now() - 10_000).toISOString()), 'Just now');
        assert.equal(api.timeAgo(new Date(Date.now() - 5 * 60_000).toISOString()), '5m ago');
        assert.equal(api.timeAgo(new Date(Date.now() - 3 * 3600_000).toISOString()), '3h ago');
        assert.equal(api.timeAgo(new Date(Date.now() - 2 * 86400_000).toISOString()), '2d ago');
    });

    it('renderTeamCard and renderClosestAttempt format YYYY-MM-DD in UTC and guard invalid dates', () => {
        const { api, elementsById } = createFrontendHarness();
        const cardHtml = api.renderTeamCard({
            name: 'Arsenal',
            league_id: 'PL',
            league_name: 'Premier League',
            streak_achieved_date: '2025-01-15'
        });
        assert.ok(cardHtml.includes('Achieved on Jan 15'));
        assert.ok(cardHtml.includes('Day 102'));

        const invalidCardHtml = api.renderTeamCard({
            name: 'InvalidDateFC',
            league_id: 'PL',
            streak_achieved_date: 'not-a-date'
        });
        assert.ok(!invalidCardHtml.includes('Invalid Date'));
        assert.ok(!invalidCardHtml.includes('NaN'));

        api.renderClosestAttempt({
            bestStreak: 2,
            bestStreakDetails: { startDate: '2025-01-15', endDate: '2025-01-20', matches: [] }
        });
        assert.equal(elementsById.get('best-streak-dates').textContent, 'Jan 15 → Jan 20');
    });

    it('getUnitedStatusHTML handles missing/invalid lastUpdated without Invalid Date or NaNd ago', () => {
        const { api } = createFrontendHarness();
        const html = api.getUnitedStatusHTML({ currentStreak: 2, lastUpdated: 'invalid' });
        assert.ok(!html.includes('Invalid Date'));
        assert.ok(!html.includes('NaN'));
        assert.ok(html.includes('Unknown'));
    });

    it('triggerCelebration freezes day count at achievementDate and formats in Europe/London', () => {
        const { api, document, advanceTimers } = createFrontendHarness();
        api.triggerCelebration({
            isDemo: true,
            achievementDate: '2025-02-10T22:30:00Z',
            teamsFirst: 50
        });
        advanceTimers(1700);
        const overlay = document.getElementById('celebration-overlay');
        assert.ok(overlay, 'Celebration overlay should mount');
        // 2025-02-10 is 128 days after 2024-10-05
        assert.ok(overlay.innerHTML.includes('>128<'), 'Day count must be frozen at achievementDate (128)');
        assert.ok(overlay.innerHTML.includes('22:30:00 UK'));
    });
});

// ============================================================================
// 3. Search, Filter, Sort & Dashboard UX (F11)
// ============================================================================
describe('F11: Search Results, Sorting, Filtering & Dashboard UX', () => {
    const sampleTeams = [
        { team_id: 1, name: 'Atlético Madrid', league_id: 'PD', league_name: 'La Liga', country_name: 'Spain', max_streak: 6, streak_achieved_date: '2024-11-10' },
        { team_id: 2, name: 'FC Bayern München', league_id: 'BL1', league_name: 'Bundesliga', country_name: 'Germany', max_streak: 8, streak_achieved_date: '2024-10-20' },
        { team_id: 3, name: 'Arsenal', league_id: 'PL', league_name: 'Premier League', country_name: 'England', max_streak: 5, streak_achieved_date: '2024-12-01' },
        { team_id: 4, name: null, league_id: null, league_name: null, country_name: null, max_streak: 5, streak_achieved_date: null }
    ];

    it('supports trimmed, diacritic-normalized multi-field search and preserves hero #team-count', () => {
        const { api, elementsById, clearBtn } = createFrontendHarness();
        api.setAllTeams(sampleTeams);
        api.setupFilters(sampleTeams);

        const searchInput = elementsById.get('search-input');
        const teamCount = elementsById.get('team-count');
        const summary = elementsById.get('results-summary');
        const grid = elementsById.get('teams-grid');

        // Diacritic + whitespace search
        searchInput.value = '  atletico  ';
        api.filterTeams();
        assert.equal(teamCount.textContent, 4, 'Hero #team-count must stay equal to allTeams.length');
        assert.equal(summary.textContent, 'Showing 1 of 4 teams');
        assert.ok(grid.innerHTML.includes('Atlético Madrid'));
        assert.equal(clearBtn.classList.contains('hidden'), false);

        // Search by country_name
        searchInput.value = 'germany';
        api.filterTeams();
        assert.equal(summary.textContent, 'Showing 1 of 4 teams');
        assert.ok(grid.innerHTML.includes('FC Bayern München'));

        // Search by league_id
        searchInput.value = 'PL';
        api.filterTeams();
        assert.equal(summary.textContent, 'Showing 1 of 4 teams');
        assert.ok(grid.innerHTML.includes('Arsenal'));

        // Zero results shows reset button
        searchInput.value = 'nonexistent-xyz';
        api.filterTeams();
        assert.equal(summary.textContent, 'Showing 0 of 4 teams');
        assert.ok(grid.innerHTML.includes('reset-filters-btn'));

        // Reset restores all teams
        api.resetSearchAndFilters();
        assert.equal(searchInput.value, '');
        assert.equal(summary.textContent, 'Showing 4 of 4 teams');
        assert.equal(clearBtn.classList.contains('hidden'), true);
    });

    it('sorts teams accurately across earliest, recent, streak, and name modes', () => {
        const { api } = createFrontendHarness();
        const clean = sampleTeams.slice(0, 3);
        assert.deepEqual(Array.from(api.sortTeams(clean, 'earliest'), t => t.name), ['FC Bayern München', 'Atlético Madrid', 'Arsenal']);
        assert.deepEqual(Array.from(api.sortTeams(clean, 'recent'), t => t.name), ['Arsenal', 'Atlético Madrid', 'FC Bayern München']);
        assert.deepEqual(Array.from(api.sortTeams(clean, 'streak'), t => t.name), ['FC Bayern München', 'Atlético Madrid', 'Arsenal']);
        assert.deepEqual(Array.from(api.sortTeams(clean, 'name'), t => t.name), ['Arsenal', 'Atlético Madrid', 'FC Bayern München']);
    });

    it('setupFilters ignores null league_id and prunes stale activeFilters back to all', () => {
        const { api } = createFrontendHarness();
        api.setupFilters(sampleTeams);
        const filters = api.getActiveFilters();
        filters.clear();
        filters.add('BL1');

        // Re-run setupFilters without BL1
        api.setupFilters([sampleTeams[0], sampleTeams[2]]);
        assert.equal(filters.has('BL1'), false, 'Stale league filter should be pruned');
        assert.equal(filters.has('all'), true, 'Should fall back to all when all active filters are pruned');
    });

    it('displays leaguesScanned === 0 as "0" and supports silent refresh without wiping grid', async () => {
        const harness = createFrontendHarness({
            fetch: async (url) => {
                if (url.includes('/teams')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return {
                                success: true,
                                teams: [sampleTeams[0]],
                                leaguesScanned: 0,
                                recentScans: []
                            };
                        }
                    };
                }
                return { ok: true, status: 200, async json() { return { hasWon5: false }; } };
            }
        });
        await harness.api.loadTeams(false);
        assert.equal(harness.elementsById.get('leagues-count').textContent, 0);

        const grid = harness.elementsById.get('teams-grid');
        const writesBeforeSilent = grid.innerHtmlWrites;
        await harness.api.loadTeams(true);
        // Silent refresh should not perform an extra clearing write before rendering
        assert.equal(grid.innerHtmlWrites, writesBeforeSilent + 1);
    });

    it('renders distinct error states with Retry buttons on HTTP 500 for /api/teams and /api/united', async () => {
        const harness = createFrontendHarness({
            fetch: async () => ({ ok: false, status: 500, async json() { return { error: 'boom' }; } })
        });
        await harness.api.loadTeams(false);
        const emptyState = harness.elementsById.get('empty-state');
        const leaguesStatus = harness.elementsById.get('leagues-status');
        assert.equal(emptyState.classList.contains('hidden'), false);
        assert.ok(emptyState.innerHTML.includes('Unable to load teams'));
        assert.ok(!emptyState.innerHTML.includes('Loading teams...'));
        assert.ok(emptyState.innerHTML.includes('retry-teams-btn'));
        assert.ok(leaguesStatus.innerHTML.includes('Unable to load coverage data'));

        await harness.api.loadUnitedStatus();
        const unitedStatus = harness.elementsById.get('united-status');
        assert.ok(unitedStatus.innerHTML.includes('Unable to load live status'));
        assert.ok(unitedStatus.innerHTML.includes('retry-united-status-btn'));
    });
});

// ============================================================================
// 4. Victory Flow & Celebration Overlay (F8 + F12)
// ============================================================================
describe('F8 & F12: Victory Flow, Single-Trigger Guard, Localhost Gate & Modal Cleanup', () => {
    it('prevents duplicate overlays/confetti when triggered twice and swaps YES at 400ms flip midpoint', () => {
        const harness = createFrontendHarness();
        const { api, document, elementsById, confettiInstances, advanceTimers } = harness;

        api.triggerCelebration({ achievementDate: '2025-02-10T22:30:00Z', teamsFirst: 40 });
        api.triggerCelebration({ achievementDate: '2025-02-10T22:30:00Z', teamsFirst: 40 });

        assert.equal(confettiInstances.length, 1, 'Should instantiate only 1 ConfettiCannon');
        const answerEl = elementsById.get('united-answer');
        assert.equal(answerEl.textContent, 'NO', 'Should still be NO before flip starts');

        // At 400ms, flip-reveal starts, text still NO
        advanceTimers(400);
        assert.ok(answerEl.classList.contains('flip-reveal'));
        assert.equal(answerEl.textContent, 'NO', 'Should still be NO at start of flip-reveal');

        // At 800ms (400ms midpoint of 0.8s flip), text swaps to YES
        advanceTimers(400);
        assert.equal(answerEl.textContent, 'YES');

        // At 1600ms total, overlay mounts with dialog ARIA attributes
        advanceTimers(900);
        const overlay = document.getElementById('celebration-overlay');
        assert.ok(overlay, 'Overlay should exist after 1600ms');
        assert.equal(overlay.getAttribute('role'), 'dialog');
        assert.equal(overlay.getAttribute('aria-modal'), 'true');
        assert.equal(overlay.getAttribute('aria-labelledby'), 'celebration-title');
        assert.equal(document.getListenerCount('keydown'), 1);

        // Escape dismisses overlay, destroys confetti, removes canvas & keydown listener
        document.dispatchEvent({ type: 'keydown', key: 'Escape' });
        assert.equal(document.getElementById('celebration-overlay'), null);
        assert.equal(document.getElementById('confetti-canvas'), null);
        assert.equal(confettiInstances[0].destroyCalls, 1);
        assert.equal(document.getListenerCount('keydown'), 0);
    });

    it('preserves NO until the 800ms flip midpoint when SWR calls renderUnitedData twice (t=0 and t=100ms)', () => {
        const harness = createFrontendHarness();
        const { api, document, elementsById, confettiInstances, advanceTimers } = harness;
        const answerEl = elementsById.get('united-answer');
        const payload = {
            hasWon5: true,
            achievementDate: '2026-05-01T15:00:00Z',
            form: 'WWWWW',
            currentStreak: 5
        };

        // t=0: cached SWR response triggers celebration
        api.renderUnitedData(payload);
        assert.equal(answerEl.textContent, 'NO', 'At t=0, #united-answer must remain NO');

        // t=100ms: live SWR response arrives while flip-reveal is still pending
        advanceTimers(100);
        api.renderUnitedData(payload);
        assert.equal(answerEl.textContent, 'NO', 'At t=100ms after 2nd SWR renderUnitedData, #united-answer must still be NO');

        // t=799ms: 1ms before the 400ms midpoint of the flip starting at t=400ms
        advanceTimers(699);
        assert.ok(answerEl.classList.contains('flip-reveal'), 'flip-reveal class should be active by t=799ms');
        assert.equal(answerEl.textContent, 'NO', 'At t=799ms, #united-answer must still be NO');

        // t=800ms: exact flip midpoint swaps to YES
        advanceTimers(1);
        assert.equal(answerEl.textContent, 'YES', 'At t=800ms, #united-answer must flip to YES');

        // Advance past overlay mount and verify singleton confetti/overlay
        advanceTimers(1000);
        assert.equal(confettiInstances.length, 1, 'SWR double-call must create only 1 ConfettiCannon');
        assert.ok(document.getElementById('celebration-overlay'), 'Celebration overlay should mount once');
    });

    it('never wipes document.body.innerHTML when Manchester United appears in /api/teams', async () => {
        const harness = createFrontendHarness({
            fetch: async (url) => {
                if (url.includes('/teams')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return {
                                success: true,
                                teams: [{ team_id: 66, name: 'Manchester United FC', league_id: 'PL', league_name: 'Premier League', max_streak: 5 }],
                                leaguesScanned: 1,
                                recentScans: []
                            };
                        }
                    };
                }
                return { ok: true, status: 200, async json() { return { hasWon5: false }; } };
            }
        });
        await harness.api.loadTeams(false);
        assert.equal(harness.document.body.innerHtmlWrites, 0, 'document.body.innerHTML must never be overwritten');
    });

    it('gates ?celebrate=true to localhost only and never writes united_achievement_time in demo mode', () => {
        // Production hostname ignores ?celebrate=true
        const prod = createFrontendHarness({ hostname: 'www.hasunitedwon5.com', search: '?celebrate=true' });
        prod.advanceTimers(2500);
        assert.equal(prod.api.getCelebrationTriggered(), false);
        assert.equal(prod.document.getElementById('celebration-overlay'), null);

        // Localhost allows ?celebrate=true without persisting to localStorage
        const local = createFrontendHarness({ hostname: 'localhost', search: '?celebrate=true' });
        local.advanceTimers(2500);
        assert.equal(local.api.getCelebrationTriggered(), true);
        assert.ok(local.document.getElementById('celebration-overlay'));
        assert.equal(local.localStorage.getItem('united_achievement_time'), null, 'Demo mode must not persist united_achievement_time');
    });
});

// ============================================================================
// 5. Accessibility Controls (F12)
// ============================================================================
describe('F12: Accessibility Markup & Dynamic ARIA State', () => {
    it('index.html has required ARIA roles, labels, focus rings, and zero text-gray-600/700', () => {
        assert.ok(indexHtmlSource.includes('id="search-input" aria-label="Search teams or leagues"'));
        assert.ok(indexHtmlSource.includes('role="tablist"'));
        assert.ok(indexHtmlSource.includes('role="tab"'));
        assert.ok(indexHtmlSource.includes('role="tabpanel"'));
        assert.ok(indexHtmlSource.includes('aria-controls="football-tab"'));
        assert.ok(indexHtmlSource.includes('aria-controls="other-tab"'));
        assert.ok(indexHtmlSource.includes('id="results-summary" aria-live="polite"'));
        assert.ok(indexHtmlSource.includes('focus-visible:ring-2'));
        assert.ok(!/text-gray-(600|700)\b/.test(indexHtmlSource), 'All text-gray-600 and text-gray-700 classes should be upgraded to text-gray-400');

        // Controls must be inside #football-tab so they hide on Other tab
        const footballTabIdx = indexHtmlSource.indexOf('id="football-tab"');
        const controlsIdx = indexHtmlSource.indexOf('id="leaderboard-controls"');
        const otherTabIdx = indexHtmlSource.indexOf('id="other-tab"');
        assert.ok(footballTabIdx < controlsIdx && controlsIdx < otherTabIdx, '#leaderboard-controls must be inside #football-tab');
    });

    it('syncs aria-selected on tab switch and aria-pressed / aria-label on filter pills', () => {
        const { api, tabFootballBtn, tabOtherBtn, footballTab, otherTab, elementsById } = createFrontendHarness();
        tabOtherBtn.click();
        assert.equal(tabOtherBtn.getAttribute('aria-selected'), 'true');
        assert.equal(tabFootballBtn.getAttribute('aria-selected'), 'false');
        assert.equal(otherTab.classList.contains('hidden'), false);
        assert.equal(footballTab.classList.contains('hidden'), true);

        api.setupFilters([
            { team_id: 1, name: 'Arsenal', league_id: 'PL', league_name: 'Premier League' }
        ]);
        const filterContainer = elementsById.get('filter-container');
        const plBtn = filterContainer.children.find(b => b.dataset.league === 'PL');
        assert.ok(plBtn);
        assert.equal(plBtn.getAttribute('aria-label'), 'Filter by Premier League (1 teams)');
        assert.equal(plBtn.getAttribute('aria-pressed'), 'false');

        plBtn.click();
        assert.equal(plBtn.getAttribute('aria-pressed'), 'true');
    });
});

// ============================================================================
// 6. Confetti Engine (public/confetti.js, F9)
// ============================================================================
describe('F9: ConfettiCannon (public/confetti.js)', () => {
    function createConfettiSandbox() {
        const listeners = new Map();
        const removedListeners = [];
        const rafQueue = new Map();
        let nextRafId = 1;
        let nowMs = 1000;
        let nextTimerId = 1;
        const timers = new Map();
        const intervals = new Map();

        const windowMock = {
            innerWidth: 1280,
            innerHeight: 720,
            addEventListener(type, fn) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            },
            removeEventListener(type, fn) {
                removedListeners.push({ type, fn });
                if (!listeners.has(type)) return;
                listeners.set(type, listeners.get(type).filter(f => f !== fn));
            }
        };

        const ctx = {
            clearRectCalls: 0,
            clearRect() { this.clearRectCalls += 1; },
            save() {},
            translate() {},
            rotate() {},
            fillRect() {},
            restore() {}
        };
        const canvas = { width: 0, height: 0, getContext: () => ctx };

        const sandbox = {
            window: windowMock,
            Math,
            Set,
            Date: { now: () => nowMs },
            requestAnimationFrame: (cb) => {
                const id = nextRafId++;
                rafQueue.set(id, cb);
                return id;
            },
            cancelAnimationFrame: (id) => {
                rafQueue.delete(id);
            },
            setTimeout: (fn, delay = 0) => {
                const id = nextTimerId++;
                timers.set(id, { fn, runAt: nowMs + delay });
                return id;
            },
            clearTimeout: (id) => { timers.delete(id); },
            setInterval: (fn, delay = 50) => {
                const id = nextTimerId++;
                intervals.set(id, { fn, delay, runAt: nowMs + delay });
                return id;
            },
            clearInterval: (id) => { intervals.delete(id); }
        };

        vm.runInNewContext(confettiJsSource, sandbox, { filename: 'public/confetti.js' });

        return {
            ConfettiCannon: windowMock.ConfettiCannon,
            canvas,
            ctx,
            listeners,
            removedListeners,
            rafQueue,
            timers,
            intervals,
            stepFrame() {
                const entries = [...rafQueue.entries()];
                rafQueue.clear();
                for (const [, cb] of entries) cb();
            },
            advanceTime(ms) {
                nowMs += ms;
                for (const [id, t] of [...timers.entries()]) {
                    if (t.runAt <= nowMs) {
                        timers.delete(id);
                        t.fn();
                    }
                }
                for (const [id, iv] of [...intervals.entries()]) {
                    if (iv.runAt <= nowMs) {
                        iv.runAt += iv.delay;
                        iv.fn();
                    }
                }
            }
        };
    }

    it('removes the exact resize listener reference and clears all timers/intervals/RAF in destroy()', () => {
        const sb = createConfettiSandbox();
        const cannon = new sb.ConfettiCannon(sb.canvas);
        const addedResizeFn = sb.listeners.get('resize')[0];
        assert.equal(typeof addedResizeFn, 'function');

        cannon.celebrate();
        cannon.shower(2000);
        assert.ok(sb.timers.size > 0, 'celebrate() should register tracked timeouts');
        assert.ok(sb.intervals.size > 0, 'shower() should register tracked interval');
        assert.ok(sb.rafQueue.size > 0, 'RAF loop should be scheduled');

        cannon.destroy();
        assert.equal(sb.timers.size, 0, 'All timeouts must be cleared on destroy()');
        assert.equal(sb.intervals.size, 0, 'All intervals must be cleared on destroy()');
        assert.equal(sb.rafQueue.size, 0, 'Pending RAF must be cancelled on destroy()');
        assert.equal(cannon.particles.length, 0);
        assert.equal(sb.listeners.get('resize').length, 0);
        assert.equal(sb.removedListeners[0].fn, addedResizeFn, 'removeEventListener must receive exact bound reference');
    });

    it('spawns shower particles moving downward (vy > 0)', () => {
        const sb = createConfettiSandbox();
        const cannon = new sb.ConfettiCannon(sb.canvas);
        for (let i = 0; i < 30; i++) {
            const p = cannon.createParticle(500, -20, false);
            assert.ok(p.vy > 0, `Expected downward shower velocity vy > 0, got ${p.vy}`);
        }
        cannon.destroy();
    });

    it('auto-stops RAF loop once all particles finish and no timers/intervals remain', () => {
        const sb = createConfettiSandbox();
        const cannon = new sb.ConfettiCannon(sb.canvas);
        cannon.burst(100, 100, 1);
        // Make particle expire on next frame
        cannon.particles[0].opacity = 0.001;
        cannon.particles[0].fadeSpeed = 0.01;

        sb.stepFrame();
        assert.equal(cannon.particles.length, 0);
        assert.equal(cannon.isRunning, false, 'RAF loop should auto-stop when idle');
        assert.equal(sb.rafQueue.size, 0, 'No further RAF should be scheduled when idle');
        cannon.destroy();
    });

    it('no-ops cleanly without throwing when canvas.getContext("2d") returns null', () => {
        const sb = createConfettiSandbox();
        const nullCtxCanvas = { width: 100, height: 100, getContext: () => null };
        const cannon = new sb.ConfettiCannon(nullCtxCanvas);

        assert.doesNotThrow(() => {
            cannon.burst(10, 10, 5);
            cannon.shower(100);
            cannon.celebrate();
        });
        assert.equal(cannon.isRunning, false);
        assert.equal(cannon.animationId, null);
        cannon.destroy();
    });
});

// ============================================================================
// 7. Tier-5 Hardening Regressions (SWR Revocation & Defensive Rendering)
// ============================================================================
describe('Tier-5 Frontend Hardening Regressions', () => {
    it('cancels celebration timers and prevents overlay when live hasWon5: false revokes stale SWR hasWon5: true (while preserving demo mode)', () => {
        const { api, document, elementsById, advanceTimers } = createFrontendHarness();
        const answerEl = elementsById.get('united-answer');

        // 1. Stale SWR cache triggers celebration
        api.renderUnitedData({
            hasWon5: true,
            achievementDate: '2026-05-01T15:00:00Z',
            form: 'WWWWW',
            currentStreak: 5
        });

        // 2. At t=150ms, live API responds with hasWon5: false
        advanceTimers(150);
        api.renderUnitedData({
            hasWon5: false,
            achievementDate: null,
            form: 'WWLWD',
            currentStreak: 0
        });
        assert.equal(answerEl.textContent, 'NO');

        // 3. After t=1600ms+, hero must remain 'NO' and no overlay should mount
        advanceTimers(2000);
        assert.equal(answerEl.textContent, 'NO');
        assert.equal(document.getElementById('celebration-overlay'), null);
        assert.equal(document.getElementById('confetti-canvas'), null);

        // 4. Localhost ?celebrate=true demo mode must NOT be aborted by a live hasWon5: false response
        api.triggerCelebration({
            isDemo: true,
            achievementDate: '2026-05-01T15:00:00Z',
            teamsFirst: 42
        });
        advanceTimers(150);
        api.renderUnitedData({
            hasWon5: false,
            achievementDate: null,
            form: 'WWLWD',
            currentStreak: 0
        });
        advanceTimers(2000);
        assert.equal(answerEl.textContent, 'YES');
        assert.ok(document.getElementById('celebration-overlay'), 'Demo celebration overlay should remain active');
        api.dismissCelebration();
    });

    it('renderClosestAttempt avoids epoch "Jan 1" on null dates, clears "Loading..." when bestStreakDetails is null, and handles non-string opponent', () => {
        const { api, elementsById } = createFrontendHarness();
        const datesEl = elementsById.get('best-streak-dates');
        const circlesEl = elementsById.get('streak-circles');

        // 1. null startDate/endDate must render "" (not "Jan 1")
        datesEl.textContent = 'Loading...';
        api.renderClosestAttempt({
            bestStreak: 2,
            bestStreakDetails: { startDate: null, endDate: null, matches: [] }
        });
        assert.equal(datesEl.textContent, '');

        // 2. bestStreakDetails: null must clear "Loading..." to ""
        datesEl.textContent = 'Loading...';
        api.renderClosestAttempt({
            bestStreak: 2,
            bestStreakDetails: null
        });
        assert.equal(datesEl.textContent, '');

        // 3. Non-string opponent must coerce safely without throwing TypeError
        assert.doesNotThrow(() => {
            api.renderClosestAttempt({
                bestStreak: 1,
                bestStreakDetails: {
                    startDate: '2025-01-01',
                    endDate: '2025-01-01',
                    matches: [{ opponent: 12345, home: true }]
                }
            });
        });
        assert.ok(circlesEl.innerHTML.includes('123'));
    });
});

