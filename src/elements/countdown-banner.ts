import { customElement } from '../utilities/decorators';

type CountdownUnit = 'days' | 'hours' | 'minutes' | 'seconds';

type CountdownElements = {
    value: HTMLElement;
    label: HTMLElement | null;
};

@customElement('countdown-banner')
export class CountdownBanner extends HTMLElement {
    private timerId?: number;
    private endTimestamp?: number;
    private units: Record<CountdownUnit, CountdownElements> | null = null;
    private container: HTMLElement | null = null;

    private initializeCountdown(): boolean {
        const endAttr = this.getAttribute('data-end')?.trim();
        if (!endAttr) return false;

        const endDate = new Date(endAttr);
        if (Number.isNaN(endDate.getTime())) return false;

        if (!this.units) return false;

        this.endTimestamp = endDate.getTime();

        this.show();
        this.tick();
        this.timerId = window.setInterval(() => this.tick(), 1000);

        return true;
    }

    private resolveUnits(): Record<CountdownUnit, CountdownElements> | null {
        const makeUnit = (unit: CountdownUnit): CountdownElements | null => {
            const value = this.querySelector<HTMLElement>(
                `[data-countdown-unit="${unit}"]`,
            );
            if (!value) return null;

            const label = this.querySelector<HTMLElement>(
                `[data-countdown-label="${unit}"]`,
            );

            return { value, label };
        };

        const days = makeUnit('days');
        const hours = makeUnit('hours');
        const minutes = makeUnit('minutes');
        const seconds = makeUnit('seconds');

        if (!days || !hours || !minutes || !seconds) return null;

        return { days, hours, minutes, seconds };
    }

    private tick(): void {
        if (!this.endTimestamp || !this.units) return;

        const diff = this.endTimestamp - Date.now();

        if (diff <= 0) {
            this.clearTimer();
            this.hide();
            return;
        }

        const totalSeconds = Math.floor(diff / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        this.units.days.value.textContent = `${days}`;
        this.units.hours.value.textContent = this.pad(hours);
        this.units.minutes.value.textContent = this.pad(minutes);
        this.units.seconds.value.textContent = this.pad(seconds);

        this.updateLabel('days', days);
        this.updateLabel('hours', hours);
        this.updateLabel('minutes', minutes);
        this.updateLabel('seconds', seconds);
    }

    private clearTimer(): void {
        if (this.timerId) {
            window.clearInterval(this.timerId);
            this.timerId = undefined;
        }
    }

    private updateLabel(unit: CountdownUnit, value: number): void {
        const label = this.units?.[unit]?.label;
        if (!label) return;

        const singular = label.dataset.labelSingular?.trim();
        const plural = label.dataset.labelPlural?.trim();
        const fallback = label.textContent || '';

        const next =
            value === 1
                ? singular || plural || fallback
                : plural || singular || fallback;

        label.textContent = next;
    }

    private hide(): void {
        const target = this.container ?? this;
        target.setAttribute('hidden', '');
        target.setAttribute('aria-hidden', 'true');
    }

    private show(): void {
        const target = this.container ?? this;
        target.removeAttribute('hidden');
        target.removeAttribute('aria-hidden');
    }

    private pad(value: number): string {
        return value < 10 ? `0${value}` : `${value}`;
    }

    connectedCallback(): void {
        this.container =
            this.closest<HTMLElement>('[data-countdown-container]') ?? null;

        this.clearTimer();
        this.units = this.resolveUnits();

        const isInitialised = this.initializeCountdown();
        if (!isInitialised) {
            this.hide();
        }
    }

    disconnectedCallback(): void {
        this.clearTimer();
    }
}
