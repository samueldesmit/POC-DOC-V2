import axios from 'axios';
import { debounce, publish } from '../global.js';

customElements.define(
    'predictive-search',
    class PredictiveSearch extends HTMLElement {
        inputElement!: HTMLInputElement;
        resultsSectionId!: string;
        debouncedOnInputChange!: (event: Event) => void;
        outsideClickHandler!: (event: MouseEvent) => void;

        connectedCallback(): void {
            this.resultsSectionId = this.dataset.sectionId || '';
            this.debouncedOnInputChange = debounce(
                this.onInputChange.bind(this),
                300,
            );
            this.outsideClickHandler = this.onDocumentClick.bind(this);
            // The modal that contains the search input portals itself to
            // <body> on connect (see modal-dialog.ts), so by the time we
            // run, the input is no longer a descendant of this element.
            // Query the document instead. Defer one tick so that whichever
            // element upgrades first, the input is already in its final
            // home before we look for it.
            queueMicrotask(() => this.attachInputListener());
            document.addEventListener('click', this.outsideClickHandler);
        }

        private attachInputListener(): void {
            this.inputElement = document.querySelector(
                '[data-target="predictive-search.input"]',
            ) as HTMLInputElement;
            if (this.inputElement) {
                this.inputElement.addEventListener(
                    'input',
                    this.debouncedOnInputChange,
                );
            }
        }

        private onDocumentClick(event: MouseEvent): void {
            const dialog = document.querySelector(
                'modal-dialog[data-id="search-results"]',
            );
            if (!dialog || !dialog.hasAttribute('data-open')) return;

            const panel = dialog.querySelector(
                '[data-target="predictive-search.panel"]',
            );
            const target = event.target as Node | null;
            if (!panel || !target) return;
            if (panel.contains(target)) return;
            if (!dialog.contains(target)) return;

            publish('modalToggle', { id: 'search-results', open: false });
        }

        disconnectedCallback(): void {
            if (this.inputElement && this.debouncedOnInputChange) {
                this.inputElement.removeEventListener(
                    'input',
                    this.debouncedOnInputChange,
                );
            }
            if (this.outsideClickHandler) {
                document.removeEventListener(
                    'click',
                    this.outsideClickHandler,
                );
            }
        }

        async onInputChange(event: Event): Promise<void> {
            const input = event.target as HTMLInputElement;
            const searchTerm = input.value.trim();
            if (!searchTerm) return;

            const url = `/search/suggest?q=${encodeURIComponent(searchTerm)}&resources[type]=product,collection,article,page&section_id=${this.resultsSectionId}&resources[options][unavailable_products]=show`;

            try {
                const response = await axios.get(url);
                const parser = new DOMParser();
                const dom = parser.parseFromString(response.data, 'text/html');
                const section = dom.querySelector('.predictive-search-results');
                const target = document.querySelector(
                    '.predictive-search-results',
                );

                console.debug('[predictive-search]', {
                    url,
                    sectionId: this.resultsSectionId,
                    sectionFound: !!section,
                    targetFound: !!target,
                    productMatches:
                        dom.querySelectorAll('[data-product-card], .product-card, [data-product-id]')
                            .length,
                });

                if (section && target) {
                    target.innerHTML = section.innerHTML;
                }
            } catch (error) {
                console.error(error);
            }
        }
    },
);
