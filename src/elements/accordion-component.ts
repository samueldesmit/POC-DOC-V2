import { customElement } from '../utilities/decorators';
import { getTargets } from '../global.js';

interface AccordionTargets {
    button: HTMLButtonElement[];
}

@customElement('accordion-component')
export class AccordionComponent extends HTMLElement {
    private button: HTMLElement | null = null;

    // connectedCallback runs again whenever the element is moved, e.g. when
    // a modal-dialog portals itself to <body>. The handler is removed on
    // disconnect so a move does not leave two listeners that cancel out.
    private handleClick = (): void => {
        const button = this.button;
        if (!button) return;

        const isExpanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', (!isExpanded).toString());

        // close others in group
        const group = this.getAttribute('data-group');
        if (group) {
            const groupSelector = `accordion-component[data-group="${group}"]`;
            const groupAccordions = Array.from(
                document.querySelectorAll<AccordionComponent>(groupSelector),
            );

            groupAccordions
                .filter((accordion) => accordion !== this)
                .forEach((accordion) => {
                    const { button: [groupButton] = [] } =
                        getTargets<AccordionTargets>(accordion);
                    if (groupButton) {
                        groupButton.setAttribute('aria-expanded', 'false');
                    }
                });
        }
    };

    connectedCallback(): void {
        const { button: [button] = [] } = getTargets<AccordionTargets>(this);
        if (!button) return;

        this.button = button;
        button.addEventListener('click', this.handleClick);
    }

    disconnectedCallback(): void {
        this.button?.removeEventListener('click', this.handleClick);
        this.button = null;
    }
}
