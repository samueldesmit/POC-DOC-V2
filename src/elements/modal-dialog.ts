import { subscribe, getTargets, publish } from '../global.js';
import { customElement } from 'lit/decorators.js';

// Simple body scroll lock that just toggles `data-modal-open` on <html>.
// CSS handles the rest (overflow:hidden, no scrollbar-width measurement,
// no body shifting). Reference-counted so nested/sibling modals don't
// release the lock prematurely.
let scrollLockCount = 0;
function disablePageScroll(): void {
    if (scrollLockCount === 0) {
        document.documentElement.setAttribute('data-modal-open', '');
    }
    scrollLockCount += 1;
}
function enablePageScroll(): void {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) {
        document.documentElement.removeAttribute('data-modal-open');
    }
}

interface ModalDialogEventDetail {
    open?: boolean;
    id?: string;
    trigger?: HTMLElement;
    instant?: boolean;
    current?: HTMLElement;
    previous?: HTMLElement;
}

interface ModalDialogHandlers {
    escapeKeydown?: (e: KeyboardEvent) => void;
}

@customElement('modal-dialog')
export class ModalDialog extends HTMLElement {
    private handlers: ModalDialogHandlers = {};
    private subscriptions: (() => void)[] = [];
    private trigger?: HTMLElement;
    private previous?: HTMLElement;

