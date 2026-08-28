# Deploying

The game is a **static site**. There is no server, no API and no database — the
whole thing is HTML, ES modules and assets. That rules out Railway and Render as
the wrong shape: they host services, bill for an always-on container, and give
nothing a static host does not.

Use a static host. Cloudflare Pages, Netlify and Vercel are all free at this
size and all do the same job.

## Build

    npm run build          # writes dist/, ~21 MB

`dist/` is self-contained. It does NOT need node_modules: `tools/build-dist.mjs`
vendors the parts of three the game actually imports into `dist/vendor/` and
rewrites the importmap to point at them. It follows relative imports
transitively — the first version copied a hand-written list, missed
`three.core.js`, and shipped a bundle that served 200 for every file and ran
nothing.

Excluded from `dist/`: `harness/`, `tests/`, `sandbox/`, `tools/`, and the
`_capture` / `_check` shader fixtures (3.4 MB of reference screenshots that are
test data, not game content).

## Deploy

Cloudflare Pages, Netlify and Vercel all take the same two settings:

    build command      npm run build
    output directory   dist

Or upload `dist/` directly with either CLI, no git remote needed:

    npx wrangler pages deploy dist          # Cloudflare
    npx netlify deploy --prod --dir dist    # Netlify

## Check it locally first

`dist/` uses ABSOLUTE paths (`/src/...`, `/assets/...`), so it has to be served
from its own root — opening `dist/index.html` as a file will not work:

    npx http-server dist -p 8080
    # or: python3 -m http.server 8080 --directory dist

## Size

21 MB, of which 18.4 MB is assets: 11 MB of audio and ~7 MB of character and
prop models. If that needs to come down, the audio is the place to look first —
the three tracks are full-length MP3s.
