/**
 * Confetti Particle System for United 5-Win Celebration
 * Lightweight, canvas-based, performant
 */

class ConfettiCannon {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.particles = [];
        this.animationId = null;
        this.isRunning = false;
        this.timers = new Set();
        this.intervals = new Set();
        this.destroyed = false;

        // United colors: Red, Gold, White
        this.colors = [
            '#DA291C', // United Red
            '#FBE122', // Gold
            '#FFFFFF', // White
            '#DA291C', // More red (weighted)
            '#FBE122', // More gold (weighted)
        ];

        this.resize();
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    _schedule(fn, delay) {
        if (this.destroyed) return null;
        const id = setTimeout(() => {
            this.timers.delete(id);
            if (!this.destroyed) fn();
        }, delay);
        this.timers.add(id);
        return id;
    }

    createParticle(x, y, isExplosion = false) {
        const angle = isExplosion
            ? Math.random() * Math.PI * 2
            : Math.PI / 2 + (Math.random() - 0.5) * 0.6;
        const velocity = isExplosion
            ? Math.random() * 15 + 10
            : Math.random() * 8 + 4;

        return {
            x,
            y,
            vx: Math.cos(angle) * velocity,
            vy: Math.sin(angle) * velocity,
            width: Math.random() * 12 + 8,
            height: Math.random() * 8 + 4,
            color: this.colors[Math.floor(Math.random() * this.colors.length)],
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.3,
            gravity: 0.3,
            drag: 0.99,
            opacity: 1,
            fadeSpeed: Math.random() * 0.005 + 0.002
        };
    }

    burst(x, y, count = 100) {
        if (this.destroyed) return;
        for (let i = 0; i < count; i++) {
            this.particles.push(this.createParticle(x, y, true));
        }
        if (!this.isRunning) this.start();
    }

    shower(duration = 3000) {
        if (this.destroyed) return;
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (this.destroyed || Date.now() - startTime > duration) {
                clearInterval(interval);
                this.intervals.delete(interval);
                return;
            }
            // Rain from top
            for (let i = 0; i < 5; i++) {
                const x = Math.random() * this.canvas.width;
                this.particles.push(this.createParticle(x, -20, false));
            }
        }, 50);
        this.intervals.add(interval);
        if (!this.isRunning) this.start();
    }

    update() {
        if (!this.ctx || !this.canvas) {
            this.isRunning = false;
            this.animationId = null;
            return;
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];

            // Physics
            p.vy += p.gravity;
            p.vx *= p.drag;
            p.vy *= p.drag;
            p.x += p.vx;
            p.y += p.vy;
            p.rotation += p.rotationSpeed;
            p.opacity -= p.fadeSpeed;

            // Remove dead particles
            if (p.opacity <= 0 || p.y > this.canvas.height + 50) {
                this.particles.splice(i, 1);
                continue;
            }

            // Draw
            this.ctx.save();
            this.ctx.translate(p.x, p.y);
            this.ctx.rotate(p.rotation);
            this.ctx.globalAlpha = p.opacity;
            this.ctx.fillStyle = p.color;
            this.ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
            this.ctx.restore();
        }

        const hasPendingWork = this.particles.length > 0 || this.timers.size > 0 || this.intervals.size > 0;
        if (this.isRunning && hasPendingWork) {
            this.animationId = requestAnimationFrame(() => this.update());
        } else {
            this.isRunning = false;
            this.animationId = null;
        }
    }

    start() {
        if (this.destroyed || this.isRunning) return;
        this.isRunning = true;
        this.update();
    }

    stop() {
        this.isRunning = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    // Epic celebration sequence
    celebrate() {
        if (this.destroyed) return;

        // Initial burst from center
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 3;
        this.burst(centerX, centerY, 150);

        // Side cannons
        this._schedule(() => {
            this.burst(0, this.canvas.height, 80);
            this.burst(this.canvas.width, this.canvas.height, 80);
        }, 200);

        // More center bursts
        this._schedule(() => this.burst(centerX, centerY, 100), 400);

        // Continuous shower
        this._schedule(() => this.shower(4000), 500);

        // Final burst
        this._schedule(() => {
            this.burst(centerX, centerY - 100, 200);
        }, 1500);

        this.start();
    }

    destroy() {
        this.destroyed = true;
        this.stop();
        for (const id of this.timers) {
            clearTimeout(id);
        }
        this.timers.clear();
        for (const id of this.intervals) {
            clearInterval(id);
        }
        this.intervals.clear();
        this.particles = [];
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
            this._onResize = null;
        }
    }
}

// Export for use
if (typeof window !== 'undefined') {
    window.ConfettiCannon = ConfettiCannon;
}
