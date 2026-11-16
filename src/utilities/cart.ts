interface CartItem {
    id: number;
    variant_id: number;
    quantity: number;
    title: string;
}

interface CartResponse {
    item_count: number;
    status?: number;
    description?: string;
    sections?: Record<string, string>;
    items?: CartItem[];
}

/**
 * Dispatches cart update event
 */
function dispatchCartEvent(
    cartData: CartResponse,
    source?: 'add-to-cart',
): void {
    document.dispatchEvent(
        new CustomEvent('cartUpdate', {
            bubbles: true,
            detail: {
                item_count: cartData.item_count,
                sections: cartData.sections,
                items: cartData.items,
                source,
            },
        }),
    );
}

/**
 * Updates UI sections after cart changes. Uses the section HTML that came
 * back with the cart request when there is one, so the drawer is not fetched
 * a second time.
 */
export async function handleCartUpdate(
    cartData: CartResponse,
    sectionId?: string,
    source?: 'add-to-cart',
): Promise<void> {
    dispatchCartEvent(cartData, source);

    if (!sectionId) return;

    const markup = cartData.sections?.[sectionId];
    if (markup) {
        applyCartSection(markup);
    } else {
        await refreshCartSection(sectionId);
    }
}

/**
 * Fetches the cart drawer section and swaps it in. Only needed when the cart
 * request did not ask for the section itself.
 */
export async function refreshCartSection(sectionId: string): Promise<void> {
    const sectionsResponse = await fetch(
        `${window.location.pathname}?sections=${sectionId}`,
    );

    if (!sectionsResponse.ok) {
        throw new Error('Failed to fetch updated cart content');
    }

    const sections = await sectionsResponse.json();
    applyCartSection(sections[sectionId]);
}

/**
 * Replaces the cart form with the one from the section HTML
 */
function applyCartSection(markup: string): void {
    const parser = new DOMParser();
    const doc = parser.parseFromString(markup, 'text/html');
    const newCartForm = doc.querySelector('cart-form');

    if (newCartForm) {
        const existingCartForm = document.querySelector('cart-form');
        if (existingCartForm) {
            existingCartForm.replaceWith(newCartForm);
        }
    }
}

/**
 * Updates the cart and refreshes the UI
 */
export async function updateCart(options: {
    url: string;
    method?: 'POST' | 'GET';
    body?: FormData | string;
    headers?: Record<string, string>;
    sectionId?: string;
    source?: 'add-to-cart';
}): Promise<CartResponse> {
    const {
        url,
        method = 'POST',
        body,
        headers = {},
        sectionId,
        source,
    } = options;

    const response = await fetch(url, {
        method,
        headers: {
            Accept: 'application/json',
            ...headers,
        },
        ...(body ? { body } : {}),
    });

    if (!response.ok) {
        throw new Error('Failed to update cart');
    }

    const cartData = (await response.json()) as CartResponse;

    // handleCartUpdate dispatches the event itself; dispatch it here only
    // when there is no section to refresh, so listeners run once per change.
    if (sectionId) {
        handleCartUpdate(cartData, sectionId, source).catch((error) => {
            console.error('Error updating UI:', error);
        });
    } else {
        dispatchCartEvent(cartData, source);
    }

    return cartData;
}
