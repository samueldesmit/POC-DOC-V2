import { gsap } from 'gsap';
import { customElement } from '../utilities/decorators';
import { subscribe } from '../global.js';

const SCROLL_THRESHOLD_PX = 8;
const SHOW_DURATION = 0.45;
const HIDE_DURATION = 0.35;
const EASE = 'power3.out';
const HEADER_MODALS = ['offcanvas-menu', 'cart-drawer', 'search-results'];

interface ModalDialogUpdate {
    open: boolean;
    current?: HTMLElement;
    previous?: HTMLElement;
}

@customElement('header-nav')
export class HeaderNav extends HTMLElement {
    private header: HTMLElement | null = null;
    private wrapper: HTMLElement | null = null;
    private announcementBar: HTMLElement | null = null;
    private previousScroll = 0;
    private accumulatedDelta = 0;
    private shouldDisappear = false;
    private isHidden = false;
    private isPinned = false;
    private isLocked = false;
    private rafId: number | null = null;
    private hideTween: gsap.core.Tween | null = null;
    private boundScrollHandler = this.onScroll.bind(this);
    private unsubscribe: (() => void) | null = null;
    private announcementBarObserver: ResizeObserver | null = null;

    connectedCallback(): void {
        this.header = document.getElementById('main-header-nav');
        if (!this.header) return;

        this.wrapper = this.header.parentElement;
        this.announcementBar = document.querySelector('[data-announcement-bar]');

        // Publish the announcement bar height as soon as we have a reference,
        // and keep it in sync if the bar resizes (font load, viewport resize,
        // slide change). Transparent-mode CSS reads this via
        // `top: var(--announcement-bar-height)`.
        this.publishAnnouncementBarHeight();
        if (this.announcementBar) {
            this.announcementBarObserver = new ResizeObserver(() =>
                this.publishAnnouncementBarHeight(),
            );
            this.announcementBarObserver.observe(this.announcementBar);
        }

        this.shouldDisappear =
            this.header.getAttribute('data-make-header-disappear-on-scroll') ===
            'true';

        // Intentionally do NOT pre-apply a transform here. Any transform on
        // the wrapper creates a new containing block, which would trap the
        // mobile menu's `<modal-dialog class="fixed inset-0">` inside the
        // header's bounds instead of the viewport.
        this.previousScroll = window.scrollY || 0;
        this.update(true);

        window.addEventListener('scroll', this.boundScrollHandler, {
            passive: true,
        });
        window.addEventListener('resize', this.boundScrollHandler);

        // While a header-attached modal is open (mobile menu, cart, search),
        // keep the header pinned in view so the action bar / hamburger
        // remain reachable for closing.
        this.unsubscribe = subscribe(
            'modalDialogUpdate',
            ({ open, current, previous }: ModalDialogUpdate) => {
                const dialog = open ? current : previous;
                const id = dialog?.getAttribute('data-id') ?? '';
                if (!HEADER_MODALS.includes(id)) return;
                this.isLocked = !!open;
                if (this.isLocked) this.setHidden(false, true);
                // Recompute --header-offset/--header-height now: CSS may
                // collapse elements above the header while a modal is open,
                // and the drawer would stay anchored to the stale offset.
                this.update();
            },
        );
    }

    disconnectedCallback(): void {
        window.removeEventListener('scroll', this.boundScrollHandler);
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.hideTween?.kill();
        this.unsubscribe?.();
        this.announcementBarObserver?.disconnect();
    }

    private getAnnouncementBarHeight(): number {
        return this.announcementBar?.offsetHeight ?? 0;
    }

    private publishAnnouncementBarHeight(): void {
        document.documentElement.style.setProperty(
            '--announcement-bar-height',
            `${this.getAnnouncementBarHeight()}px`,
        );
    }

    private onScroll(): void {
        if (this.rafId !== null) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.update();
        });
    }

    private update(initial = false): void {
        if (!this.header || !this.wrapper) return;

        const scroll = Math.max(0, window.scrollY || 0);
        const delta = scroll - this.previousScroll;
        const announcementBarHeight = this.getAnnouncementBarHeight();
        const pinned = scroll > announcementBarHeight;

        // Publish the bottom of the visible header in viewport coords as
        // `--header-offset` for the mobile menu drawer / dropdowns to anchor to.
        const headerRect = this.header.getBoundingClientRect();
        const headerTop = Math.max(0, headerRect.top);
        document.documentElement.style.setProperty(
            '--header-offset',
            `${headerTop + headerRect.height}px`,
        );
        document.documentElement.style.setProperty(
            '--header-height',
            `${headerRect.height}px`,
        );
        // Transparent-mode CSS uses `top: var(--announcement-bar-height)` to
        // sit the header below the announcement bar instead of overlapping it.
        document.documentElement.style.setProperty(
            '--announcement-bar-height',
            `${announcementBarHeight}px`,
        );

        if (pinned !== this.isPinned || initial) {
            this.isPinned = pinned;
            this.wrapper.toggleAttribute('data-fixed', pinned);
            this.header.toggleAttribute('data-scrolled', pinned);
        }

        if (this.shouldDisappear && pinned && !this.isLocked) {
            const sameDirection =
                Math.sign(delta) === Math.sign(this.accumulatedDelta);
            this.accumulatedDelta = sameDirection
                ? this.accumulatedDelta + delta
                : delta;

            if (Math.abs(this.accumulatedDelta) >= SCROLL_THRESHOLD_PX) {
                const shouldHide = this.accumulatedDelta > 0;
                if (shouldHide !== this.isHidden) {
                    this.setHidden(shouldHide);
                }
                this.accumulatedDelta = 0;
            }
        } else if (this.isHidden) {
            this.setHidden(false);
            this.accumulatedDelta = 0;
        }

        this.previousScroll = scroll;
    }

    private setHidden(hide: boolean, instant = false): void {
        if (!this.wrapper) return;
        this.isHidden = hide;
        this.hideTween?.kill();
        if (instant) {
            gsap.set(this.wrapper, {
                yPercent: hide ? -100 : 0,
                clearProps: hide ? '' : 'transform',
            });
            return;
        }
        this.hideTween = gsap.to(this.wrapper, {
            yPercent: hide ? -100 : 0,
            duration: hide ? HIDE_DURATION : SHOW_DURATION,
            ease: EASE,
            overwrite: 'auto',
            clearProps: hide ? '' : 'transform',
        });
    }
}
