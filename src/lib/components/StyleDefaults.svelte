<script lang="ts">
  /**
   * The default style of every annotation kind, editable in one place. These
   * are the same styles the toolbar edits while a tool is active, so a change
   * here shows up there and the reverse.
   */
  import { viewer, type StyleKind } from "$lib/state/viewer.svelte";
  import NumberInput from "./NumberInput.svelte";

  const KINDS: { kind: StyleKind; label: string }[] = [
    { kind: "highlight", label: "Highlight" },
    { kind: "underline", label: "Underline" },
    { kind: "strikeout", label: "Strikeout" },
    { kind: "squiggly", label: "Squiggly" },
    { kind: "ink", label: "Pen" },
    { kind: "square", label: "Rectangle" },
    { kind: "circle", label: "Ellipse" },
    { kind: "line", label: "Line" },
    { kind: "arrow", label: "Arrow" },
    { kind: "freetext", label: "Text box" },
    { kind: "check", label: "Tick" },
    { kind: "cross", label: "Cross" },
    { kind: "note", label: "Comment" },
    { kind: "stamp", label: "Stamp" },
    { kind: "redact", label: "Redaction" },
  ];

  /** Which controls each kind actually uses; the rest would do nothing. */
  const HAS_WIDTH = new Set<StyleKind>(["ink", "square", "circle", "line", "arrow", "freetext", "check", "cross"]);
  const HAS_SIZE = new Set<StyleKind>(["freetext", "check", "cross"]);
  const HAS_FILL = new Set<StyleKind>(["square", "circle", "freetext", "redact"]);
  const NO_COLOR = new Set<StyleKind>(["stamp"]);
  const NO_OPACITY = new Set<StyleKind>(["redact"]);
</script>

<div class="defaults" role="table" aria-label="Annotation defaults">
  <div class="head" role="row">
    <span role="columnheader">Annotation</span>
    <span role="columnheader">Colour</span>
    <span role="columnheader">Width</span>
    <span role="columnheader">Size</span>
    <span role="columnheader">Opacity</span>
    <span role="columnheader">Fill</span>
    <span></span>
  </div>
  {#each KINDS as { kind, label } (kind)}
    {@const style = viewer.styles[kind]}
    <div class="row" role="row" data-kind={kind}>
      <span class="name" role="cell">{label}</span>
      <span role="cell">
        {#if !NO_COLOR.has(kind)}
          <input
            type="color"
            value={style.color}
            aria-label="{label} colour"
            oninput={(event) => viewer.setStyle(kind, { color: event.currentTarget.value })}
          />
        {/if}
      </span>
      <span role="cell">
        {#if HAS_WIDTH.has(kind)}
          <NumberInput
            label="{label} {kind === 'freetext' ? 'border' : 'stroke'} width"
            value={style.width}
            min={0}
            max={50}
            step={0.5}
            unit="pt"
            onchange={(width) => viewer.setStyle(kind, { width })}
          />
        {/if}
      </span>
      <span role="cell">
        {#if HAS_SIZE.has(kind)}
          <NumberInput
            label="{label} {kind === 'freetext' ? 'font' : 'mark'} size"
            value={style.fontSize}
            min={1}
            max={200}
            step={0.5}
            unit="pt"
            onchange={(fontSize) => viewer.setStyle(kind, { fontSize })}
          />
        {/if}
      </span>
      <span role="cell">
        {#if !NO_OPACITY.has(kind)}
          <NumberInput
            label="{label} opacity"
            value={style.opacity}
            factor={100}
            min={10}
            max={100}
            unit="%"
            onchange={(opacity) => viewer.setStyle(kind, { opacity })}
          />
        {/if}
      </span>
      <span class="fill" role="cell">
        {#if HAS_FILL.has(kind)}
          <input
            type="checkbox"
            checked={style.fill !== null}
            aria-label="{label} filled"
            disabled={kind === "redact"}
            onchange={(event) =>
              viewer.setStyle(kind, { fill: event.currentTarget.checked ? (kind === "freetext" ? "#ffffff" : style.color) : null })}
          />
          {#if style.fill !== null}
            <input
              type="color"
              value={style.fill}
              aria-label="{label} fill colour"
              oninput={(event) => viewer.setStyle(kind, { fill: event.currentTarget.value })}
            />
          {/if}
        {/if}
      </span>
      <span role="cell">
        <button class="reset" title="Back to the original {label.toLowerCase()} style" onclick={() => viewer.resetStyle(kind)}>
          Reset
        </button>
      </span>
    </div>
  {/each}
</div>

<style>
  .defaults {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 300px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: 1fr 36px 72px 72px 72px 64px 48px;
    align-items: center;
    gap: 6px;
    min-height: 28px;
  }

  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-float);
    color: var(--text-muted);
    font-size: 11px;
  }

  .name {
    font-size: 12px;
  }

  input[type="color"] {
    width: 30px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .fill {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .fill input[type="color"] {
    width: 26px;
  }

  .reset {
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11px;
  }

  .reset:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
</style>
