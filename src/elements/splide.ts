import Splide, { Options } from '@splidejs/splide';

customElements.define(
    'splide-section',
    class SplideSlider extends HTMLElement {
        private splide: Splide | null = null;
        private _handlePinClick: EventListener | null = null;

        connectedCallback(): void {
            const splideHolder = this.querySelector(
                '.splide',
            ) as HTMLElement | null;
            if (!splideHolder) return;

            const dataset = this.dataset;

            const options: Options = {
                autoplay: this.toBool(dataset.splideAutoplay, false),
                interval: this.toNumber(dataset.splideInterval, 100),
                type: dataset.splideType || 'slide',
                perPage: this.toNumber(dataset.splidePerPageMobile, 1.2),
                gap: dataset.splideGapMobile || '1rem',
                pauseOnHover: this.toBool(dataset.splidePauseOnHover, true),
                height: dataset.splideHeight || 'auto',
                pagination: this.toBool(dataset.splidePagination, false),
                arrows: this.toBool(dataset.splideArrows, false),
                padding: dataset.splidePadding || '0rem',
                perMove: 1,
                perSlide: 1,
                focus: 0,
                keyboard: true,
                omitEnd: true,
                drag: true,
                autoWidth: this.toBool(dataset.splideAutoWidth, false),
                speed: 1000,
                easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
                mediaQuery: 'min',
                breakpoints: {
                    640: {
                        perPage: this.toNumber(
                            dataset.splidePerPageDesktop,
                            3.3,
                        ),
                        drag: true,
                        gap: dataset.splideGapDesktop || '1rem',
                        padding: dataset.splidePaddingDesktop || '0rem',
                    },
                },
            };

            this.splide = new Splide(splideHolder, options);

            const section = this.closest('section');
            const handlePinClick = ((event: CustomEvent) => {
                if (this.splide) {
                    this.splide.go(event.detail.index);
                }
            }) as EventListener;

            section?.addEventListener(
                'shop-the-look-pin-clicked',
                handlePinClick,
            );
            this._handlePinClick = handlePinClick;

            this.splide.on('move', (newIndex) => {
                if (!section) return;
                const activePin = section.querySelector(
                    '[data-pin-order][data-active]',
                );
                const destinationPin = section.querySelector(
                    `[data-pin-order="${newIndex}"]`,
                );

                if (activePin) {
                    activePin.removeAttribute('data-active');
                }

                if (destinationPin) {
                    destinationPin.setAttribute('data-active', '');
                }
            });

            const paginationContainer = this.querySelector(
                '.splide-custom-pagination',
            ) as HTMLElement | null;

            if (paginationContainer) {
                this.splide.on('pagination:mounted', (data) => {
                    paginationContainer.innerHTML = '';
                    data.list.classList.add('flex', 'gap-4');
                    paginationContainer.appendChild(data.list);
                });
            }

            this.splide.mount();

            this.addEventListener(
                'wheel',
                (e: WheelEvent) => {
                    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                        e.preventDefault();
                        if (this.splide && Math.abs(e.deltaX) > 10) {
                            this.splide.go(e.deltaX > 0 ? '>' : '<');
                        }
                    }
                },
                { passive: false },
            );
        }

        // Called by product-tabs when a hidden tab panel becomes visible, so
        // the slider re-measures instead of keeping its zero-width layout.
        refresh(): void {
            this.splide?.refresh();
        }

        disconnectedCallback(): void {
            const section = this.closest('section');
            if (this._handlePinClick && section) {
                section.removeEventListener(
                    'shop-the-look-pin-clicked',
                    this._handlePinClick,
                );
                this._handlePinClick = null;
            }

            if (this.splide) {
                this.splide.destroy();
                this.splide = null;
            }
        }

        private toNumber(value: string | undefined, fallback: number): number {
            const parsed = Number(value);
            return isNaN(parsed) ? fallback : parsed;
        }

        private toBool(value: string | undefined, fallback: boolean): boolean {
            if (value === undefined) return fallback;
            return value === 'true';
        }
    },
);
