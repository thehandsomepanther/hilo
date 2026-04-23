import { mount } from 'svelte';
import App from './App.svelte';

// Safari on macOS doesn't include buttons, selects, checkboxes, or radio
// buttons in the Tab order unless they have an explicit tabindex.
const SAFARI_FOCUS_SELECTOR = 'button, select, input[type=checkbox], input[type=radio]';

function patchTabIndex(el: Element): void {
  if (el instanceof HTMLElement && !el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '0');
  }
}

function patchSubtree(root: Element): void {
  patchTabIndex(root);
  root.querySelectorAll(SAFARI_FOCUS_SELECTOR).forEach(patchTabIndex);
}

new MutationObserver((mutations) => {
  for (const { addedNodes } of mutations) {
    for (const node of addedNodes) {
      if (node instanceof Element) {
        if (node.matches(SAFARI_FOCUS_SELECTOR)) patchTabIndex(node);
        node.querySelectorAll(SAFARI_FOCUS_SELECTOR).forEach(patchTabIndex);
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Patch elements already in the DOM at mount time.
document.querySelectorAll(SAFARI_FOCUS_SELECTOR).forEach(patchTabIndex);

const app = mount(App, { target: document.getElementById('app')! });

export default app;
