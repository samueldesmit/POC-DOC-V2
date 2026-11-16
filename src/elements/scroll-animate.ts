import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

type AnimationType =
    | 'fade-in'
    | 'fade-up'
    | 'fade-down'
    | 'fade-left'
    | 'fade-right'
    | 'zoom-in'
    | 'zoom-out'
    | 'stagger';

customElements.define(
    'scroll-animate',
    class ScrollAnimate extends HTMLElement {
        connectedCallback(): void {
            // Behave as a block-level wrapper so block content inside doesn't
            // collapse (custom elements default to inline).
            this.style.display = 'block';
            this.removeAttribute('data-animate-pending');

            const animation = this.dataset.animation as AnimationType | undefined;
            if (!animation) return;

            const prefersReducedMotion = window.matchMedia(
                '(prefers-reduced-motion: reduce)',
            ).matches;
            if (prefersReducedMotion) return;

            const duration = parseFloat(this.dataset.duration ?? '0.8');
            const trigger = {
                trigger: this,
                start: 'top 85%',
                toggleActions: 'play none none none' as const,
            };

            // On mobile, horizontal slide animations cause page overflow in
            // stacked layouts — fall back to fade-up.
            let resolved: AnimationType = animation;
            const isMobile = window.innerWidth < 1024;
            if (isMobile && (resolved === 'fade-left' || resolved === 'fade-right')) {
                resolved = 'fade-up';
            }

            switch (resolved) {
                case 'fade-in':
                    gsap.fromTo(
                        this,
                        { opacity: 0 },
                        {
                            opacity: 1,
                            duration,
                            ease: 'power1.out',
                            scrollTrigger: trigger,
                        },
                    );
                    break;
                case 'fade-up':
                    gsap.fromTo(
                        this,
                        { opacity: 0, y: 30 },
                        {
                            opacity: 1,
                            y: 0,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'fade-down':
                    gsap.fromTo(
                        this,
                        { opacity: 0, y: -30 },
                        {
                            opacity: 1,
                            y: 0,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'fade-left':
                    gsap.fromTo(
                        this,
                        { opacity: 0, x: -40 },
                        {
                            opacity: 1,
                            x: 0,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'fade-right':
                    gsap.fromTo(
                        this,
                        { opacity: 0, x: 40 },
                        {
                            opacity: 1,
                            x: 0,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'zoom-in':
                    gsap.fromTo(
                        this,
                        { opacity: 0, scale: 0.92 },
                        {
                            opacity: 1,
                            scale: 1,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'zoom-out':
                    gsap.fromTo(
                        this,
                        { opacity: 0, scale: 1.08 },
                        {
                            opacity: 1,
                            scale: 1,
                            duration,
                            ease: 'power2.out',
                            scrollTrigger: trigger,
                            clearProps: 'transform',
                        },
                    );
                    break;
                case 'stagger': {
                    const targets = this.resolveStaggerTargets();
                    if (targets.length < 2) {
                        gsap.fromTo(
                            this,
                            { opacity: 0, y: 30 },
                            {
                                opacity: 1,
                                y: 0,
                                duration,
                                ease: 'power2.out',
                                scrollTrigger: trigger,
                                clearProps: 'transform',
                            },
                        );
                    } else {
                        gsap.fromTo(
                            targets,
                            { opacity: 0, y: 24 },
                            {
                                opacity: 1,
                                y: 0,
                                duration: 0.6,
                                ease: 'power2.out',
                                stagger: 0.1,
                                scrollTrigger: trigger,
                                clearProps: 'transform',
                            },
                        );
                    }
                    break;
                }
            }
        }

        private resolveStaggerTargets(): HTMLElement[] {
            const explicit = this.querySelectorAll<HTMLElement>('[data-stagger-child]');
            if (explicit.length > 1) return [...explicit];

            const slides = this.querySelectorAll<HTMLElement>('.splide__slide');
            if (slides.length > 1) return [...slides];

            const nested = this.querySelectorAll<HTMLElement>(
                ':scope > div > div, :scope > div > ul > li',
            );
            if (nested.length > 1) return [...nested];

            return [];
        }
    },
);
