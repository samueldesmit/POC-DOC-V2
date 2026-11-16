import { customElement } from '../utilities/decorators';

/**
 * LocalizationForm component
 * Handles country and language selection in the localization form
 */
@customElement('localization-form')
export class LocalizationForm extends HTMLElement {
    connectedCallback() {
        const form = this.querySelector('form');
        if (!form) return;

        // Find country selector and language selector
        const countrySelector = form.querySelector(
            '#country_code',
        ) as HTMLSelectElement | null;
        const languageSelector = form.querySelector(
            '#language_code',
        ) as HTMLSelectElement | null;

        if (!countrySelector || !languageSelector) {
            console.error('Localization form: Required selectors not found');
            return;
        }

        // Add loading indicator if it exists
        const loading = this.querySelector('[data-loading]');

        // Add event listener to country selector
        countrySelector.addEventListener('change', () => {
            const selectedCountry = countrySelector.value;
            if (!selectedCountry) return;

            // Show loading indicator
            if (loading) {
                loading.setAttribute('data-active', '');
            }

            // Create a new FormData object with required fields
            const formData = new FormData();
            formData.append('form_type', 'localization');
            formData.append('utf8', '✓');
            formData.append('_method', 'put');
            formData.append('country_code', selectedCountry);

            const data = new URLSearchParams(formData as any);

            // Fetch updated language options based on selected country
            fetch(form.getAttribute('action') || '', {
                method: 'post',
                body: data,
            })
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(
                            `HTTP error! Status: ${response.status}`,
                        );
                    }
                    return response.text();
                })
                .then((htmlText) => {
                    // Create a DOM parser to parse the HTML response
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    // Find the new language selector in the response
                    let newLanguageSelector =
                        doc.querySelector('#language_code');

                    if (!newLanguageSelector) {
                        // Try alternative selectors if the primary one isn't found
                        newLanguageSelector = doc.querySelector(
                            'select[name="language_code"]',
                        );

                        if (!newLanguageSelector) {
                            // Last resort: try to find any form with localization
                            const localizationForm = doc.querySelector(
                                'form[action*="localization"]',
                            );
                            if (localizationForm) {
                                newLanguageSelector =
                                    localizationForm.querySelector(
                                        'select[id="language_code"], select[name="language_code"]',
                                    );
                            }
                        }

                        if (!newLanguageSelector) {
                            console.error(
                                'Could not find language selector in response',
                            );
                            if (loading) {
                                loading.removeAttribute('data-active');
                            }
                            return;
                        }
                    }

                    // Replace the language selector with the new one
                    const languageSelector = this.querySelector(
                        '#language_code',
                    ) as HTMLSelectElement | null;

                    if (languageSelector && newLanguageSelector) {
                        languageSelector.innerHTML =
                            newLanguageSelector.innerHTML;
                    }

                    // Update the visual labels
                    this.updateSelectLabels();

                    // Hide loading indicator
                    if (loading) {
                        loading.removeAttribute('data-active');
                    }

                    // Add event listener to the updated language selector
                    this.addLanguageSelectorEventListener();
                })
                .catch((error) => {
                    console.error('Error updating language options:', error);
                    if (loading) {
                        loading.removeAttribute('data-active');
                    }
                });
        });

        // Add event listener to language selector
        this.addLanguageSelectorEventListener();

        // Initialize labels on page load
        this.updateSelectLabels();
    }

    /**
     * Adds change event listener to the language selector
     */
    private addLanguageSelectorEventListener(): void {
        const languageSelector = this.querySelector(
            '#language_code',
        ) as HTMLSelectElement | null;

        if (!languageSelector) return;

        // Create a new event listener
        languageSelector.addEventListener('change', () => {
            this.updateLanguageLabel();
        });
    }

    /**
     * Updates the visual labels for both country and language selects
     */
    private updateSelectLabels(): void {
        this.updateCountryLabel();
        this.updateLanguageLabel();
    }

    /**
     * Updates the country select visual label with flag and text
     */
    private updateCountryLabel(): void {
        const countrySelect = this.querySelector(
            '#country_code',
        ) as HTMLSelectElement;
        if (!countrySelect) return;

        const selectedOption =
            countrySelect.options[countrySelect.selectedIndex];
        if (!selectedOption) return;

        const countryCode = selectedOption.value || '';
        const countryName =
            selectedOption.dataset.name || selectedOption.textContent || '';
        const labelElement = countrySelect
            .closest('.relative')
            ?.querySelector('[data-label] span');

        if (!labelElement) return;

        // Create container for flag and text
        const container = document.createElement('div');
        container.className = 'flex items-center gap-x-4';

        // Add flag image if country code is available
        if (countryCode) {
            const flagImg = document.createElement('img');
            flagImg.src = `//cdn.shopify.com/static/images/flags/${countryCode.toLowerCase()}.svg?width=20`;
            flagImg.className =
                ' object-cover size-5 border border-black';
            container.appendChild(flagImg);
        }

        // Add country name text without currency symbol
        const textNode = document.createTextNode(countryName);
        container.appendChild(textNode);

        // Update the label
        labelElement.innerHTML = '';
        labelElement.appendChild(container);
    }

    /**
     * Updates the language select visual label
     */
    private updateLanguageLabel(): void {
        const languageSelect = this.querySelector(
            '#language_code',
        ) as HTMLSelectElement;
        if (!languageSelect) return;

        const selectedOption =
            languageSelect.options[languageSelect.selectedIndex];
        if (!selectedOption) return;

        let languageLabel =
            selectedOption.dataset.name || selectedOption.textContent || '';

        // Capitalize the first letter of the language label
        if (languageLabel.length > 0) {
            languageLabel =
                languageLabel.charAt(0).toUpperCase() + languageLabel.slice(1);
        }

        const labelElement = languageSelect
            .closest('[data-select-container]')
            ?.querySelector('[data-label] span');

        if (labelElement) {
            labelElement.textContent = languageLabel;
        }
    }
}
