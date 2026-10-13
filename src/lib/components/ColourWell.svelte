<script lang="ts">
  /**
   * One button showing the current colour; it opens the palette (the preset
   * swatches and a custom colour). Takes a fraction of the toolbar width the
   * swatches did when they were laid out in a row.
   */
  let {
    value,
    swatches,
    label = "Colour",
    onchange,
  }: {
    value: string;
    swatches: string[];
    label?: string;
    onchange: (colour: string) => void;
  } = $props();

  let open = $state(false);

  /** Close on a click elsewhere or Escape, like the stamp and signature menus. */
  function dismiss(node: HTMLElement) {
    const onPointerDown = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") open = false;
    };
    const id = setTimeout(() => document.addEventListener("pointerdown", onPointerDown));
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }
</script>

<span class="well-wrap" {@attach dismiss}>
  <button
    type="button"
    class="colour-well"
    style:--well={value}
    title={label}
    aria-label="{label}: {value}"
    aria-expanded={open}
    onclick={() => (open = !open)}
  ></button>
  {#if open}
    <div class="palette" role="dialog" aria-label={label}>
      <div class="swatches">
        {#each swatches as colour (colour)}
          <button
            type="button"
            class="swatch"
            class:on={value.toLowerCase() === colour}
            style:background={colour}
            title={colour}
            aria-label="Colour {colour}"
            onclick={() => {
              onchange(colour);
              open = false;
            }}
          ></button>
        {/each}
      </div>
      <label class="custom">
        <input type="color" {value} aria-label="Custom colour" oninput={(event) => onchange(event.currentTarget.value)} />
        Custom…
      </label>
    </div>
  {/if}
</span>

<style>
  .well-wrap {
    position: relative;
    display: inline-flex;
    flex: none;
  }

  .colour-well {
    width: 26px;
    height: 22px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
  }

  /* The colour itself, inset so light colours still show an edge. */
  .colour-well::before {
    content: "";
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 3px;
    background: var(--well);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 15%);
  }

  .colour-well:hover,
  .colour-well[aria-expanded="true"] {
    border-color: var(--accent);
  }

  .palette {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    transform: translateX(-50%);
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(4, 22px);
    gap: 6px;
  }

  .swatch {
    width: 22px;
    height: 22px;
    border: 1px solid rgb(0 0 0 / 22%);
    border-radius: 5px;
  }

  .swatch.on {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .custom {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }

  .custom input {
    width: 22px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }
</style>
