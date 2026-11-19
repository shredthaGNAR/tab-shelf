// @ts-check
import { defineConfig } from "astro/config";

// Served from GitHub Pages at https://shredthagnar.github.io/tab-shelf/.
// SITE_URL / BASE_PATH can override this for a custom domain.
export default defineConfig({
  site: process.env.SITE_URL || "https://shredthagnar.github.io",
  base: process.env.BASE_PATH ?? "/tab-shelf",
  trailingSlash: "ignore",
});
