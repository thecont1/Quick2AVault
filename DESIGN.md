---
name: Quick2AVault
description: Every rupee a transaction, every transaction evidenced
colors:
  paper: "#FFFFFF"
  control-ghost: "#F7F7FA"
  control-grey: "#F2F2F7"
  hairline: "#E5E5EA"
  hairline-strong: "#D1D1D6"
  ink: "#1C1C1E"
  slate: "#6B6B70"
  fog: "#8E8E93"
  ios-blue: "#0A84FF"
  ledger-green: "#34C759"
  receipt-amber: "#FF9F0A"
  transfer-slate: "#5B6472"
  revenue-mint-fill: "#EAF6EE"
  revenue-mint-hairline: "#CDE9D8"
  revenue-green-deep: "#16663C"
  spend-ice-fill: "#EAF2FD"
  spend-ice-hairline: "#CFE0F7"
  spend-navy: "#1B4F86"
  invest-cream-fill: "#FDF0E6"
  invest-cream-hairline: "#F7DCC5"
  invest-rust: "#9A3412"
  category-discretionary: "#5FBF8F"
  category-eating-out: "#F0A05A"
  category-ordering-in: "#5AA9E6"
  category-groceries: "#A78BFA"
  category-ai-expense: "#E8697D"
  category-rent-utilities: "#F2C94C"
  category-slate-mint: "#7DD3C0"
  category-slate-lavender: "#B8A6E8"
typography:
  display:
    fontFamily: "Unbounded, sans-serif"
    fontWeight: 500
  headline:
    fontFamily: ".AppleSystemUIFont, system-ui"
    fontSize: "20px"
    fontWeight: 700
  title:
    fontFamily: ".AppleSystemUIFont, system-ui"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: ".AppleSystemUIFont, system-ui"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Menlo, monospace"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.04em"
    textTransform: uppercase
  money:
    fontFamily: ".AppleSystemUIFont, system-ui"
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.8px"
    fontFeature: tabular-nums
rounded:
  card: "14px"
  control: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ios-blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "#0074E5"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ios-blue}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input-search:
    backgroundColor: "{colors.control-ghost}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  chip-status:
    backgroundColor: "#EAF4EA"
    textColor: "{colors.ledger-green}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  card-ledger:
    backgroundColor: "{colors.paper}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.card}"
    padding: "18px 20px"
---

# Design System: Quick2AVault

## Overview

**Creative North Star: "The Glass Ledger — scrutable, every entry transparent"**

Quick2AVault is a local-first personal finance vault: every rupee a transaction, every transaction evidenced. The interface behaves like a ledger made of glass — you can always see the entry, the source, and the reasoning behind it. Nothing is hidden behind mystery meat; every number has a path back to a document and every extracted field shows its provenance.

The tone is refined and restrained: an iOS-calm, light surface where precision is the personality. Density is comfortable, not cramped; interaction is quiet; colour is deployed semantically (income mint, spending ice, investment cream) rather than decoratively. The app is a tool for trust — for a household, for shared decisions — so it never performs; it simply shows the truth, legibly.

**Key Characteristics:**
- One window, one place: tabs are selectors over state, never hidden routers.
- Everything is evidence-first: provenance pills, confidence badges, audit trails.
- Money is typographic: tabular figures, right-aligned totals, never reflowing.
- Honest states: disabled = visibly disabled; absent = clearly labelled.
- iOS-native restraint: system UI type, hairline borders, soft tinted fills.

## Colors

The palette is paper-white with three semantic money tints and one blue accent. Color carries meaning (direction, status, category), never decoration.

