import { getTargets } from '../global.js';

customElements.define(
    'quantity-input',
    class QuantityInput extends HTMLElement {
        connectedCallback(): void {
            const {
                input: [input],
                plus: [plus],
                minus: [minus],
                remove: [remove],
                value: [value],
            } = getTargets(this) as {
                input: HTMLInputElement[];
                plus: HTMLButtonElement[];
                minus: HTMLButtonElement[];
                remove: HTMLButtonElement[];
                value: HTMLElement[];
            };

            [minus, plus, remove].filter(Boolean).forEach((e) =>
                e.addEventListener('click', () => {
                    const previousValue = input.value;

                    switch (e) {
                        case plus:
                            input.stepUp();
                            break;
                        case minus:
                            input.stepDown();
                            break;
                        case remove:
                            input.value = '0';
                            break;
                    }

                    if (previousValue !== input.value)
                        // Trigger form change event
                        input.dispatchEvent(
                            new Event('change', { bubbles: true }),
                        );
                }),
            );

            input.addEventListener('change', () => {
                // Because we use 0 to remove the item from the cart, but don't want to display it
                if (parseInt(input.value) > 0) {
                    value.innerText = input.value;

                    if (input.min)
                        minus.toggleAttribute(
                            'disabled',
                            parseInt(input.value) <= parseInt(input.min),
                        );
                    if (input.max)
                        plus.toggleAttribute(
                            'disabled',
                            parseInt(input.value) >= parseInt(input.max),
                        );
                }
            });
        }
    },
);
