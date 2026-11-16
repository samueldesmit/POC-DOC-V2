import { publish } from '../global.js';
import { customElement } from '../utilities/decorators';

/**
 * Interface for mega menu item elements
 */
interface MegaMenuItemElement extends HTMLElement {
    toggle: (open: boolean, instant?: boolean) => Promise<void>;
}

/**
 * Configuration constants for the mega menu
 */
const MEGA_MENU_CONFIG = {
    SELECTORS: {
        DROPDOWN_ITEMS: 'mega-menu-item[data-dropdown]',
        ALL_MENU_ITEMS: 'mega-menu-item',
        NON_DROPDOWN_ITEMS: 'mega-menu-item:not([data-dropdown])',
        OPEN_DROPDOWN: 'mega-menu-item[data-dropdown][data-open]',
        CLOSE_BUTTON: '[data-close-menu]',
        MAIN_HEADER: '#main-header-nav',
        MEGA_MENU: '#mega-menu',
    },
    CSS_VARIABLES: {
        HEADER_HEIGHT: '--header-height',
        MEGA_MENU_HEIGHT: '--mega-menu-height',
    },
    EVENTS: {
        MEGA_MENU_TOGGLED: 'megaMenuToggled',
    },
    TIMING: {
        HOVER_DELAY: 150, // ms delay before closing submenu
    },
} as const;

/**
 * Custom element for handling mega menu functionality
 * Provides dropdown navigation with smooth transitions and accessibility features
 */
@customElement('mega-menu')
export class MegaMenu extends HTMLElement {
    private eventListeners: Array<{
        element: EventTarget;
        event: string;
        handler: EventListener;
    }> = [];
    private hoverTimeout: number | null = null;

    connectedCallback(): void {
        this.initializeHeaderHeight();
        this.setupEventListeners();
    }

    /**
     * Initialize CSS custom properties for header and mega menu heights
     */
    private initializeHeaderHeight(): void {
        try {
            const mainHeader = document.querySelector<HTMLElement>(
                MEGA_MENU_CONFIG.SELECTORS.MAIN_HEADER,
            );
            if (mainHeader) {
                const height = mainHeader.getBoundingClientRect().height;
                document.body.style.setProperty(
                    MEGA_MENU_CONFIG.CSS_VARIABLES.HEADER_HEIGHT,
                    `${height}px`,
                );
            }

            const megaMenu = document.querySelector<HTMLElement>(
                MEGA_MENU_CONFIG.SELECTORS.MEGA_MENU,
            );
            if (megaMenu) {
                const height = megaMenu.getBoundingClientRect().height;
                document.body.style.setProperty(
                    MEGA_MENU_CONFIG.CSS_VARIABLES.MEGA_MENU_HEIGHT,
                    `${height}px`,
                );
            }
        } catch (error) {
            console.warn('Failed to initialize header height:', error);
        }
    }

    /**
     * Toggle dropdown state for a specific menu item
     * @param item - The menu item to toggle
     * @param open - Whether to open or close the dropdown
     */
    private async toggleDropdown(
        item: HTMLElement,
        open = true,
    ): Promise<void> {
        if (!item) {
            console.warn('toggleDropdown called with null/undefined item');
            return;
        }

        try {
            const currentlyOpen = this.querySelector<MegaMenuItemElement>(
                MEGA_MENU_CONFIG.SELECTORS.OPEN_DROPDOWN,
            );

            // If we're opening a dropdown and one is already open, just switch content
            if (open && currentlyOpen && currentlyOpen !== item) {
                await this.switchDropdownContent(
                    currentlyOpen,
                    item as MegaMenuItemElement,
                );
                return;
            }

            // Normal behavior for opening/closing
            this.updateMenuState(open);
            await this.handleNormalToggle(item as MegaMenuItemElement, open);

            publish(MEGA_MENU_CONFIG.EVENTS.MEGA_MENU_TOGGLED, { open });
        } catch (error) {
            console.error('Error toggling dropdown:', error);
        }
    }

