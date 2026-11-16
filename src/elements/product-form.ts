import { customElement } from '../utilities/decorators';

interface ProductVariant {
    id: string | number;
    options: string[];
    available: boolean;
}

@customElement('product-form')
export class PDPDetailsBox extends HTMLElement {
    private productUrl = this.dataset.url;
    private sectionId = this.dataset.section;
    private boundHandleOptionsChange: (event: Event) => void;

    constructor() {
        super();
        this.boundHandleOptionsChange = this.handleOptionsChange.bind(this);
    }

    get options(): HTMLElement {
        return this.querySelector('[data-options]');
    }

    connectedCallback(): void {
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Remove existing listener if any
        this.options?.removeEventListener(
            'change',
            this.boundHandleOptionsChange,
        );
        // Add new listener
        this.options?.addEventListener('change', this.boundHandleOptionsChange);
    }

    private handleOptionsChange(): void {
        this.setOptionsLoadingState(true);
        const pickedVariant = this.productGetPickedVariant();

        // No variant exists for this option combination
        if (!pickedVariant) {
            this.setUnavailableState();
            this.setOptionsLoadingState(false);
            return;
        }

        this.updateElements(pickedVariant);
        this.updateUrl(pickedVariant.id);

        this.dispatchOptionChangeEvent();
    }

    private productGetPickedVariant(): ProductVariant | undefined {
        const optionsContainer = this.options as HTMLElement;
        const allVariants = this.getAllProductVariantsJSON();
        const checkedOptionsArray: string[] = [];

        optionsContainer
            .querySelectorAll('input:checked')
            .forEach((option: HTMLInputElement) => {
                checkedOptionsArray.push(option.value);
            });
        const pickedVariantData = allVariants.find(
            (variant: ProductVariant) => {
                const optionsComparisonArray: boolean[] = [];
                for (const [index, option] of variant.options.entries()) {
                    optionsComparisonArray.push(
                        checkedOptionsArray[index] === option,
                    );
                }
                return !optionsComparisonArray.includes(false);
            },
        );
        return pickedVariantData;
    }

    private getAllProductVariantsJSON(): ProductVariant[] {
        // Match the variant data explicitly: apps and JSON-LD may place other
        // <script> tags inside the form.
        const script = this.querySelector('script[type="application/json"]');
        if (!script?.textContent) return [];

        try {
            return JSON.parse(script.textContent) as ProductVariant[];
        } catch {
            return [];
        }
    }

    private updateUrl(variantID: string | number): void {
        window.history.replaceState(
            {},
            '',
            `${this.productUrl}?variant=${variantID}`,
        );
    }
    private createFetchUrl(variantID: string | number): string {
        return `${this.productUrl}?variant=${variantID}&section_id=${this.sectionId}`;
    }

    private async updateElements(pickedVariant: ProductVariant) {
        const url = this.createFetchUrl(pickedVariant.id);
        const htmlText = await this.fetchShopifySection(url);
        const htmlToRender = new DOMParser().parseFromString(
            htmlText,
            'text/html',
        );

        // Find the main product form container in the new HTML
        const newProductForm = htmlToRender.querySelector('product-form');

        if (newProductForm) {
            // Replace the entire product form content
            this.innerHTML = newProductForm.innerHTML;

            // Reattach event listeners after content update
            this.setupEventListeners();
        }

        this.setOptionsLoadingState(false);
    }

    // The hidden id input still holds the previously picked variant, so the
    // add to cart buttons are disabled to keep it from being added instead.
    // The next valid pick re-renders the form and restores them.
    private setUnavailableState(): void {
        this.querySelectorAll<HTMLButtonElement>('[data-atc-button]').forEach(
            (button) => {
                button.disabled = true;

                const label = button.dataset.labelUnavailable;
                if (!label) return;

                const labelElement = button.querySelector('span') ?? button;
                labelElement.textContent = label;
            },
        );
    }

    private setOptionsLoadingState(isLoading: boolean = false): void {
        this.toggleAttribute('data-loading', isLoading);

        if (this.options === null) return;

        isLoading
            ? this.options.setAttribute('data-loading', '')
            : this.options.removeAttribute('data-loading');
    }

    private async fetchShopifySection(url: string): Promise<string> {
        const response = await fetch(url);
        const responseText = await response.text();

        return responseText;
    }

    private dispatchOptionChangeEvent(): void {
        const event = new CustomEvent('options:changed', {
            bubbles: true,
            composed: true,
        });
        this.dispatchEvent(event);
    }

    disconnectedCallback(): void {
        this.options?.removeEventListener(
            'change',
            this.boundHandleOptionsChange,
        );
    }
}
