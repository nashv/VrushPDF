<script lang="ts">
  /**
   * Fillable form fields for one page of the main document.
   *
   * The canvas beneath draws every field as the saved file will show it (see
   * `pdf/forms.ts`), so the controls here are see-through until focused: a
   * text field only becomes an opaque input while it is being typed into, and
   * checkboxes and radios are bare hit targets over their drawn appearance.
   *
   * Typing from focus to blur is one undo step. Escape abandons it.
   */
  import type { PageViewport } from "pdfjs-dist";

  import type { FieldValue } from "$lib/annotations/fields";
  import type { PageEntry } from "$lib/annotations/types";
  import type { FormWidget } from "$lib/pdf/forms";
  import { toViewportRect } from "$lib/pdf/render";
  import { MAIN_DOC } from "$lib/state/doc.svelte";
  import { license } from "$lib/state/license.svelte";
  import type { DocumentTab } from "$lib/state/workspace.svelte";

  let {
    tab,
    entry,
    viewport,
    interactive,
  }: {
    tab: DocumentTab;
    entry: PageEntry;
    viewport: PageViewport;
    /** Only with the Select tool; any other tool draws over the form instead. */
    interactive: boolean;
  } = $props();

  const edits = $derived(tab.edits);
  let widgets = $state.raw<FormWidget[]>([]);

  $effect(() => {
    // Merged-in pages keep their fields as drawn; only the main file's form
    // is registered in the saved document (see `annotations/fields.ts`).
    if (entry.sourceDocId !== MAIN_DOC) {
      widgets = [];
      return;
    }
    let alive = true;
    void tab.doc.widgetsOn(entry.srcIndex).then((found) => {
      if (alive) widgets = found;
    });
    return () => {
      alive = false;
    };
  });

  const valueOf = (w: FormWidget): FieldValue => (w.name in edits.fields ? edits.fields[w.name] : w.initial);

  function box(w: FormWidget) {
    const r = toViewportRect(viewport, w.rect);
    return `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
  }

  /** The field's own size where it sets one; otherwise one that fits the box. */
  function fontPx(w: FormWidget) {
    if (w.fontSize > 0) return w.fontSize * viewport.scale;
    if (w.multiline) return 12 * viewport.scale;
    return Math.max(8, Math.min(w.rect.h * 0.62, 14) * viewport.scale);
  }

  function allowed(): boolean {
    return license.allow("Filling in forms");
  }

  // ----------------------------------------------------------------- text

  function onTextFocus(event: FocusEvent) {
    if (!allowed()) {
      (event.currentTarget as HTMLElement).blur();
      return;
    }
    if (!edits.inGesture) edits.begin("Fill in form");
  }

  function onTextInput(w: FormWidget, event: Event) {
    const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    /*
     * Only typing counts. WebKit's contact AutoFill fills a field it thinks
     * wants a name or an address the moment the page loads, and fires `input`
     * as it does, which would fill the form with the user's details and mark
     * the document unsaved before anyone touched it. `autocomplete="off"`
     * does not stop it; the field not being the one being edited does.
     */
    if (document.activeElement !== input || !edits.inGesture) {
      input.value = String(valueOf(w) ?? "");
      return;
    }
    edits.setField(w.name, input.value);
  }

  function onTextKey(w: FormWidget, event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    if (event.key === "Escape") {
      event.preventDefault();
      edits.cancel();
      input.value = String(valueOf(w) ?? "");
      input.blur();
    } else if (event.key === "Enter" && !w.multiline) {
      event.preventDefault();
      input.blur();
    }
  }

  // --------------------------------------------------------- buttons, choices

  function toggle(w: FormWidget) {
    if (!allowed()) return;
    if (w.kind === "checkbox") edits.setField(w.name, valueOf(w) !== true, "Check box");
    // Radios do not switch off when clicked again, as in every PDF viewer.
    else if (w.kind === "radio" && valueOf(w) !== w.onValue) edits.setField(w.name, w.onValue, "Choose option");
  }

  function onChoice(w: FormWidget, event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (!allowed()) {
      // The control already moved; put it back.
      const current = valueOf(w) as string[];
      for (const option of select.options) option.selected = current.includes(option.value);
      return;
    }
    const chosen = [...select.selectedOptions].map((o) => o.value);
    edits.setField(w.name, chosen, "Choose option");
  }

  const isOn = (w: FormWidget) => (w.kind === "checkbox" ? valueOf(w) === true : valueOf(w) === w.onValue);
</script>

<div class="forms" class:interactive>
  {#each widgets as w (w.id)}
    {#if w.kind === "text"}
      {#if w.multiline}
        <textarea
          class="field-control text"
          style="{box(w)}font-size:{fontPx(w)}px;text-align:{w.align}"
          value={String(valueOf(w) ?? "")}
          maxlength={w.maxLength ?? undefined}
          readonly={!license.canEdit}
          aria-label={w.name}
          spellcheck="false"
          autocomplete="off"
          onfocus={onTextFocus}
          oninput={(event) => onTextInput(w, event)}
          onkeydown={(event) => onTextKey(w, event)}
          onblur={() => edits.end()}
        ></textarea>
      {:else}
        <input
          class="field-control text"
          style="{box(w)}font-size:{fontPx(w)}px;text-align:{w.align}"
          type="text"
          value={String(valueOf(w) ?? "")}
          maxlength={w.maxLength ?? undefined}
          readonly={!license.canEdit}
          aria-label={w.name}
          spellcheck="false"
          autocomplete="off"
          onfocus={onTextFocus}
          oninput={(event) => onTextInput(w, event)}
          onkeydown={(event) => onTextKey(w, event)}
          onblur={() => edits.end()}
        />
      {/if}
    {:else if w.kind === "checkbox" || w.kind === "radio"}
      <button
        type="button"
        class="field-control button"
        class:round={w.kind === "radio"}
        style={box(w)}
        role={w.kind}
        aria-checked={isOn(w)}
        aria-label={w.kind === "radio" ? `${w.name}: ${w.onValue}` : w.name}
        onclick={() => toggle(w)}
      ></button>
    {:else}
      <select
        class="field-control choice"
        class:list={!w.combo}
        style="{box(w)}font-size:{fontPx(w)}px"
        multiple={w.multiSelect}
        size={w.combo ? undefined : Math.max(2, w.options.length)}
        aria-label={w.name}
        onchange={(event) => onChoice(w, event)}
      >
        {#if w.combo && (valueOf(w) as string[]).length === 0}
          <option value="" selected disabled>—</option>
        {/if}
        {#each w.options as option (option.exportValue)}
          <option value={option.exportValue} selected={(valueOf(w) as string[]).includes(option.exportValue)}>
            {option.displayValue}
          </option>
        {/each}
      </select>
    {/if}
  {/each}
</div>

<style>
  /* Above the interaction surface, so a click on a field reaches it; the layer
     itself passes every other click through. */
  .forms {
    position: absolute;
    inset: 0;
    z-index: 6;
    pointer-events: none;
  }

  .field-control {
    position: absolute;
    box-sizing: border-box;
    margin: 0;
    padding: 0 2px;
    border: none;
    border-radius: 2px;
    /* The fill-me tint every PDF reader puts on form fields. */
    background: rgb(0 84 255 / 7%);
    font-family: Helvetica, Arial, sans-serif;
    line-height: 1.15;
    color: transparent;
    caret-color: transparent;
    outline: none;
    user-select: text;
  }

  .forms.interactive .field-control {
    pointer-events: auto;
  }

  .forms.interactive .field-control:hover {
    background: rgb(0 84 255 / 14%);
  }

  /* While typing, the input covers the drawn value and shows its own. */
  .field-control.text:focus,
  .field-control.choice:focus {
    background: #ffffff;
    color: #111111;
    caret-color: auto;
    box-shadow: 0 0 0 2px var(--accent);
  }

  textarea.field-control {
    padding-top: 2px;
    resize: none;
    overflow: hidden;
  }

  .field-control.button {
    cursor: pointer;
  }

  .field-control.button.round {
    border-radius: 50%;
  }

  .field-control.button:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }

  /* A closed dropdown shows the value drawn beneath it; its menu is native. */
  .field-control.choice {
    appearance: none;
    cursor: pointer;
  }

  .field-control.choice.list:focus {
    overflow-y: auto;
  }

  .field-control.choice option {
    color: #111111;
  }
</style>
