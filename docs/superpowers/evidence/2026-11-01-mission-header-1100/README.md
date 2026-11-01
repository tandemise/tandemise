# Mission header and step card at 1100px (#132)

Taken by `scratch/mission-header-1100-check.mjs` with `H132_BROWSER=1`: the built renderer in
Playwright's Chromium, against a real daemon, on a step that is really running (a scripted agent,
round 2, so the card has its full action row).

**Not the Electron window.** The run that took these had no display, and `BrowserWindow` crashes
on Electron's headless platform, so the preload bridge is shimmed. Run the script without
`H132_BROWSER` on a machine with a display to prove it in the window itself.

- `header-{1100,1440}-{light,dark}-{closed,open}.png`: after the fix; 61 of 61 checks pass.
- `before-header-1100-light-open.png`: the same run with the CSS change reverted. The actions sit
  in the middle of the open header (their centre at y=202, the title at y=32 to 54).
- `other-missions-1100.png`: a page that shares the header and has no crumbs.
