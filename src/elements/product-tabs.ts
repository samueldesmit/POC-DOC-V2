customElements.define(
    'product-tabs',
    class ProductTabs extends HTMLElement {
        connectedCallback(): void {
            const tabs = this.querySelectorAll<HTMLElement>('[data-tab]');
            tabs.forEach((tab) => {
                tab.addEventListener('click', () => {
                    const index = tab.dataset.tab;
                    if (index !== undefined) this.activate(index);
                });
            });
        }

        private activate(index: string): void {
            this.querySelectorAll<HTMLElement>('[data-tab]').forEach((tab) => {
                const active = tab.dataset.tab === index;
                tab.toggleAttribute('data-active', active);
                tab.setAttribute('aria-selected', String(active));
                tab.tabIndex = active ? 0 : -1;
            });

            this.querySelectorAll<HTMLElement>('[data-panel]').forEach(
                (panel) => {
                    const isActive = panel.dataset.panel === index;
                    panel.toggleAttribute('hidden', !isActive);
                    if (isActive) {
                        panel
                            .querySelectorAll<
                                HTMLElement & { refresh?: () => void }
                            >('splide-section')
                            .forEach((s) => s.refresh?.());
                    }
                },
            );

            this.querySelectorAll<HTMLElement>('[data-view-all]').forEach(
                (link) => {
                    link.toggleAttribute(
                        'hidden',
                        link.dataset.viewAll !== index,
                    );
                },
            );
        }
    },
);
