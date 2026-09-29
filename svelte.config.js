// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: {
      name: "adapter-static",
      async adapt(builder) {
        const out = "build";
        builder.rimraf(out);
        builder.mkdirp(out);
        builder.writeClient(out);
        builder.writePrerendered(out);
        if (builder.generateFallback) {
          await builder.generateFallback(`${out}/index.html`);
        }
      },
    },
  },
};

export default config;
