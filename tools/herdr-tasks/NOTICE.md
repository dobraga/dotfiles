# Notice

The scheduling design of `herdr-tasks` (the pure "what should happen right now" decision with catch-up
windows, the wall-clock tick, the append-only run history and the single login service) is ported from
**herdr-automations** (https://github.com/DnzzL/herdr-automations), commit
`05e46298479fc3bca5735e98b34762377017af6b`, files `internal/schedule`, `internal/daemon`,
`internal/history`, `internal/runner` and `internal/service`.

It is rewritten in TypeScript for bun, with a `command` task kind, recorded `skipped` / `late` runs, timeouts,
output tails and a shared task store added. The original is distributed under the MIT licence:

---

MIT License

Copyright (c) herdr-automations contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