### Primary
- **iOS Blue** (#0A84FF): the single interactive accent — selected tabs, primary actions, links, active toggle segments. Reserved for "you can act here."

### Secondary
- **Ledger Green** (#34C759): confirmation, analysed/complete states, confidence, success pills.
- **Receipt Amber** (#FF9F0A): review-needed and warning states — the "look at this" signal.

### Tertiary
- **Transfer Slate** (#5B6472): transfers between owned accounts — deliberately neutral, excluded from hero totals.

### Neutral
- **Paper** (#FFFFFF): app background and card surface.
- **Ink** (#1C1C1E): primary text — near-black, never pure black.
- **Slate** (#6B6B70): secondary text, icons, muted labels.
- **Fog** (#8E8E93): tertiary/faint text, placeholders.
- **Control Grey** (#F2F2F7) / **Control Ghost** (#F7F7FA): subtle fills for grouped inputs and hover states.
- **Hairline** (#E5E5EA) / **Hairline Strong** (#D1D1D6): borders and dividers.

### The three money tints (the anchors)
- **Revenue Mint** (fill #EAF6EE, hairline #CDE9D8, deep #16663C): income — hero card, in-direction language.
- **Spend Ice** (fill #EAF2FD, hairline #CFE0F7, deep #1B4F86): spending — hero card, out-direction language.
- **Invest Cream** (fill #FDF0E6, hairline #F7DCC5, deep #9A3412): investments — hero card.
- **Category Swatches**: an 8-tone set (#5FBF8F, #F0A05A, #5AA9E6, #A78BFA, #E8697D, #F2C94C, #7DD3C0, #B8A6E8) for watchlist/category chips — each category owns one hue, applied only as chip fills and chart ramps.

### Named Rules
**The One Voice Rule.** iOS Blue is used on ≤10% of any given screen. Its rarity is the point; when everything is actionable, nothing is.

## Typography

**Display Font:** Unbounded (sans-serif) — the app title and the three money-card headings only.
**Body Font:** .AppleSystemUIFont (system-ui) — everything else; most legible at small sizes.
**Label/Mono Font:** Menlo (monospace) — technical labels, counts, status text, timestamps.

**Character:** A calm pairing: a rounded geometric display face for the two or three moments of identity, and Apple's system face doing all the reading. Mono labels give the ledger its "instrument" texture.

### Hierarchy
- **Display** (Unbounded, ~16–20px, w500): app title and hero card headings. Never for body text.
- **Headline** (20px, w700, -0.3px): page and panel titles ("Document Review", "Financial impact").
- **Title** (15px, w600): document filename row, section lead-ins.
- **Body** (13px, w400, 1.45): primary reading text, list rows.
- **Label** (Menlo, 10.5px, w600, +0.04em, uppercase): counts, chips, status pills, tab badges.
- **Money** (system-ui, 20px, w700, -0.8px, tabular figures): every amount — these must never reflow as digits update.

### Named Rules
**The Tabular Figures Rule.** Every monetary figure uses tabular numerals and is right-aligned in its column. A digit change must never shift the layout.

## Layout

- Single-window shell: a global header row, a horizontal tab bar beneath it, then one active surface. No buried routes.
- The Review surface is a fixed two-pane split: a ~320px document list on the left, the document detail on the right, separated by a hairline vertical divider.
- Page margins: 20px horizontal on headers and shells; 20px padding inside detail panes; rows breathe at 10–12px vertical padding.
- Spacing rhythm: 4 / 8 / 12 / 16 / 20 / 28px steps; 8px is the base gap between related items, 16–20px between sections.
- Density is comfortable: rows are tappable at ≥44px touch height, and long filenames truncate with ellipsis rather than wrapping.
- Lists scroll inside their pane; headers and controls stay fixed.

## Elevation & Depth

Depth is shown with soft, gentle shadows on interactive cards and floating controls — never hard drops, never shadow-on-shadow.

- **Ambient Flat** — default: surfaces sit flat on the paper background, separated only by hairlines and tinted fills.
- **elevated-card** (`0 1px 2px rgba(15,28,45,0.05), 0 6px 18px rgba(15,28,45,0.08)`): interactive cards, dropdown surfaces, and popovers.
- **elevated-float** (`0 2px 8px rgba(15,28,45,0.10), 0 10px 28px rgba(15,28,45,0.12)`): the hire preview card and any surface that must visually detach from the page.

### Named Rules
**The Flat-By-Default Rule.** At rest, nothing casts a shadow. Elevation appears only as a response to state (hover, press, or a floating overlay).

## Shapes

- Corner vocabulary: cards 14px, controls/inputs 10px, everything pill-shaped 999px (chips, badges, segmented ends, dots).
- Borders are 1px hairlines with the tinted hairline of the surface family (mint/ice/cream); selected interactive items use the accent family.
- No arbitrary clipping or decorative geometry — shapes follow the iOS-native rounded-square language.

## Components

### Buttons
- **Shape:** rounded 10px, 1px borderless fill for primary; ghost uses the hairline border.
- **Primary:** iOS Blue fill, white text, 10px × 16px padding; hover deepens to #0074E5; focus ring is a 2px accent outline; press darkens 5%.
- **Secondary / Ghost:** paper fill, iOS Blue text, hairline border; hover tints to control-ghost.
- All buttons use the Title type style (15px w600) and never uppercase body text.

### Chips & Badges
- **Style:** pill (999px), 3px × 10px padding, 10.5px Menlo uppercase, w600.
- **Status:** tinted fill at ~12% of the semantic color + the semantic ink (e.g. ok-green fill, ledger-green text).
- **Selected/filter:** accent tinted fill with iOS Blue text; unselected = control-grey fill, slate text.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** paper, with the semantic tint family for the three hero money cards.
- **Shadow Strategy:** flat by default; elevated-card on interactive card hover.
- **Border:** 1px hairline of the matching family.
- **Internal Padding:** 18–20px; sections inside cards separate at 16px.

### Inputs / Fields
- **Style:** control-ghost fill, hairline border, 10px radius; search and text fields are dense (8px × 12px).
- **Focus:** 2px iOS Blue outline, border shifts to hairline-strong.
- **Dropdown/select:** the whole control is a surfaced field — bordered container, label above at 10.5px Menlo, caret at the right edge; the value never floats away from its affordance.

### Navigation (tab bar)
- **Style:** 13px system text, w500 inactive / w600 active, with a 15px icon at the left.
- **States:** active = iOS Blue text + 2px accent underline; hover = slate; disabled = Fog at 45% opacity with a non-click cursor; badge = iOS Blue pill, white count.

### The Review List Row (signature)
- A rounded 10px row: filename (13px, w500/w600 selected) over a meta line (11px, slate, joined by "·").
- Selected row: 8% accent tint fill, a 3px accent indicator bar, w600 filename — the list and the detail pane must always visibly agree.
- Leading status: an 8px dot — analysys state (green = analysed, hairline-strong = not yet), with a tooltip.

### Pager
- Small chevrons + "1 / 2" in Menlo 11px; disabled end = fog; active = ink; tabular numerals.

## Do's and Don'ts

### Do:
- **Do** keep every amount in tabular figures, right-aligned.
- **Do** show provenance — every extracted field wears a source pill and confidence.
- **Do** keep selected row and detail pane in visual agreement (accent bar + tint).
- **Do** use the semantic tint families for money status; never borrow one card's color for another's meaning.
- **Do** surface honest states: a disabled tab looks disabled; a missing capability is labelled.

### Don't:
- **Don't** use Unbounded for body text or anything below 15px.
- **Don't** use pure black (#000) — ink is #1C1C1E.
- **Don't** shadow resting surfaces; shadows are for hover/float only.
- **Don't** hide actions in a menubar-only router; everything reachable is one click away.
- **Don't** let digits reflow; never change layout width as money updates.
- **Don't** invent status colors — amber means "needs review", green means "confirmed/analysed", blue means "actionable".
