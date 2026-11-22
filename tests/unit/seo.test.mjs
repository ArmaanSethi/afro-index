import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const publicIndexHtml = () => fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const inputCss = fs.readFileSync(path.join(ROOT, 'src/input.css'), 'utf8');
const outputCss = () => fs.readFileSync(path.join(PUBLIC_DIR, 'output.css'), 'utf8');

function stripScripts(html) {
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function getAttr(tag, attrName) {
    const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const match = tag.match(regex);
    return match ? (match[1] ?? match[2] ?? '') : null;
}

describe('F13: Technical SEO Crawl Files, Icons & Metadata', () => {
    it('public/robots.txt exists with Allow, Disallow /api/, and Sitemap directive', () => {
        const robotsPath = path.join(PUBLIC_DIR, 'robots.txt');
        assert.equal(fs.existsSync(robotsPath), true, 'public/robots.txt must exist');
        const content = fs.readFileSync(robotsPath, 'utf8');
        assert.ok(content.trim().length > 0, 'robots.txt must be non-empty');
        assert.match(content, /^User-agent:\s*\*/m);
        assert.match(content, /^Allow:\s*\//m);
        assert.match(content, /^Disallow:\s*\/api\//m);
        assert.match(content, /^Sitemap:\s*https:\/\/www\.hasunitedwon5\.com\/sitemap\.xml/m);
    });

    it('public/sitemap.xml exists and lists canonical root URL', () => {
        const sitemapPath = path.join(PUBLIC_DIR, 'sitemap.xml');
        assert.equal(fs.existsSync(sitemapPath), true, 'public/sitemap.xml must exist');
        const content = fs.readFileSync(sitemapPath, 'utf8');
        assert.ok(content.trim().startsWith('<?xml'), 'sitemap.xml must start with XML declaration');
        assert.ok(
            content.includes('http://www.sitemaps.org/schemas/sitemap/0.9'),
            'sitemap.xml must declare sitemaps.org namespace'
        );
        assert.ok(
            content.includes('<loc>https://www.hasunitedwon5.com/</loc>'),
            'sitemap.xml must include canonical root <loc>'
        );
    });

    it('public/favicon.svg exists and is valid SVG markup', () => {
        const faviconPath = path.join(PUBLIC_DIR, 'favicon.svg');
        assert.equal(fs.existsSync(faviconPath), true, 'public/favicon.svg must exist');
        const content = fs.readFileSync(faviconPath, 'utf8').trim();
        assert.match(content, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/);
        assert.match(content, /\bviewBox="[^"]+"/);
        assert.ok(content.endsWith('</svg>'), 'favicon.svg must close with </svg>');
    });

    it('public/site.webmanifest exists, parses as JSON, and references existing icons', () => {
        const manifestPath = path.join(PUBLIC_DIR, 'site.webmanifest');
        assert.equal(fs.existsSync(manifestPath), true, 'public/site.webmanifest must exist');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0);
        assert.ok(typeof manifest.short_name === 'string' && manifest.short_name.length > 0);
        assert.equal(manifest.start_url, '/');
        assert.ok(typeof manifest.display === 'string' && manifest.display.length > 0);
        assert.equal(manifest.theme_color, '#050505');
        assert.equal(manifest.background_color, '#050505');
        assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
        for (const icon of manifest.icons) {
            assert.ok(typeof icon.src === 'string' && icon.src.startsWith('/'));
            const iconFile = path.join(PUBLIC_DIR, icon.src.replace(/^\//, ''));
            assert.equal(fs.existsSync(iconFile), true, `Manifest icon ${icon.src} must exist in public/`);
        }
    });

    it('index.html <head> includes compliant SEO meta, icons, OG, Twitter, canonical & www consistency', () => {
        const titleMatch = indexHtml.match(/<title>([^<]+)<\/title>/i);
        assert.ok(titleMatch, '<title> must exist');
        assert.ok(titleMatch[1].trim().length > 0 && titleMatch[1].trim().length <= 65, '<title> must be <= 65 chars');

        const descMatch = indexHtml.match(/<meta\b[^>]*name=["']description["'][^>]*>/i);
        assert.ok(descMatch, '<meta name="description"> must exist');
        const descContent = getAttr(descMatch[0], 'content');
        assert.ok(descContent && descContent.length > 0 && descContent.length <= 155, `description length (${descContent?.length}) must be <= 155`);

        const robotsMatch = indexHtml.match(/<meta\b[^>]*name=["']robots["'][^>]*>/i);
        assert.ok(robotsMatch, '<meta name="robots"> must exist');
        const robotsContent = getAttr(robotsMatch[0], 'content') || '';
        assert.match(robotsContent, /\bindex\b/i);
        assert.match(robotsContent, /\bfollow\b/i);

        const themeMatch = indexHtml.match(/<meta\b[^>]*name=["']theme-color["'][^>]*>/i);
        assert.ok(themeMatch, '<meta name="theme-color"> must exist');
        assert.equal(getAttr(themeMatch[0], 'content'), '#050505');

        const canonicalMatch = indexHtml.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i);
        assert.ok(canonicalMatch, '<link rel="canonical"> must exist');
        assert.equal(getAttr(canonicalMatch[0], 'href'), 'https://www.hasunitedwon5.com/');

        const iconMatch = indexHtml.match(/<link\b[^>]*rel=["']icon["'][^>]*>/i);
        assert.ok(iconMatch, '<link rel="icon"> must exist');
        assert.equal(getAttr(iconMatch[0], 'href'), '/favicon.svg');
        assert.ok(!indexHtml.includes('data:image/svg+xml'), 'must not use data-URI SVG favicon');

        const manifestLink = indexHtml.match(/<link\b[^>]*rel=["']manifest["'][^>]*>/i);
        assert.ok(manifestLink, '<link rel="manifest"> must exist');
        assert.equal(getAttr(manifestLink[0], 'href'), '/site.webmanifest');

        const appleIcon = indexHtml.match(/<link\b[^>]*rel=["']apple-touch-icon["'][^>]*>/i);
        assert.ok(appleIcon, '<link rel="apple-touch-icon"> must exist');
        const appleHref = getAttr(appleIcon[0], 'href');
        assert.ok(appleHref && fs.existsSync(path.join(PUBLIC_DIR, appleHref.replace(/^\//, ''))));

        const requiredOg = [
            'og:type', 'og:locale', 'og:url', 'og:site_name', 'og:title',
            'og:description', 'og:image', 'og:image:width', 'og:image:height',
            'og:image:type', 'og:image:alt'
        ];
        for (const prop of requiredOg) {
            const re = new RegExp(`<meta\\b[^>]*property=["']${prop}["'][^>]*>`, 'i');
            const m = indexHtml.match(re);
            assert.ok(m, `Missing Open Graph tag ${prop}`);
            const val = getAttr(m[0], 'content');
            assert.ok(val && val.length > 0, `Empty Open Graph tag ${prop}`);
            if (prop === 'og:locale') {
                assert.match(val, /^en_(GB|US)$/);
            }
        }

        const requiredTwitter = [
            'twitter:card', 'twitter:title', 'twitter:description',
            'twitter:image', 'twitter:image:alt'
        ];
        for (const name of requiredTwitter) {
            const re = new RegExp(`<meta\\b[^>]*name=["']${name}["'][^>]*>`, 'i');
            const m = indexHtml.match(re);
            assert.ok(m, `Missing Twitter tag ${name}`);
            assert.ok(getAttr(m[0], 'content')?.length > 0, `Empty Twitter tag ${name}`);
        }

        const bareDomainMatches = indexHtml.match(/https:\/\/hasunitedwon5\.com\b/g) || [];
        assert.equal(bareDomainMatches.length, 0, 'All URLs must consistently use https://www.hasunitedwon5.com/');
    });

    it('contains 3 valid JSON-LD structured data blocks (WebSite, Person, FAQPage)', () => {
        const blocks = [...indexHtml.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        assert.equal(blocks.length, 3, 'Expected exactly 3 JSON-LD script blocks');

        const types = new Set();
        for (const [, jsonText] of blocks) {
            const parsed = JSON.parse(jsonText);
            assert.equal(parsed['@context'], 'https://schema.org');
            types.add(parsed['@type']);
            if (parsed['@type'] === 'FAQPage') {
                assert.ok(Array.isArray(parsed.mainEntity) && parsed.mainEntity.length >= 4);
            }
        }
        assert.ok(types.has('WebSite'));
        assert.ok(types.has('Person'));
        assert.ok(types.has('FAQPage'));
    });
});

describe('F14: HTML Semantics, Link Security, Accessibility & <noscript>', () => {
    it('maintains valid heading hierarchy with single <h1> and no level skips', () => {
        const staticHtml = stripScripts(indexHtml);
        const headings = [...staticHtml.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];

        const h1s = headings.filter((m) => m[1] === '1');
        assert.equal(h1s.length, 1, 'Static HTML must contain exactly one <h1>');
        assert.match(h1s[0][2], /Has United Won 5 in a Row\?/);

        assert.ok(!/<h1\b[^>]*id=["']celebration-title["']/i.test(indexHtml), 'Celebration overlay must not use <h1>');
        assert.ok(/<h2\b[^>]*id=["']celebration-title["']/i.test(indexHtml), 'Celebration overlay must use <h2 id="celebration-title">');

        const liveCoverage = headings.find((m) => m[2].includes('Live Coverage Status'));
        assert.ok(liveCoverage && liveCoverage[1] === '2', 'Live Coverage Status must be <h2>');

        const unitedWatch = headings.find((m) => m[2].includes('United Watch'));
        assert.ok(unitedWatch && unitedWatch[1] === '3', 'United Watch must be <h3>');

        let prevLevel = 0;
        for (const m of headings) {
            const level = Number(m[1]);
            if (prevLevel > 0) {
                assert.ok(
                    level <= prevLevel + 1,
                    `Heading level skip detected: h${prevLevel} -> h${level} (${m[2].replace(/<[^>]+>/g, '').trim()})`
                );
            }
            prevLevel = level;
        }
    });

    it('adds rel="noopener noreferrer" to every target="_blank" link (static and JS templates)', () => {
        const blankLinks = [...indexHtml.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)];
        assert.ok(blankLinks.length >= 8, `Expected at least 8 target="_blank" links, found ${blankLinks.length}`);

        for (const [tag] of blankLinks) {
            const rel = getAttr(tag, 'rel') || '';
            const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
            assert.ok(tokens.includes('noopener'), `Link missing noopener: ${tag}`);
            assert.ok(tokens.includes('noreferrer'), `Link missing noreferrer: ${tag}`);
        }
    });

    it('provides <noscript> fallback markup for JS-disabled users', () => {
        const noscriptBlocks = [...indexHtml.matchAll(/<noscript>([\s\S]*?)<\/noscript>/gi)];
        assert.ok(noscriptBlocks.length >= 1, 'Must include at least one <noscript> block');
        const hasVisibleMessage = noscriptBlocks.some(([, inner]) => /JavaScript is required/i.test(inner));
        assert.equal(hasVisibleMessage, true, 'Must include user-facing <noscript> message');
    });

    it('has accessible <nav>, aria-hidden decorative SVGs, sized <img> elements, and deferred confetti.js', () => {
        const staticHtml = stripScripts(indexHtml);

        const navMatch = staticHtml.match(/<nav\b[^>]*>/i);
        assert.ok(navMatch, '<nav> must exist');
        const navLabel = getAttr(navMatch[0], 'aria-label');
        assert.ok(navLabel && navLabel.trim().length > 0, '<nav> must have non-empty aria-label');

        const svgs = [...staticHtml.matchAll(/<svg\b[^>]*>/gi)];
        assert.ok(svgs.length >= 3, 'Expected decorative <svg> elements in static HTML');
        for (const [svgTag] of svgs) {
            assert.equal(getAttr(svgTag, 'aria-hidden'), 'true', `Decorative SVG missing aria-hidden="true": ${svgTag}`);
        }

        const imgs = [...indexHtml.matchAll(/<img\b[^>]*>/gi)];
        assert.ok(imgs.length >= 7, `Expected at least 7 <img> elements, found ${imgs.length}`);
        for (const [imgTag] of imgs) {
            const width = getAttr(imgTag, 'width');
            const height = getAttr(imgTag, 'height');
            assert.match(width || '', /^\d+$/, `<img> missing numeric width: ${imgTag}`);
            assert.match(height || '', /^\d+$/, `<img> missing numeric height: ${imgTag}`);
        }

        const confettiScript = indexHtml.match(/<script\b[^>]*src=["']\/confetti\.js["'][^>]*>/i);
        assert.ok(confettiScript, '<script src="/confetti.js"> must exist');
        assert.match(confettiScript[0], /\bdefer\b/i, '<script src="/confetti.js"> must have defer attribute');
    });
});

describe('F15: Performance, Font Deduplication, Asset Cleanup & Deployment Config', () => {
    it('deduplicates Inter @font-face in src/input.css and public/output.css', () => {
        const interBlocks = [...inputCss.matchAll(/@font-face\s*\{[^}]*font-family:\s*['"]Inter['"][^}]*\}/gi)];
        assert.equal(interBlocks.length, 1, 'src/input.css must contain exactly 1 Inter @font-face rule');
        assert.match(interBlocks[0][0], /font-weight:\s*100\s+900\s*;/);
        assert.match(interBlocks[0][0], /font-display:\s*swap\s*;/);
        assert.match(interBlocks[0][0], /url\(['"]\/fonts\/inter-400\.woff2['"]\)\s*format\(['"]woff2['"]\)/);

        const monoBlocks = [...inputCss.matchAll(/@font-face\s*\{[^}]*font-family:\s*['"]JetBrains Mono['"][^}]*\}/gi)];
        assert.equal(monoBlocks.length, 2, 'src/input.css must retain both JetBrains Mono @font-face rules');

        const builtCss = outputCss();
        for (const removedFont of ['inter-600.woff2', 'inter-700.woff2', 'inter-900.woff2']) {
            assert.ok(!inputCss.includes(removedFont), `src/input.css must not reference ${removedFont}`);
            assert.ok(!builtCss.includes(removedFont), `public/output.css must not reference ${removedFont}`);
        }
        assert.ok(builtCss.includes('100 900'), 'public/output.css must contain variable weight range 100 900');
        assert.ok(builtCss.includes('/fonts/inter-400.woff2'), 'public/output.css must reference /fonts/inter-400.woff2');
    });

    it('preloads only deduplicated fonts in index.html', () => {
        assert.ok(indexHtml.includes('href="/fonts/inter-400.woff2"'));
        assert.ok(indexHtml.includes('href="/fonts/jetbrains-mono-400.woff2"'));
        for (const removedFont of ['inter-600.woff2', 'inter-700.woff2', 'inter-900.woff2']) {
            assert.ok(!indexHtml.includes(removedFont), `index.html must not reference ${removedFont}`);
        }
    });

    it('removes redundant/junk files while keeping required assets intact', () => {
        const removedFiles = [
            'public/fonts/inter-600.woff2',
            'public/fonts/inter-700.woff2',
            'public/fonts/inter-900.woff2',
            'og_image.jpeg',
            '.DS_Store'
        ];
        for (const relPath of removedFiles) {
            assert.equal(fs.existsSync(path.join(ROOT, relPath)), false, `${relPath} must be deleted`);
        }

        const requiredFiles = [
            'public/fonts/inter-400.woff2',
            'public/fonts/jetbrains-mono-400.woff2',
            'public/fonts/jetbrains-mono-700.woff2',
            'public/og_image.jpeg',
            'public/united-crest.png'
        ];
        for (const relPath of requiredFiles) {
            const fullPath = path.join(ROOT, relPath);
            assert.equal(fs.existsSync(fullPath), true, `${relPath} must exist`);
            assert.ok(fs.statSync(fullPath).size > 0, `${relPath} must be non-empty`);
        }
    });

    it('configures immutable font caching and security headers in vercel.json while preserving existing config', () => {
        const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
        assert.equal(vercel.buildCommand, 'npm run build');
        assert.equal(vercel.outputDirectory, 'public');
        assert.equal(vercel.framework, null);
        assert.deepEqual(vercel.functions, {
            'api/*.js': { memory: 1024, maxDuration: 10 }
        });
        assert.deepEqual(vercel.crons, [
            { path: '/api/scan-all', schedule: '0 6 * * *' },
            { path: '/api/scan-all', schedule: '0 18 * * *' }
        ]);

        assert.ok(Array.isArray(vercel.headers) && vercel.headers.length >= 2);
        const fontRule = vercel.headers.find((h) => h.source === '/fonts/(.*)');
        assert.ok(fontRule, 'vercel.json must define /fonts/(.*) header rule');
        assert.ok(
            fontRule.headers.some((h) => h.key === 'Cache-Control' && h.value === 'public, max-age=31536000, immutable')
        );

        const globalRule = vercel.headers.find((h) => h.source === '/(.*)');
        assert.ok(globalRule, 'vercel.json must define /(.*) security headers rule');
        const headerMap = Object.fromEntries(globalRule.headers.map((h) => [h.key, h.value]));
        assert.equal(headerMap['X-Content-Type-Options'], 'nosniff');
        assert.equal(headerMap['X-Frame-Options'], 'DENY');
        assert.equal(headerMap['Referrer-Policy'], 'strict-origin-when-cross-origin');
        assert.equal(headerMap['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
    });

    it('includes .gitignore covering dependencies, OS metadata, env files, and Vercel', () => {
        const gitignorePath = path.join(ROOT, '.gitignore');
        assert.equal(fs.existsSync(gitignorePath), true, '.gitignore must exist');
        const content = fs.readFileSync(gitignorePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const entry of ['node_modules/', '.DS_Store', '.vercel', '.agents/teamwork/']) {
            assert.ok(lines.includes(entry), `.gitignore must include ${entry}`);
        }
        assert.ok(
            lines.includes('.env*') || (lines.includes('.env') && lines.includes('.env.local')),
            '.gitignore must exclude .env files (.env* or .env/.env.local)'
        );
    });
});

describe('Build Output Synchronization', () => {
    it('keeps index.html and public/index.html byte-identical', () => {
        assert.equal(indexHtml, publicIndexHtml(), 'index.html and public/index.html must match');
    });
});
