<script lang="ts">
  import { onMount } from "svelte";
  // pdf.js's own stylesheet drives text-layer positioning and selection; using
  // it as-is keeps that behaviour correct across pdfjs-dist upgrades.
  import "pdfjs-dist/web/pdf_viewer.css";
  import "$lib/styles/app.css";
  import { initPlatform } from "$lib/platform";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  let { children } = $props();

  onMount(() => {
    void initPlatform();
    /*
     * The window starts hidden (tauri.conf.json): a webview paints white until
     * the stylesheet arrives, which flashed in dark mode. Show it once a styled
     * frame is on screen — two frames, so the first has actually been painted.
     * The Rust side shows it anyway after a few seconds if this never runs.
     */
    if ("__TAURI_INTERNALS__" in window) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void getCurrentWindow().show().catch(() => {})),
      );
    }
  });
</script>

{@render children?.()}