    /**
     * Switch between dropdown contents without closing the container
     */
    private async switchDropdownContent(
        currentItem: MegaMenuItemElement,
        newItem: MegaMenuItemElement,
    ): Promise<void> {
        try {
            // Close the currently open item without animation
            await currentItem.toggle(false, true);
            // Open the new item without animation
            await newItem.toggle(true, true);
        } catch (error) {
            console.error('Error switching dropdown content:', error);
        }
    }

    /**
     * Handle normal toggle behavior for dropdown items
     */
    private async handleNormalToggle(
        item: MegaMenuItemElement,
        open: boolean,
    ): Promise<void> {
        const allItems = this.querySelectorAll<MegaMenuItemElement>(
            MEGA_MENU_CONFIG.SELECTORS.DROPDOWN_ITEMS,
        );

        for (const menuItem of allItems) {
            try {
                await menuItem.toggle(
                    menuItem === item && open,
                    menuItem !== item,
                );
            } catch (error) {
                console.error('Error toggling menu item:', error);
            }
        }
    }

    /**
     * Update the mega menu's open state
     */
    private updateMenuState(open: boolean): void {
        this.toggleAttribute('data-open', open);
    }

    /**
     * Setup all event listeners for the mega menu
     */
    private setupEventListeners(): void {
        this.setupClickListeners();
        this.setupKeyboardListeners();
        this.setupScrollListener();
        this.setupDropdownItemListeners();
        this.setupNonDropdownItemListeners();
    }

    /**
     * Close any open dropdown when the user scrolls the page.
     */
    private setupScrollListener(): void {
        const scrollHandler = () => {
            if (this.hasAttribute('data-open')) {
                this.closeOpenDropdown();
            }
        };

        window.addEventListener('scroll', scrollHandler, { passive: true });
        this.eventListeners.push({
            element: window,
            event: 'scroll',
            handler: scrollHandler,
        });
    }

    /**
     * Setup click event listeners for close buttons and outside clicks
     */
    private setupClickListeners(): void {
        // Close button click handler
        const closeButtonHandler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const closeButton =
                target.closest(MEGA_MENU_CONFIG.SELECTORS.CLOSE_BUTTON) ||
                target.matches(MEGA_MENU_CONFIG.SELECTORS.CLOSE_BUTTON);

            if (closeButton) {
                this.closeOpenDropdown();
            }
        };

