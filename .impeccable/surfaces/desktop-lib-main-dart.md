---
version: 1
slug: "desktop-lib-main-dart"
primary_target: "desktop/lib/main.dart"
related_targets: []
---

# Surface Brief — Quick2AVault app-wide redesign

Scope: whole app (all tabs), Flutter macOS desktop client.
Mode: Operate.
Audience: Mahesh + household; job: trust every number, correct the extraction,
and let corrections teach the system.
Constraints: local-only, originals never altered, auditable provenance for every
field; calm and trustworthy, no hype/gamification; distinct personality, strong
typographic voice.

## Direction contract

THESIS: The app is an orienteering map of the household's money: a fixed,
immutable terrain of documents and entries the user travels with a course of
decisions layered on top. It refuses the generic white card-wall where
everything has equal weight and provenance is hidden in a detail page.

OWN-WORLD: Isom-map inks on a light ground — paper-white runnable forest,
olive thicket for secondary surfaces, yellow open land for highlight bands,
brown contour hairlines for rules and dividers, blue marsh reserved for water
(transfers/neutral), and course purple for the one active decision layer.
Type: condensed sans for control numerals and count figures, small-caps legend
labels in a mono; dense, ruled columns.

STORY: The visitor sees at a glance which documents are terrain (stored,
analysed) and which are the live course (awaiting review, needs decision).
Every figure has a control point behind it; checking a point confirms and
teaches. Nothing disappears — like a map, used controls stay visible and
marked.

FIRST VIEWPORT: Shell: top bar with the purple course legend (counts of
pending/flagged), tab rail beneath. Ledger opens as the home terrain: a ruled
table of transactions with contour hairlines, each row's source/provenance as
a control circle, amounts in condensed tabular numerals. The signature move —
the course layer: a translucent purple "course line" connects the documents
awaiting review down the list, and opening one turns the row's control circle
into a filled control point. Dashboard hero cards become legible map regions
(yellow open land = income, olive = spending, blue = transfers).

FORM: Orienteering map & legend — candidate #2 of the dealt hand (chosen by
user from the decision round). seed:67b8a3bc8d56f4d6

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance
