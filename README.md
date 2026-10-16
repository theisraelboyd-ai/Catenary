# Catenary

Two-segment catenary model for submarine cable lay: layback, length, angle and
tensioner load against water depth, with the critical water depth (CWD) shown
for each bottom tension.

Open `index.html`. It is a single self-contained file and works offline.

## Layout of the repo

- `index.html` — the whole app. Physics, charts, table and print are hand-written in this file.
- `src/view3d.js` — source for the 3D cable view.
- `tools/build-3d.mjs` — bundles `src/view3d.js` with the parts of three.js it uses
  and inlines the result into `index.html` between the `CAT3D` markers.
- `legacy/` — the v3 desktop and mobile apps, kept for reference.

## Editing the 3D view

    npm install
    npm run build:3d

Only needed after changing `src/view3d.js`. Everything else is edited directly in `index.html`.

## Physics

The formulas are unchanged from v3. The chute wrap term, r·(90° − θ), is
calibrated rather than pure geometry and was checked against OASYS to within
about a metre. Re-validate before changing it.

Reference: Mamatsopoulos et al. (2020), *Critical Water Depth and Installation
Curves for Submarine Cable Deployment Process*, JMSE 8(11), 838.