    connectedCallback(): void {
        // Portal to <body> so the modal's `position: fixed` is never trapped
        // by an ancestor with a transform (e.g. the hide-on-scroll header).
        if (this.parentElement && this.parentElement !== document.body) {
            // Sections that re-render — the PDP swaps its whole form on every
            // variant pick — hand us a fresh copy of a modal already parked in
            // <body>. Both would answer the same toggle, so the old one goes.
            const id = this.getAttribute('data-id');
            if (id) {
                document.body
                    .querySelectorAll(`:scope > modal-dialog[data-id="${id}"]`)
                    .forEach((existing) => existing.remove());
            }

            document.body.appendChild(this);
            return;
        }

        const { content: [content] = [] } = getTargets(this);
        const id = this.getAttribute('data-id');

        if (!content) {
            throw Error('Modal dialog has no content! Add a content target.');
        }

        const header = document.querySelector(
            '#main-header-nav',
        ) as HTMLElement;
        if (header) {
            document.body.style.setProperty(
                '--header-height',
                `${header.getBoundingClientRect().height}px`,
            );
        }

        this.handlers.escapeKeydown = (e: KeyboardEvent) => {
            if (
                e.key === 'Escape' &&
                this.hasAttribute('data-open') &&
                !this.hasAttribute('data-previous')
            ) {
                publish('modalToggle', { open: false, id: id });
            }
        };

        this.subscriptions = [
            subscribe(
                'modalToggle',
                ({
                    id: toggleId,
                    open = !this.hasAttribute('data-open'),
                    trigger,
                    instant = false,
                }: ModalDialogEventDetail) => {
                    if (
                        id === toggleId &&
                        open !== this.hasAttribute('data-open')
                    ) {
                        const elements = [
                            this,
                            ...Array.from(this.children),
                        ].filter(Boolean) as HTMLElement[];

                        if (open) {
                            this.toggleAttribute('data-open', true);

                            document.addEventListener(
                                'keydown',
                                this.handlers.escapeKeydown as EventListener,
                            );

                            this.trigger = trigger;

                            // Stay visible till leave transition is over
                            this.toggleAttribute('data-visible', true);
                            publish('modalDialogUpdate', {
                                open: true,
                                current: this,
                            });

                            this.trapFocus();
                            disablePageScroll();

                            // Attach previously opened modal
                            this.previous = document.querySelector(
                                `${this.tagName}[data-open]:not([data-previous]):not([data-id="${id}"])`,
                            );

                            if (this.previous) {
                                this.previous.toggleAttribute(
                                    'data-previous',
                                    true,
                                );

                                // Layer on top
                                this.style.zIndex = (
                                    parseInt(
                                        getComputedStyle(
                                            this.previous,
                                        ).getPropertyValue('z-index'),
                                    ) + 10
                                ).toString();
                            }

                            elements.forEach((e) => {
                                if (instant) {
                                    e.style.setProperty(
                                        'transition-duration',
                                        '0ms',
                                    );
                                    setTimeout(() =>
                                        e.style.removeProperty(
                                            'transition-duration',
                                        ),
                                    );
                                }

                                if (
                                    'toggle' in e &&
                                    typeof e.toggle === 'function'
                                ) {
                                    // Allow for JavaScript on open, like animations or focus
                                    e.toggle(true, instant);
                                }

                                e.toggleAttribute('data-open', true);
                            });
                        } else {
                            this.toggleAttribute('data-open', false);

                            document.removeEventListener(
                                'keydown',
                                this.handlers.escapeKeydown as EventListener,
                            );

                            elements.forEach((e) =>
                                e.toggleAttribute('data-leave', true),
                            );

                            if (this.previous) {
                                // Restore focus to previous
                                this.releaseFocus();
                                (this.previous as any).trapFocus();
                                this.previous.toggleAttribute(
                                    'data-previous',
                                    false,
                                );
                            } else {
                                this.releaseFocus(this.trigger);
                            }

                            const cleanupAfterClosing = () => {
                                elements.forEach((e) =>
                                    e.toggleAttribute('data-leave', false),
                                );

                                const open = this.hasAttribute('data-open');

                                this.toggleAttribute('data-visible', open);

                                if (!open) {
                                    this.style.removeProperty('z-index');
                                    enablePageScroll();

                                    if (!this.previous) {
                                        publish('modalDialogUpdate', {
                                            open: false,
                                            previous: this,
                                        });
                                    } else {
                                        publish('modalDialogUpdate', {
                                            open: true,
                                            current: this.previous,
                                        });
                                    }
                                }
                            };

                            if (instant) {
                                cleanupAfterClosing();
                            } else {
                                setTimeout(
                                    cleanupAfterClosing,
                                    parseInt(
                                        getComputedStyle(this).getPropertyValue(
                                            '--leave-duration',
                                        ),
                                    ),
                                );
                            }

                            elements.forEach((e) => {
                                if (instant) {
                                    e.style.setProperty(
                                        'transition-duration',
                                        '0ms',
                                    );
                                    setTimeout(() =>
                                        e.style.removeProperty(
                                            'transition-duration',
                                        ),
                                    );
                                }

                                if (
                                    'toggle' in e &&
                                    typeof e.toggle === 'function'
                                ) {
                                    // Allow for JavaScript on close, like animations
                                    e.toggle(false, instant).then(() =>
                                        e.toggleAttribute(
                                            'data-open',
                                            this.hasAttribute('data-open'),
                                        ),
                                    );
                                } else {
                                    e.toggleAttribute(
                                        'data-open',
                                        this.hasAttribute('data-open'),
                                    );
                                }
                            });
                        }
                    }
                },
            ),
        ];
    }

    private trapFocus(): void {
        const getFirstAndLastFocusableElements = () => {
            const focusableElements = this.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );

            return {
                first: focusableElements[0] as HTMLElement,
                last: focusableElements[
                    focusableElements.length - 1
                ] as HTMLElement,
            };
        };

        const { first } = getFirstAndLastFocusableElements();
        first?.focus();

        this.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Tab') {
                const { first, last } = getFirstAndLastFocusableElements();
                const { activeElement } = document;

                if (!e.shiftKey && activeElement === last) {
                    e.preventDefault();
                    first?.focus();
                }

                if (e.shiftKey && activeElement === first) {
                    e.preventDefault();
                    last?.focus();
                }
            }
        });
    }

    private releaseFocus(elementToFocus?: HTMLElement): void {
        if (elementToFocus) {
            elementToFocus.focus();
        }
    }

    disconnectedCallback(): void {
        this.subscriptions.forEach((unsubscribe) => unsubscribe());
        document.removeEventListener(
            'keydown',
            this.handlers.escapeKeydown as EventListener,
        );
    }
}
