<script lang="ts">
  /**
   * A compact typed-in number to sit beside a slider.
   *
   * Commits on Enter, blur or the arrow keys rather than per keystroke, so
   * typing "24" is one undo step instead of "2" then "24". Out-of-range input
   * is clamped; anything unparseable reverts. `factor` converts for display,
   * e.g. 100 shows a 0..1 opacity as a percentage.
   */
  let {
    value,
    min,
    max,
    step = 1,
    factor = 1,
    unit = "",
    label,
    onchange,
  }: {
    value: number;
    /** Limits in displayed units, i.e. after `factor`. */
    min: number;
    max: number;
    step?: number;
    factor?: number;
    unit?: string;
    label: string;
    onchange: (value: number) => void;
  } = $props();

  const round = (n: number) => Math.round(n * 100) / 100;
  const shown = $derived(round(value * factor));

  function commit(input: HTMLInputElement) {
    const n = Number.parseFloat(input.value);
    if (!Number.isFinite(n)) {
      input.value = String(shown);
      return;
    }
    const clamped = round(Math.min(max, Math.max(min, n)));
    input.value = String(clamped);
    if (clamped !== shown) onchange(clamped / factor);
  }

  function onKeydown(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === "Enter") {
      commit(input);
      input.blur();
    } else if (event.key === "Escape") {
      input.value = String(shown);
      input.blur();
    }
  }
</script>

<span class="number-input">
  <input
    type="number"
    inputmode="decimal"
    {min}
    {max}
    {step}
    value={shown}
    aria-label={label}
    title={label}
    onchange={(event) => commit(event.currentTarget)}
    onkeydown={onKeydown}
  />
  {#if unit}<span class="unit">{unit}</span>{/if}
</span>

<style>
  .number-input {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  input {
    width: 46px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
    text-align: right;
    user-select: text;
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .unit {
    font-size: 11px;
  }
</style>