        // Outside click handler
        const outsideClickHandler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!this.contains(target) && this.hasAttribute('data-open')) {
                this.closeOpenDropdown();
            }
        };

        this.addEventListener('click', closeButtonHandler);
        document.addEventListener('click', outsideClickHandler);

        // Store for cleanup
        this.eventListeners.push(
            { element: this, event: 'click', handler: closeButtonHandler },
            { element: document, event: 'click', handler: outsideClickHandler },
        );
    }

    /**
     * Setup keyboard event listeners
     */
    private setupKeyboardListeners(): void {
        const keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.hasAttribute('data-open')) {
                this.closeOpenDropdown();
            }
        };

        document.addEventListener('keydown', keydownHandler);
        this.eventListeners.push({
            element: document,
            event: 'keydown',
            handler: keydownHandler,
        });
    }

    /**
     * Setup event listeners for dropdown items
     */
    private setupDropdownItemListeners(): void {
        const dropdownItems = this.querySelectorAll<HTMLElement>(
            MEGA_MENU_CONFIG.SELECTORS.DROPDOWN_ITEMS,
        );

        dropdownItems.forEach((item) => {
            const mouseEnterHandler = (e: MouseEvent) => {
                // Clear any pending close timeout
                if (this.hoverTimeout) {
                    clearTimeout(this.hoverTimeout);
                    this.hoverTimeout = null;
                }

                const target = e.target as HTMLElement;
                if (!target.closest(MEGA_MENU_CONFIG.SELECTORS.OPEN_DROPDOWN)) {
                    this.toggleDropdown(item);
                }
            };

            const mouseLeaveHandler = () => {
                // Clear any existing timeout
                if (this.hoverTimeout) {
                    clearTimeout(this.hoverTimeout);
                }

                // Set a delay before closing to allow mouse to move to submenu
                this.hoverTimeout = window.setTimeout(() => {
                    // Check if mouse is still not over the mega menu
                    if (!this.matches(':hover')) {
                        this.toggleDropdown(item, false);
                    }
                }, MEGA_MENU_CONFIG.TIMING.HOVER_DELAY);
            };

            const focusInHandler = (e: FocusEvent) => {
                const target = e.target as HTMLElement;
                if (!target.closest(MEGA_MENU_CONFIG.SELECTORS.OPEN_DROPDOWN)) {
                    this.toggleDropdown(item);
                }
            };

            const focusOutHandler = (e: FocusEvent) => {
                const relatedTarget = e.relatedTarget as HTMLElement;
                if (
                    !item.contains(relatedTarget) &&
                    !relatedTarget?.closest(
                        MEGA_MENU_CONFIG.SELECTORS.DROPDOWN_ITEMS,
                    )
                ) {
                    this.toggleDropdown(item, false);
                }
            };

            const clickHandler = () => {
                if (!item.hasAttribute('data-open')) {
                    (this.querySelector(':focus') as HTMLElement)?.blur();
                }
            };

            // Add event listeners
            item.addEventListener('mouseenter', mouseEnterHandler);
            item.addEventListener('mouseleave', mouseLeaveHandler);
            item.addEventListener('focusin', focusInHandler);
            item.addEventListener('focusout', focusOutHandler);
            item.addEventListener('click', clickHandler);

            // Store for cleanup
            this.eventListeners.push(
                {
                    element: item,
                    event: 'mouseenter',
                    handler: mouseEnterHandler,
                },
                {
                    element: item,
                    event: 'mouseleave',
                    handler: mouseLeaveHandler,
                },
                { element: item, event: 'focusin', handler: focusInHandler },
                { element: item, event: 'focusout', handler: focusOutHandler },
                { element: item, event: 'click', handler: clickHandler },
            );
        });
    }

    /**
     * Setup event listeners for non-dropdown menu items
     * These should close any open submenus when hovered
     */
    private setupNonDropdownItemListeners(): void {
        const nonDropdownItems = this.querySelectorAll<HTMLElement>(
            MEGA_MENU_CONFIG.SELECTORS.NON_DROPDOWN_ITEMS,
        );

        nonDropdownItems.forEach((item) => {
            const mouseEnterHandler = () => {
                // Clear any pending close timeout
                if (this.hoverTimeout) {
                    clearTimeout(this.hoverTimeout);
                    this.hoverTimeout = null;
                }

                // Close any open dropdown when hovering over non-dropdown items
                this.closeOpenDropdown();
            };

            item.addEventListener('mouseenter', mouseEnterHandler);

            // Store for cleanup
            this.eventListeners.push({
                element: item,
                event: 'mouseenter',
                handler: mouseEnterHandler,
            });
        });
    }

    /**
     * Close the currently open dropdown
     */
    private closeOpenDropdown(): void {
        const openItem = this.querySelector<HTMLElement>(
            MEGA_MENU_CONFIG.SELECTORS.OPEN_DROPDOWN,
        );
        if (openItem) {
            this.toggleDropdown(openItem, false);
            (this.querySelector(':focus') as HTMLElement)?.blur();
        }
    }

    /**
     * Cleanup when the element is disconnected from the DOM
     */
    disconnectedCallback(): void {
        this.cleanupEventListeners();
    }

    /**
     * Remove all event listeners to prevent memory leaks
     */
    private cleanupEventListeners(): void {
        this.eventListeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.eventListeners = [];

        // Clear any pending hover timeout
        if (this.hoverTimeout) {
            clearTimeout(this.hoverTimeout);
            this.hoverTimeout = null;
        }
    }
}
