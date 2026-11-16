import { customElement } from '../utilities/decorators';

@customElement('hotspots-pins')
export class HotspotsPins extends HTMLElement {
    private pins: HTMLElement[] = [];
    private wrappers: HTMLElement[] = [];
    private activeWrapper: HTMLElement | null = null;
    private readonly handlePinClick = (event: Event): void => {
        event.stopPropagation();
        const pin = event.currentTarget as HTMLElement | null;
        if (!pin) return;

        const wrapper = pin.closest<HTMLElement>('[data-hotspot-wrapper]');
        if (!wrapper) return;

        if (this.activeWrapper === wrapper) {
            this.clearActiveState();
            return;
        }

        this.clearActiveState();
        wrapper.setAttribute('data-active', 'true');
        this.activeWrapper = wrapper;
    };

    private readonly handleOutsideClick = (event: Event): void => {
        const target = event.target as HTMLElement | null;

        if (!target?.closest('[data-hotspot-wrapper], [data-hotspot-bubble]')) {
            this.clearActiveState();
        }
    };

    private clearActiveState(): void {
        this.wrappers.forEach((wrapper) =>
            wrapper.setAttribute('data-active', 'false'),
        );
        this.activeWrapper = null;
    }

    connectedCallback(): void {
        this.wrappers = Array.from(
            this.querySelectorAll<HTMLElement>('[data-hotspot-wrapper]'),
        );
        this.pins = this.wrappers
            .map((wrapper) =>
                wrapper.querySelector<HTMLButtonElement>(
                    '[data-hotspot-button]',
                ),
            )
            .filter(
                (pin): pin is HTMLButtonElement =>
                    pin instanceof HTMLButtonElement,
            );

        this.pins.forEach((pin) =>
            pin.addEventListener('click', this.handlePinClick),
        );
        document.addEventListener('click', this.handleOutsideClick);
    }

    disconnectedCallback(): void {
        this.pins.forEach((pin) =>
            pin.removeEventListener('click', this.handlePinClick),
        );
        document.removeEventListener('click', this.handleOutsideClick);
    }
}
