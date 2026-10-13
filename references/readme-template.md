# CODING AGENTS: START HERE

This is a **handoff bundle** exported from Open Design.

A designer built these screens as HTML/CSS/JS prototypes, then packaged them so a coding agent can
implement them for real.

## Do this first — IMPORTANT

{{ENTRY_DIRECTIVE}}

**Ask before you build if anything is unclear.** Confirming scope now costs one message; finding
out later that you built the wrong thing costs the whole task.

## About the design files

These are **prototypes, not production code**. The medium is HTML/CSS/JS because it renders
anywhere — it is not a claim about the target stack. Rebuild them **pixel-accurately** in whatever
technology the target codebase already uses: React, Vue, Svelte, SwiftUI, native, whatever fits.
Reproduce the visual result; borrow the prototype's internal structure only where it genuinely
suits the target.

**Do not open these files in a browser or take screenshots unless you are asked to.** Every
dimension, color, spacing rule and easing curve is written down in the source. Read the HTML and
CSS directly — a screenshot cannot tell you anything the source does not, and it costs you a round
trip to find out.
{{DESIGN_SYSTEM}}
## Bundle contents

{{CONTENTS}}

## Sending changes back

This handoff is one leg of a round trip. Once the implementation is running, the codebase can be
synced back into Open Design with [`@ross-sec/sync-od`](https://www.npmjs.com/package/@ross-sec/sync-od),
so the design and the code stay the same thing rather than drifting apart:

```
Open Design  --handoff-dsh-->  your codebase  --sync-od-->  Open Design
```

