<script lang="ts" module>
  /** Exported so callers can type their own icon-name tables. */
  export type IconName =
    | "open" | "save" | "save-as" | "save-flattened" | "optimize" | "print" | "undo" | "redo"
    | "cursor" | "hand" | "text" | "highlight" | "underline" | "strikeout" | "squiggly"
    | "pen" | "eraser" | "square" | "circle" | "line" | "arrow" | "textbox" | "note"
    | "stamp" | "signature"
    | "zoom-in" | "zoom-out" | "fit-width" | "fit-page"
    | "sidebar" | "inspector" | "thumbnails" | "list" | "outline" | "search"
    | "rotate-cw" | "rotate-ccw" | "trash" | "plus" | "merge" | "scissors"
    | "chevron-left" | "chevron-right" | "chevron-up" | "chevron-down" | "close" | "check"
    | "front" | "warning" | "file" | "lock"
    | "split" | "watermark" | "header-footer" | "two-page" | "reading-mode" | "presentation"
    | "ruler" | "command" | "align-left" | "align-center" | "align-right"
    | "align-top" | "align-middle" | "align-bottom" | "distribute-h" | "distribute-v";
</script>

<script lang="ts">
  /**
   * Inline icon set. Kept as one 24x24 stroked path table so every icon shares
   * a single visual weight and no runtime font or sprite fetch is needed.
   */
  let { name, size = 16 }: { name: IconName; size?: number } = $props();

  const paths: Record<IconName, string> = {
    open: "M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
    save: "M5 3h11l3 3v15H5Z M8 3v6h7V3 M8 17h8",
    "save-as": "M5 3h9l4 4v8H5Z M8 3v5h6V3 M14 21l3-3 3 3-3 3Z M17 15v6",
    "save-flattened": "M5 3h11l3 3v15H5Z M8 3v6h7V3 M8 15h8 M8 18h8",
    optimize: "M4 4h16 M4 20h16 M12 7v10 M9 10l3-3 3 3 M9 14l3 3 3-3",
    print: "M6 9V3h12v6 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v7H6Z",
    undo: "M4 10h9a5 5 0 0 1 0 10H8 M4 10l4-4 M4 10l4 4",
    redo: "M20 10h-9a5 5 0 0 0 0 10h5 M20 10l-4-4 M20 10l-4 4",
    cursor: "M5 3l14 8-6 1.5L9.5 19Z",
    hand: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11 M11 11V4.5a1.5 1.5 0 0 1 3 0V11 M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6H10a5 5 0 0 1-5-5v-4a1.5 1.5 0 0 1 3 0",
    text: "M5 6h14 M5 6v-1h14v1 M12 5v14 M9 19h6",
    highlight: "M4 20h16 M7 16l8-9 4 3-8 9H7Z",
    underline: "M7 4v7a5 5 0 0 0 10 0V4 M5 20h14",
    strikeout: "M7 5v5a5 5 0 0 0 10 0V5 M4 12h16 M7 14v1a5 5 0 0 0 10 0v-1",
    squiggly: "M6 6h12 M6 12h12 M4 18c1.5-2 3-2 4 0s2.5 2 4 0 2.5-2 4 0",
    pen: "M4 20l1-4 11-11 3 3-11 11Z M14 7l3 3",
    eraser: "M8 20h12 M5 16l7-7 6 6-5 5H8Z M12 9l6 6",
    square: "M4 5h16v14H4Z",
    circle: "M12 5a8 7 0 1 0 0 14 8 7 0 1 0 0-14Z",
    line: "M5 19L19 5",
    arrow: "M5 19L19 5 M19 5h-6 M19 5v6",
    textbox: "M4 5h16v14H4Z M8 9h8 M8 9v-1h8v1 M12 8v8 M10 16h4",
    note: "M5 4h14v11l-4 4H5Z M15 19v-4h4",
    stamp: "M9 4h6v4l2 3H7l2-3Z M5 15h14v4H5Z M5 15l1-4h12l1 4",
    signature: "M3 18c4 0 5-11 8-11s1 8 3 8 2-3 4-3 2 2 3 2",
    "zoom-in": "M10 4a6 6 0 1 0 0 12 6 6 0 1 0 0-12Z M14.5 14.5L20 20 M10 7v6 M7 10h6",
    "zoom-out": "M10 4a6 6 0 1 0 0 12 6 6 0 1 0 0-12Z M14.5 14.5L20 20 M7 10h6",
    "fit-width": "M4 6v12 M20 6v12 M7 12h10 M7 12l2-2 M7 12l2 2 M17 12l-2-2 M17 12l-2 2",
    "fit-page": "M5 4h14v16H5Z M9 9h6v6H9Z",
    sidebar: "M4 4h16v16H4Z M9 4v16",
    inspector: "M4 4h16v16H4Z M15 4v16",
    thumbnails: "M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z",
    list: "M4 6h2 M9 6h11 M4 12h2 M9 12h11 M4 18h2 M9 18h11",
    outline: "M4 5h16 M8 10h12 M8 15h12 M4 20h16",
    search: "M10 4a6 6 0 1 0 0 12 6 6 0 1 0 0-12Z M14.5 14.5L20 20",
    "rotate-cw": "M20 11a8 8 0 1 1-3-6 M20 4v5h-5",
    "rotate-ccw": "M4 11a8 8 0 1 0 3-6 M4 4v5h5",
    trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
    plus: "M12 5v14 M5 12h14",
    merge: "M6 4v6a4 4 0 0 0 4 4h8 M18 14l-3-3 M18 14l-3 3 M6 20v-4",
    scissors: "M7 5l10 12 M17 5L7 17 M6 19a2 2 0 1 0 0 0.1Z M6 5a2 2 0 1 0 0 0.1Z",
    "chevron-left": "M14 6l-6 6 6 6",
    "chevron-right": "M10 6l6 6-6 6",
    "chevron-up": "M6 14l6-6 6 6",
    "chevron-down": "M6 10l6 6 6-6",
    close: "M6 6l12 12 M18 6L6 18",
    check: "M5 13l4 4L19 7",
    front: "M12 4l8 5-8 5-8-5Z M4 14l8 5 8-5",
    warning: "M12 4l9 16H3Z M12 10v5 M12 17.5v.5",
    file: "M6 3h8l4 4v14H6Z M14 3v4h4",
    lock: "M6 10V7a6 6 0 1 1 12 0v3 M4 10h16v11H4Z M12 14v3",
    split: "M4 4h6v16H4Z M14 4h6v16h-6Z M12 2v20",
    watermark: "M12 2.7l6.4 6.3a9 9 0 1 1-12.8 0Z M12 7v10 M7 12h10",
    "header-footer": "M4 3h16 M4 21h16 M4 7h16v10H4Z M8 12h8",
    "two-page": "M4 5h7v14H4Z M13 5h7v14h-7Z",
    "reading-mode": "M12 3a9 9 0 1 0 9 9c0-.5-.04-.98-.12-1.46A7 7 0 0 1 12 3Z",
    presentation: "M3 4h18v12H3Z M12 16v5 M8 21h8 M10 8l5 3-5 3Z",
    ruler: "M3 17l14-14 4 4-14 14H3Z M7 9l2 2 M10 6l2 2 M13 3l2 2 M6 14l2 2",
    command: "M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z",
    "align-left": "M4 4v16 M8 7h12v3H8Z M8 14h8v3H8Z",
    "align-center": "M12 3v18 M6 7h12v3H6Z M8 14h8v3H8Z",
    "align-right": "M20 4v16 M4 7h12v3H4Z M8 14h8v3H8Z",
    "align-top": "M4 4h16 M7 8v12h3V8Z M14 8v8h3V8Z",
    "align-middle": "M3 12h18 M7 6v12h3V6Z M14 8v8h3V8Z",
    "align-bottom": "M4 20h16 M7 4v12h3V4Z M14 8v8h3V8Z",
    "distribute-h": "M4 4v16 M20 4v16 M9 8h6v8H9Z",
    "distribute-v": "M4 4h16 M4 20h16 M8 9v6h8V9Z",
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each paths[name].split(" M") as segment, i (i)}
    <path d={i === 0 ? segment : `M${segment}`} />
  {/each}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
