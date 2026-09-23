# Open Sans

Unmodified normal-width, normal-style Open Sans files from the Google Fonts v44
CSS endpoint, retrieved 2026-09-23 with a desktop Chrome User-Agent:
https://fonts.googleapis.com/css?family=Open+Sans:700,600,400,300&subset=latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese

The application already used this family and these four weights. Serving them
locally removes an external, blocking stylesheet request from every navigation.
The browser CSS's 40 face definitions (four weights, ten Unicode subsets) are
unchanged except for same-origin URLs. They share ten WOFF2 files, copied without
conversion; Cyrillic and the other original subsets are retained. See
`SOURCES.json` for exact URLs, ranges, weights and SHA-256 pins, and `OFL.txt` for
the bundled SIL Open Font License. Do not replace this with the legacy endpoint's
Latin-only TTF response.

Upstream project: https://github.com/googlefonts/opensans
License source: https://github.com/google/fonts/blob/main/ofl/opensans/OFL.txt

When deliberately updating the font, update the files, source/hash pins and
this retrieval note together; verify every weight in the real-browser
`t/integration/local_fonts.js` test. No installation or runtime network fetch
is required.
