# The authored handoff README (Mechanism B)

The section spine below is derived from six real authored handoff documents, not from a
reconstruction. `hdd-spec.js` writes the skeleton; you write the prose.

## Title

Always `# Handoff: <Project> — <Feature>`. The feature half is a human phrase, not the slug:
`Auth System (sign-in, sign-up, recovery, logo)`, `FULL PROJECT`, `Identity & System Graphics`.

## Required, in order

| # | Section | What it must contain |
|---|---|---|
| 1 | `## Overview` | One paragraph: what this is, who uses it, what done looks like. Omit only for whole-project handoffs. |
| 2 | `## About the Design Files` | State up front that the HTML is a **reference, not the shipping artifact**. |
| 3 | `## Fidelity` | The bar. What is exact (spacing, color, type scale, motion) and what is free (data, backend shape). |
| 4 | *scope body* | One of the three forms below. |
| 5 | `## Interactions & Behavior` | hover / focus / active / disabled / loading / empty / error, with duration and easing. |
| 6 | `## State Management` | Local vs shared vs server vs persisted. |
| 7 | `## Design Tokens` | Quick reference; point at `DESIGN.md` or `tokens.json` for the full set. |
| 8 | `## Assets` | Every binary the feature needs, by path. |
| 9 | `## Files (in this bundle)` | The tree. Always last of the required set. |

### The scope body — pick one

- **`## Screens / Views`** + `### N. <Name> — \`/route\`` per screen. Use for app features.
- **`## Surface map — what exists, where it is specified`** — a table. Use for whole-project handoffs.
- **Domain sections** — `## The material model`, `## The Mark — canonical geometry`. Use for design
  systems and identity work, where "screens" is the wrong noun.

## Optional, high value

Include when they apply; each earns its place.

| Section | When |
|---|---|
| `### Route map (recreate the state machine as real routes)` | **whenever the prototype multiplexes screens in one file** — see below |
| `## Recommended build order` | more than ~3 screens, or real dependencies between them |
| `## Key implementation contracts (do not improvise these)` | rules the target must not invent: pricing, permissions, privacy |
| `## Shell layouts (responsive)` | the layout changes shape across breakpoints |
| `## Backend integration` | the feature is not implementable without server work |
| `## Definition of done` | always, if you can make it checkable |
| `## Known non-issues` | the prototype has visible oddities that are intentional |

### The route map is the deliverable

A prototype drives every screen from one state machine and has no routing. The target needs real
routes. Nobody but you can make that mapping — reading the HTML does not give it away, and the
receiving agent will otherwise reproduce the state machine verbatim, which is wrong.

```markdown
| Prototype `screen` | Route | Purpose |
|---|---|---|
| `signin`     | `/sign-in`                    | Email + password login |
| `reset`      | `/forgot-password`            | Request a reset link |
| `setnew`     | `/reset-password?token=…`     | Set a new password from an emailed link |
```

`hdd-spec.js` pre-fills the left column from the screen states it finds. You fill the rest.

### Opt-in only: visual verification

A `## Visual verification` section is **not** part of the stock document — in the sample corpus it
appears only in one project's output, elicited by that user's own tooling rules. `hdd-spec.js`
emits it only under `--verification` / `verification: true`. Do not claim it is standard.

## Writing rules

**Specify algorithms, not adjectives.** Not "shows password strength" but:

> score = count of [len>=8, has lower AND upper, has digit, has symbol];
> `0 -> Very weak / 12% / #ed385c`, `1 -> Weak / 30% / #ed385c`, `2 -> Fair / 55% / #f5945c`,
> `3 -> Good / 78% / #fabd14`, `4 -> Strong / 100% / #75ba75`.

**Factor shared chrome out once**, then reference it per screen:

> All five screens share one glass card (`max-width:400px`, `border-radius:20px`,
> `rgba(255,255,255,.045)` fill, `blur(16px)`, `box-shadow:0 24px 60px rgba(0,0,0,.42)`) centred in
> a shell. Body enters with `fadeUp .4s cubic-bezier(.16,1,.3,1)`.

**Quote copy exactly**, in quotes, including placeholder text and link labels.

**Every number comes from a file you opened this run.** No estimates. No "roughly 16px".

**Self-sufficient.** A developer who was not in the conversation must be able to build from this
README alone. That is the test — apply it before you call the document done.

**Screenshots: ask, default no.** Real bundles ship none.

## Folder layout

```
design_handoff_<feature_slug>/
├── README.md      # this document
├── DESIGN.md      # the full design system, copied
├── prototypes/    # HTML design references
├── reference/     # paste-ready code the developer may lift
└── assets/        # binaries the feature needs
```

`prototypes/` and `reference/` are conventions, not requirements — a design-system handoff may use
`design/` instead. Only `design_handoff_<slug>/` and `README.md` are invariant.
