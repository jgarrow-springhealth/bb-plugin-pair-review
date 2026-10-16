# Third-party notices

## bb-plugin-genui

Portions of `ui/kit.tsx` and `ui/findings.tsx` are adapted from
[bb-plugin-genui](https://github.com/ComicBit/bb-plugin-genui) (v0.1.0,
commit `e75404de9cf5`), Copyright ComicBit, licensed under the Apache License,
Version 2.0. A copy of that license is in
[`licenses/bb-plugin-genui-LICENSE`](licenses/bb-plugin-genui-LICENSE).

Adapted components: Metric, SegmentedBar, Tabs, Segmented, Steps, Timeline,
KeyValue, Callout, Disclosure and the Findings report. They were rewritten as
typed React components with explicit props; the spec language, runtime and
entrance animations were removed, and the Findings report reads Pair Review's
own finding data.
