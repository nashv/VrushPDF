<script lang="ts" generics="T extends string">
  /**
   * A toolbar button that opens a short list of choices, the current one
   * ticked. Replaces buttons that cycled through modes blind.
   *
   * The menu is moved to `<body>` and placed under the button with fixed
   * positioning: the toolbar's top row scrolls on narrow windows, and a
   * scrolling box clips anything that hangs out of it.
   */
  import Icon, { type IconName } from "./Icon.svelte";

  let {
    icon,
    label,
    title,
    value,
    options,
    highlighted = false,
    disabled = false,
    onselect,
  }: {
    icon: IconName;
    /** Short label under the icon when toolbar labels are on. */
    label: string;
    title: string;
    value: T;
    options: { value: T; label: string }[];
    /** Show the button as active (e.g. when a non-default choice is on). */
    highlighted?: boolean;
    disabled?: boolean;
    onselect: (value: T) => void;
  } = $props();

  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let place = $state({ top: 0, left: 0 });

  const current = $derived(options.find((o) => o.value === value)?.label ?? "");

  function toggle() {
    if (!button) return;
    const r = button.getBoundingClientRect();
    place = { top: r.bottom + 6, left: r.left + r.width / 2 };
    open = !open;
  }

  function choose(choice: T) {
    open = false;
    onselect(choice);
    button?.focus();
  }

  /** Live in `<body>`, stay inside the window, and close like any menu. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    const r = node.getBoundingClientRect();
    const overRight = r.right - (window.innerWidth - 8);
    if (overRight > 0) node.style.marginLeft = `${-overRight}px`;
    const overLeft = 8 - r.left;
    if (overLeft > 0) node.style.marginLeft = `${overLeft}px`;
    (node.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!node.contains(target) && !button?.contains(target)) open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        open = false;
        button?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...node.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "ArrowDown" ? at + 1 : at - 1;
        items[(next + items.length) % items.length]?.focus();
      }
    };
    const close = () => (open = false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      node.remove();
    };
  }
</script>

<button
  bind:this={button}
  class="btn square"
  class:selected={highlighted}
  title="{title}: {current}"
  aria-haspopup="menu"
  aria-expanded={open}
  {disabled}
  onclick={toggle}
>
  <Icon name={icon} />
  <span class="btn-label">{label}</span>
</button>

{#if open}
  <div class="menu" role="menu" aria-label={title} style:top="{place.top}px" style:left="{place.left}px" {@attach portal}>
    {#each options as option (option.value)}
      <button
        type="button"
        class="item"
        role="menuitemradio"
        aria-checked={option.value === value}
        onclick={() => choose(option.value)}
      >
        <span class="tick" aria-hidden="true">
          {#if option.value === value}<Icon name="check" size={14} />{/if}
        </span>
        {option.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 70;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px;
    transform: translateX(-50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    -webkit-backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
    color: var(--text);
  }

  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px 0 6px;
    border-radius: var(--radius);
    text-align: left;
    white-space: nowrap;
  }

  .item:hover,
  .item:focus-visible {
    background: var(--bg-hover);
    outline: none;
  }

  .tick {
    display: grid;
    place-items: center;
    width: 16px;
    color: var(--accent);
  }
</style>
