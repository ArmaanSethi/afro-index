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

        // United colors: Red, Gold, White
        this.colors = [
            '#DA291C', // United Red
            '#FBE122', // Gold
            '#FFFFFF', // White
            '#DA291C', // More red (weighted)
            '#FBE122', // More gold (weighted)
        ];

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    createParticle(x, y, isExplosion = false) {
        const angle = isExplosion
            ? Math.random() * Math.PI * 2
            : -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
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
        for (let i = 0; i < count; i++) {
            this.particles.push(this.createParticle(x, y, true));
        }
    }

    shower(duration = 3000) {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (Date.now() - startTime > duration) {
                clearInterval(interval);
                return;
            }
            // Rain from top
            for (let i = 0; i < 5; i++) {
                const x = Math.random() * this.canvas.width;
                this.particles.push(this.createParticle(x, -20, false));
            }
        }, 50);
    }

    update() {
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

        if (this.isRunning || this.particles.length > 0) {
            this.animationId = requestAnimationFrame(() => this.update());
        }
    }

    start() {
        this.isRunning = true;
        this.update();
    }

    stop() {
        this.isRunning = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
    }

    // Epic celebration sequence
    celebrate() {
        this.start();

        // Initial burst from center
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 3;
        this.burst(centerX, centerY, 150);

        // Side cannons
        setTimeout(() => {
            this.burst(0, this.canvas.height, 80);
            this.burst(this.canvas.width, this.canvas.height, 80);
        }, 200);

        // More center bursts
        setTimeout(() => this.burst(centerX, centerY, 100), 400);

        // Continuous shower
        setTimeout(() => this.shower(4000), 500);

        // Final burst
        setTimeout(() => {
            this.burst(centerX, centerY - 100, 200);
        }, 1500);
    }

    destroy() {
        this.stop();
        this.particles = [];
        window.removeEventListener('resize', this.resize);
    }
}

// Export for use
window.ConfettiCannon = ConfettiCannon;
