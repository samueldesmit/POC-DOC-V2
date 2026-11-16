import { subscribe, getTargets, publish, debounce } from './../global.js';

interface ProductsUpdateEvent {
    sections: {
        [key: string]: string;
    };
}

interface ModalToggleEvent {
    id?: string;
    open?: boolean;
}

// Create a type-safe debounce wrapper for TypeScript
function typeSafeDebounce<T extends (...args: any[]) => any>(
    fn: T,
    wait: number,
): (...args: Parameters<T>) => void {
    return debounce(fn, wait) as (...args: Parameters<T>) => void;
}

class FiltersForm extends HTMLElement {
    private unsubscribe?: () => void;

    connectedCallback(): void {
        const isMobile: boolean = this.hasAttribute('data-mobile');
        const clearWholeFilterButtonContainers: NodeListOf<HTMLElement> =
            this.querySelectorAll('.clear-whole-filter-container');

        const {
            'clear-all': clearAll = [],
            'active-filters': [activeFilters] = [],
            'show-results': showResults = [],
        } = getTargets(this);

        const sectionId: string | null =
            this.closest('product-collection')?.getAttribute(
                'data-section-id',
            ) || null;

        if (!sectionId) return;

        // Helper function to toggle loading state UI and publish loading state to other components
        const toggleLoadingState = (isLoading: boolean): void => {
            // Publish loading state change to product-grid
            publish('filterChange', isLoading);

            // Set data attribute for self
            this.toggleAttribute('data-loading', isLoading);
        };

        this.unsubscribe = subscribe(
            'productsUpdate',
            ({ sections }: ProductsUpdateEvent) => {
                const section = sections[sectionId];

                if (section) {
                    const newFiltersForm = new DOMParser()
                        .parseFromString(section, 'text/html')
                        .querySelector(
                            `${this.tagName.toLowerCase()}[data-${isMobile ? 'mobile' : 'desktop'}]`,
                        ) as HTMLElement | null;

                    if (!newFiltersForm) return;

                    if (isMobile) {
                        const {
                            'show-results': showResultsElements = [],
                            'filer-active-values': filerActiveValues = [],
                            'clear-whole-filter': clearWholeFilter = [],
                            'products-count-mobile': [productsCountMobile] = [],
                        } = getTargets(this);

                        const {
                            'show-results': newShowResults = [],
                            'filer-active-values': newFilerActiveValues = [],
                            'clear-whole-filter': newClearWholeFilter = [],
                            'products-count-mobile': [
                                newProductsCountMobile,
                            ] = [],
                        } = getTargets(newFiltersForm);

                        // Update products count in mobile filter header
                        if (productsCountMobile && newProductsCountMobile) {
                            productsCountMobile.replaceWith(
                                newProductsCountMobile,
                            );
                        }

                        // // Update off-canvas show results button
                        // showResultsElements.forEach((showResultsEle, i) => {
                        //     // Re-attach the event listener after replacement
                        //     const newButton = newShowResults[i];
                        //     showResultsEle.replaceWith(newButton);
                        //     newButton.addEventListener(
                        //         'click',
                        //         handleShowResults.bind(this),
                        //     );
                        // });
                        filerActiveValues.forEach((showResultsEle, i) => {
                            if (newFilerActiveValues[i]) {
                                showResultsEle.replaceWith(
                                    newFilerActiveValues[i],
                                );
                            }
                        });
                        clearWholeFilter.forEach((element, i) => {
                            if (newClearWholeFilter[i]) {
                                element.replaceWith(newClearWholeFilter[i]);
                            }
                        });
                    } else {
                        const {
                            title: [title] = [],
                            'filter-title': filterTitles = [],
                            header: [header] = [],
                        } = getTargets(this);
                        const {
                            title: [newTitle] = [],
                            'filter-title': newFilterTitles = [],
                            header: [newHeader] = [],
                        } = getTargets(newFiltersForm);

                        // Update total count
                        if (title && newTitle) {
                            title.replaceWith(newTitle);
                        }

                        // Update filter counts
                        filterTitles.forEach((input, i) => {
                            if (newFilterTitles[i]) {
                                input.replaceWith(newFilterTitles[i]);
                            }
                        });

                        if (header && newHeader) {
                            header.toggleAttribute(
                                'data-disabled',
                                newHeader.hasAttribute('data-disabled'),
                            );
                        }
                    }

                    const {
                        input: inputs = [],
                        'active-filters': [activeFilters] = [],
                        'price-range-inputs': [priceRangeInputs] = [],
                    } = getTargets(this);

                    const {
                        input: newInputs = [],
                        'clear-all': newClearAll = [],
                        'active-filters': [newActiveFilters] = [],
                        'price-range-inputs': [newPriceRangeInputs] = [],
                    } = getTargets(newFiltersForm);

                    // Update active filters
                    if (activeFilters && newActiveFilters) {
                        const activeFiltersInner = activeFilters.querySelector(
                            '.active-filters-inner',
                        );
                        const newActiveFiltersInner =
                            newActiveFilters.querySelector(
                                '.active-filters-inner',
                            );
                        if (activeFiltersInner && newActiveFiltersInner) {
                            activeFiltersInner.replaceWith(
                                newActiveFiltersInner,
                            );
                        }

                        activeFilters.toggleAttribute(
                            'data-disabled',
                            newActiveFilters.hasAttribute('data-disabled'),
                        );
                    }

                    // Update price range inputs
                    if (priceRangeInputs && newPriceRangeInputs) {
                        priceRangeInputs.replaceWith(newPriceRangeInputs);
                    }

                    // Update inputs states
                    inputs.forEach((input, i) => {
                        if (newInputs[i]) {
                            input.replaceWith(newInputs[i]);
                        }
                    });

                    clearAll.forEach((clearAllSingle, i) => {
                        if (newClearAll[i]) {
                            clearAllSingle.toggleAttribute(
                                'data-disabled',
                                newClearAll[i].hasAttribute('data-disabled'),
                            );
                        }
                    });

                    // Update product-count (it's in the parent product-collection element)
                    const productCollection =
                        this.closest('product-collection');
                    if (productCollection) {
                        const newProductCollection = new DOMParser()
                            .parseFromString(section, 'text/html')
                            .querySelector('product-collection');

                        if (newProductCollection) {
                            const productCount =
                                productCollection.querySelector(
                                    'product-count',
                                );
                            const newProductCount =
                                newProductCollection.querySelector(
                                    'product-count',
                                );
                            if (productCount && newProductCount) {
                                productCount.replaceWith(newProductCount);
                            }
                        }
                    }
                }

                // Hide loading state
                toggleLoadingState(false);
            },
        );

        async function handleInput(this: FiltersForm, e: Event): Promise<void> {
            e.preventDefault();

            // Show loading state
            toggleLoadingState(true);

            // Get current search parameters from URL
            const currentSearchParams = new URLSearchParams(
                window.location.search,
            );
            const currentSearchQuery = currentSearchParams.get('q');

            // Get filter form data
            const filterForm = (e.target as HTMLInputElement).form;
            let filterParams = '';
            if (filterForm) {
                const formData = new FormData(filterForm);
                const cleanedFormData = new FormData();

                // Only include non-empty values
                for (const [key, value] of formData.entries()) {
                    if (value !== '') {
                        cleanedFormData.append(key, value);
                    }
                }

                filterParams = new URLSearchParams(
                    cleanedFormData as unknown as Record<string, string>,
                ).toString();
            }

            // Get sort parameters if any
            const sortForm = document.querySelector(
                'sort-form form',
            ) as HTMLFormElement | null;
            let sortParams = '';
            if (sortForm) {
                const formData = new FormData(sortForm);
                const cleanedFormData = new FormData();

                // Only include non-empty values
                for (const [key, value] of formData.entries()) {
                    if (value !== '') {
                        cleanedFormData.append(key, value);
                    }
                }

                sortParams = new URLSearchParams(
                    cleanedFormData as unknown as Record<string, string>,
                ).toString();
            }

            // Construct the URL with search query first if it exists
            let finalUrl = window.location.pathname;
            if (currentSearchQuery) {
                finalUrl += `?q=${encodeURIComponent(currentSearchQuery)}`;

                // Add filter parameters
                if (filterParams) {
                    finalUrl += `&${filterParams}`;
                }

                // Add sort parameters
                if (sortParams) {
                    finalUrl += `&${sortParams}`;
                }
            } else {
                // No search query, just add filter and sort params
                if (filterParams) {
                    finalUrl += `?${filterParams}`;
                }

                if (sortParams) {
                    finalUrl += finalUrl.includes('?')
                        ? `&${sortParams}`
                        : `?${sortParams}`;
                }
            }

            try {
                const sections = await fetch(
                    `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}sections=${sectionId}`,
                ).then((r) => r.json());

                publish('productsUpdate', { sections });

                // Update URL in browser
                window.history.pushState(
                    { searchQuery: currentSearchQuery },
                    '',
                    finalUrl,
                );
            } catch (error) {
                console.error('Error updating products or URL:', error);
            }
        }

        // Create a type-safe debounced version of handleInput
        const debouncedHandleInput = typeSafeDebounce(
            function (this: FiltersForm, e: Event): void {
                handleInput.call(this, e);
            }.bind(this),
            500,
        );

        function handleRangeInput(this: FiltersForm, e: Event): void {
            const currentInput = e.target as HTMLInputElement;
            const priceMinNumberInput = this.querySelector(
                '[id="filter-filter.v.price.gte"]',
            ) as HTMLInputElement | null;
            const priceMaxNumberInput = this.querySelector(
                '[id="filter-filter.v.price.lte"]',
            ) as HTMLInputElement | null;
            const priceMinRangeInput = this.querySelector(
                '.range-input .range-min',
            ) as HTMLInputElement | null;
            const priceMaxRangeInput = this.querySelector(
                '.range-input .range-max',
            ) as HTMLInputElement | null;

            if (
                (!priceMinRangeInput && !priceMinNumberInput) ||
                (!priceMaxRangeInput && !priceMaxNumberInput)
            )
                return;

            if (currentInput === priceMinRangeInput && priceMaxNumberInput) {
                if (
                    parseInt(currentInput.value) >
                    parseInt(priceMaxNumberInput.value)
                ) {
                    if (priceMinNumberInput) {
                        priceMinNumberInput.value = priceMaxNumberInput.value;
                    }
                    currentInput.value = priceMaxNumberInput.value;
                } else if (priceMinNumberInput) {
                    priceMinNumberInput.value = currentInput.value;
                }
            } else if (
                currentInput === priceMaxRangeInput &&
                priceMinNumberInput
            ) {
                if (
                    parseInt(currentInput.value) <
                    parseInt(priceMinNumberInput.value)
                ) {
                    if (priceMaxNumberInput) {
                        priceMaxNumberInput.value = priceMinNumberInput.value;
                    }
                    currentInput.value = priceMinNumberInput.value;
                } else if (priceMaxNumberInput) {
                    priceMaxNumberInput.value = currentInput.value;
                }
            }

            debouncedHandleInput(e);
        }

        const form = this.querySelector('form');
        if (form) {
            form.addEventListener('input', async (e: Event) => {
                const target = e.target as HTMLInputElement;
                const targetType = target.type;

                if (targetType === 'number') {
                    debouncedHandleInput(e);
                } else if (targetType === 'range') {
                    handleRangeInput.call(this, e);
                } else {
                    handleInput.call(this, e);
                }
            });
        }

        async function handleActiveFilters(
            this: FiltersForm,
            filterElement: HTMLElement,
            event: Event,
        ): Promise<void> {
            event.preventDefault();

            // Show loading state
            toggleLoadingState(true);

            const filterUrl = filterElement.getAttribute('href');
            if (!filterUrl) return;

            // Get current search parameters from URL
            const currentSearchParams = new URLSearchParams(
                window.location.search,
            );
            const currentSearchQuery = currentSearchParams.get('q');

            // Parse the filter URL
            try {
                const filterUrlObj = new URL(filterUrl, window.location.origin);
                const filterSearchParams = filterUrlObj.searchParams;

                // Clean up empty parameters
                const cleanedParams = new URLSearchParams();
                filterSearchParams.forEach((value, key) => {
                    if (value !== '') {
                        cleanedParams.append(key, value);
                    }
                });

                // If we have a search query in the current URL, make sure it's preserved
                if (currentSearchQuery) {
                    // Create a new URL starting with the search query
                    let finalUrl = `${filterUrlObj.pathname}?q=${encodeURIComponent(currentSearchQuery)}`;

                    // Add all filter parameters except 'q'
                    cleanedParams.forEach((value, key) => {
                        if (key !== 'q') {
                            finalUrl += `&${key}=${value}`;
                        }
                    });

                    const sections = await fetch(
                        `${finalUrl}&sections=${sectionId}`,
                    ).then((r) => r.json());

                    publish('productsUpdate', { sections });

                    // Update URL in browser
                    window.history.pushState(
                        { searchQuery: currentSearchQuery },
                        '',
                        finalUrl,
                    );
                } else {
                    // No search query, construct a clean URL with non-empty parameters
                    let finalUrl = filterUrlObj.pathname;
                    const cleanedParamsString = cleanedParams.toString();

                    if (cleanedParamsString) {
                        finalUrl += `?${cleanedParamsString}`;
                    }

                    const sections = await fetch(
                        `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}sections=${sectionId}`,
                    ).then((r) => r.json());

                    publish('productsUpdate', { sections });

                    // Update URL in browser
                    window.history.pushState({}, '', finalUrl);
                }
            } catch (error) {
                console.error('Error processing URL:', error);

                // Fallback to original behavior
                const sections = await fetch(
                    `${filterUrl}&sections=${sectionId}`,
                ).then((r) => r.json());

                publish('productsUpdate', { sections });
                window.history.pushState({}, '', filterUrl);
            }
        }

        // Wrapper function to handle click events for active filters
        const handleActiveFilterClick = (event: MouseEvent): void => {
            const filterElement = (event.target as HTMLElement).closest(
                '.active-filter',
            );
            if (filterElement) {
                handleActiveFilters.call(this, filterElement, event);
            }
        };

        // Wrapper function to handle click events for clear whole filter
        const handleClearWholeFilterClick = (event: MouseEvent): void => {
            const filterElement = (event.target as HTMLElement).closest(
                '.clear-whole-filter',
            );
            if (filterElement) {
                handleActiveFilters.call(this, filterElement, event);
            }
        };

        if (activeFilters) {
            activeFilters.addEventListener('click', handleActiveFilterClick);
        }

        if (clearWholeFilterButtonContainers.length > 0) {
            clearWholeFilterButtonContainers.forEach((container) => {
                container.addEventListener(
                    'click',
                    handleClearWholeFilterClick,
                );
            });
        }

        clearAll.forEach((clearAllSingle) =>
            clearAllSingle.addEventListener('click', async (e: MouseEvent) => {
                e.preventDefault();

                // Show loading state
                toggleLoadingState(true);

                // Get current search parameters from URL
                const currentSearchParams = new URLSearchParams(
                    window.location.search,
                );
                const currentSearchQuery = currentSearchParams.get('q');

                // Construct base URL with search query if it exists
                let finalUrl = window.location.pathname;
                if (currentSearchQuery) {
                    finalUrl += `?q=${encodeURIComponent(currentSearchQuery)}`;
                }

                // Get sort parameters if any
                const sortForm = document.querySelector(
                    'sort-form form',
                ) as HTMLFormElement | null;
                let sortParams = '';
                if (sortForm) {
                    const formData = new FormData(sortForm);
                    const cleanedFormData = new FormData();

                    // Only include non-empty values
                    for (const [key, value] of formData.entries()) {
                        if (value !== '') {
                            cleanedFormData.append(key, value);
                        }
                    }

                    sortParams = new URLSearchParams(
                        cleanedFormData as unknown as Record<string, string>,
                    ).toString();
                }

                // Add sort parameters to URL if they exist
                if (sortParams && sortParams.length > 0) {
                    finalUrl += finalUrl.includes('?')
                        ? `&${sortParams}`
                        : `?${sortParams}`;
                }

                try {
                    const sections = await fetch(
                        `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}sections=${sectionId}`,
                    ).then((r) => r.json());

                    publish('productsUpdate', { sections });

                    // Update URL in browser
                    window.history.pushState(
                        { searchQuery: currentSearchQuery },
                        '',
                        finalUrl,
                    );
                } catch (error) {
                    console.error('Error updating products or URL:', error);
                }
            }),
        );

        async function handleShowResults(
            this: FiltersForm,
            e: MouseEvent,
        ): Promise<void> {
            e.preventDefault();
            e.stopPropagation(); // Prevent event from reaching the parent modal-toggle

            // Apply any pending changes on form submit
            const form = this.querySelector('form');
            if (form) {
                // Get current search parameters from URL
                const currentSearchParams = new URLSearchParams(
                    window.location.search,
                );
                const currentSearchQuery = currentSearchParams.get('q');

                // Start with filter form data
                const filterFormData = new FormData(form);
                const cleanedFilterData = new FormData();

                // Only include non-empty values
                for (const [key, value] of filterFormData.entries()) {
                    if (value !== '') {
                        cleanedFilterData.append(key, value);
                    }
                }

                const filterParams = new URLSearchParams(
                    cleanedFilterData as unknown as Record<string, string>,
                ).toString();

                // Get sort parameters if any
                const sortForm = document.querySelector(
                    'sort-form form',
                ) as HTMLFormElement | null;
                let sortParams = '';
                if (sortForm) {
                    const sortFormData = new FormData(sortForm);
                    const cleanedSortData = new FormData();

                    // Only include non-empty values
                    for (const [key, value] of sortFormData.entries()) {
                        if (value !== '') {
                            cleanedSortData.append(key, value);
                        }
                    }

                    sortParams = new URLSearchParams(
                        cleanedSortData as unknown as Record<string, string>,
                    ).toString();
                }

                // Construct the URL with search query first if it exists
                let finalUrl = window.location.pathname;
                if (currentSearchQuery) {
                    finalUrl += `?q=${encodeURIComponent(currentSearchQuery)}`;

                    // Add filter parameters
                    if (filterParams) {
                        finalUrl += `&${filterParams}`;
                    }

                    // Add sort parameters
                    if (sortParams) {
                        finalUrl += `&${sortParams}`;
                    }
                } else {
                    // No search query, just add filter and sort params
                    if (filterParams) {
                        finalUrl += `?${filterParams}`;
                    }

                    if (sortParams) {
                        finalUrl += finalUrl.includes('?')
                            ? `&${sortParams}`
                            : `?${sortParams}`;
                    }
                }

                try {
                    const sections = await fetch(
                        `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}sections=${sectionId}`,
                    ).then((r) => r.json());

                    publish('productsUpdate', { sections });

                    // Update URL in browser
                    window.history.pushState(
                        { searchQuery: currentSearchQuery },
                        '',
                        finalUrl,
                    );

                    // After applying filters, close the drawer by manually triggering modal toggle
                    publish('modalToggle', {
                        id: 'off-canvas-filters',
                        open: false,
                    } as ModalToggleEvent);
                } catch (error) {
                    console.error('Error updating products or URL:', error);
                }
            }
        }

        // Add event listeners to all show-results buttons
        if (showResults.length > 0) {
            showResults.forEach((showResultsBtn) => {
                showResultsBtn.addEventListener(
                    'click',
                    handleShowResults.bind(this),
                );
            });
        }
    }

    disconnectedCallback(): void {
        if (this.unsubscribe) this.unsubscribe();
    }
}

customElements.define('filters-form', FiltersForm);
