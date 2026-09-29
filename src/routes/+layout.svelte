<script lang="ts">
  import { onMount } from "svelte";
  // pdf.js's own stylesheet drives text-layer positioning and selection; using
  // it as-is keeps that behaviour correct across pdfjs-dist upgrades.
  import "pdfjs-dist/web/pdf_viewer.css";
  import "$lib/styles/app.css";
  import { initPlatform } from "$lib/platform";

  let { children } = $props();

  onMount(() => {
    void initPlatform();
  });
</script>

{@render children?.()}
