# Tab Shelf website

The project site, built with [Astro](https://astro.build) and deployed to GitHub Pages by `.github/workflows/site.yml` on every push to `main`.

```
cd site
npm install
npm run dev      # http://localhost:4321/tab-shelf/
npm run build    # static output in site/dist
```

The download button links to `tab-shelf.xpi`, which the workflow builds from `src/` and drops into `site/public/` before building. Locally it only exists if you copy a build there yourself.

Screenshots in `src/assets/shots/` are captures of the real extension pages (light and dark), rendered in Chromium with the mocked browser API from `test/smoke/`.

To serve from a custom domain, set `SITE_URL` and `BASE_PATH=""` in the workflow and add a `public/CNAME`.
