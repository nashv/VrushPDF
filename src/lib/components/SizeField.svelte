<script lang="ts">
  /**
   * A toolbar size control: an icon and a typed number, with the slider one
   * click away under the icon. Keeps the precise typed value in view without
   * spending 70 px of toolbar on a slider for every setting.
   */
  import type { Snippet } from "svelte";
  import NumberInput from "./NumberInput.svelte";

  let {
    label,
    value,
    min,
    max,
    step = 1,
    sliderMin,
    sliderMax,
    factor = 1,
    unit = "",
    icon,
    onchange,
  }: {
    label: string;
    value: number;
    /** Typed limits, in displayed units (after `factor`). */
    min: number;
    max: number;
    step?: number;
    /** The slider's usual range, in stored units; typing can go beyond it. */
    sliderMin: number;
    sliderMax: number;
    factor?: number;
    unit?: string;
    icon: Snippet;
    onchange: (value: number) => void;
  } = $props();

  let open = $state(false);

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

<span class="size-field" title={label} {@attach dismiss}>
  <button
    type="button"
    class="size-icon"
    aria-label="{label} slider"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {@render icon()}
  </button>
  <NumberInput {label} {value} {min} {max} {step} {factor} {unit} {onchange} />
  {#if open}
    <div class="slider-pop" role="dialog" aria-label={label}>
      <input
        type="range"
        min={sliderMin}
        max={sliderMax}
        step={step / factor}
        {value}
        aria-label={label}
        oninput={(event) => onchange(Number(event.currentTarget.value))}
      />
    </div>
  {/if}
</span>

<style>
  .size-field {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 3px;
    color: var(--text-muted);
  }

  .size-icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: inherit;
  }

  .size-icon:hover,
  .size-icon[aria-expanded="true"] {
    background: var(--bg-hover);
    color: var(--text);
  }

  .slider-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    padding: 10px 12px;
    border: 1px solid var(--surface-float-border);
    border-radius: var(--radius-lg);
    background: var(--surface-float);
    backdrop-filter: var(--surface-float-filter);
    box-shadow: var(--shadow-3);
  }

  .slider-pop input {
    width: 160px;
    accent-color: var(--accent);
  }
</style>
