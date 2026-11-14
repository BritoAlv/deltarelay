# Dashboard icons

Dashboard UI icons render as local inline SVGs through `web/src/components/Icon.astro`
and `web/src/lib/icons.ts`. Static markup and client-side updates share the same
registry. Unknown names throw rather than silently displaying an unrelated icon.
Icons inherit the theme's text color and are hidden from assistive technology;
their accompanying text or control labels provide the accessible name.

## Brand marks

- GitHub: [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/github.svg)
  (CC0), used for GitHub Codespaces in setup and for remote hosts identified as
  GitHub/Codespaces by supervisor metadata. Unknown/SSH hosts retain a server icon.
- VS Code: [Devicon's plain VS Code SVG](https://github.com/devicons/devicon/blob/master/icons/vscode/vscode-plain.svg)
  (MIT), used for the VS Code editor component.
- OpenCode and OpenAI: the existing provider identity SVGs in
  `web/src/lib/provider-marks.ts`, reused without changing their geometry.
- DeltaRelay: the existing delta identity, drawn as an SVG instead of a font glyph.

Brand marks identify their respective products; they do not imply endorsement.

## Functional icons

Existing suitable line SVGs are retained. Replacements were selected from
[Lucide](https://lucide.dev/icons/): Layout Dashboard for overview, Messages Square
for sessions, Server for hosts, Heart Pulse for the health gate, Network for the
relay, and Panels Top Left for the dashboard browser. Storage uses the database
icon instead of a server icon. Zoom, overflow, disclosure, close, and link controls
use SVG geometry rather than Unicode glyphs. All line icons use the dashboard's
existing 1.6-unit stroke. No remote asset requests or runtime dependency are needed.

### Lucide license

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

### Feather / Devicon license

The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis (Feather-derived Server icon)

Copyright (c) 2015 Konpa (Devicon)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
