// Serves the exact `/api` path. Subpaths are handled by `[...slug].js` so that
// Vercel always routes `/api/*` to the handler. See `_handler.js`.
export { default } from "./_handler.js"
