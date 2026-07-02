---
name: Termina
description: A self-hosted CalDAV calendar PWA — precise and quiet, warmed at the edges
colors:
  ink-black: "#0f1013"
  panel-charcoal: "#16181d"
  graphite-surface: "#1e2028"
  hover-graphite: "#23262f"
  graphite-border: "#2a2d38"
  soft-graphite-border: "#21242e"
  cool-white: "#e8eaf0"
  slate-gray: "#9095a8"
  dim-slate: "#5c6070"
  signal-blue: "#4f7ef8"
  signal-blue-wash: "rgba(79, 126, 248, 0.15)"
  alert-coral: "#f87171"
typography:
  display:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.06em"
  numeric:
    fontFamily: "DM Mono, Fira Code, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  sm: "6px"
  lg: "10px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "9px"
  md: "13px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.slate-gray}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  input:
    backgroundColor: "{colors.graphite-surface}"
    textColor: "{colors.cool-white}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
---

# Design System: Termina

## 1. Overview

**Creative North Star: "The Warm Signal"**

Termina is a dark, quiet workspace with one deliberate point of warmth. The system is built for a single owner doing a fast glance-and-plan loop against their own Nextcloud calendar — every surface stays low-contrast and out of the way (ink-black backgrounds, graphite panels, restrained slate text) so the schedule itself is the only thing competing for attention. Signal Blue is the one color allowed to carry emotional weight: it marks today, the accent action, the thing currently in focus. It is not decoration, it is the system's single named signal in an otherwise hushed field.

This is explicitly not a SaaS admin dashboard, and not a cold developer terminal either. PRODUCT.md calls for "warm and personal, not clinical" — Termina answers that by staying structurally precise (tight radii, mono numerals, minimal chrome) while keeping the emotional register calm and human at the edges: soft hover states, a gentle blue wash rather than hard highlights, generous line-height on body text. It should feel like checking a well-kept desk calendar in low evening light, not opening an ops console. It should also stay legible to the muscle memory of Google Calendar / Apple Calendar — familiar grid, familiar event chips, familiar color-coding — because relearning a calendar is friction the owner never asked for.

**Key Characteristics:**
- Near-black neutral field (ink-black → panel-charcoal → graphite-surface) with almost no saturation outside the accent.
- Exactly one system accent (Signal Blue, #4f7ef8) used sparingly for focus, action, and "today."
- Calendar-native color-coding on events is data-driven, not part of the palette — each Nextcloud calendar owns its own hue.
- DM Sans for everything conversational, DM Mono for anything numeric (times, dates, durations).
- Flat by default; elevation only appears on things that are literally floating above the grid (popups, modals, a dragged event).

## 2. Colors

The palette is almost monochrome on purpose — a tight ramp of near-black neutrals — so that Signal Blue reads as a real signal rather than one hue among several.

### Primary
- **Signal Blue** (`#4f7ef8`): The system's only accent. Used for today's date ring and highlight, links, the primary button, focus rings on inputs, and the active/selected state in the sidebar. Also appears as **Signal Blue Wash** (`rgba(79, 126, 248, 0.15)`) for tinted backgrounds behind selected or "today" cells — never at full opacity as a fill.

### Neutral
- **Ink Black** (`#0f1013`): Root background — `html`, `body`, `#root`. The base the whole app sits on.
- **Panel Charcoal** (`#16181d`): First surface layer up from the void — sidebar, popup shells.
- **Graphite Surface** (`#1e2028`): Second surface layer — inputs, cards, hover-elevated rows.
- **Hover Graphite** (`#23262f`): Interactive hover state for rows and buttons; one visible step lighter than Graphite Surface.
- **Graphite Border** (`#2a2d38`): Default border/divider color for inputs, cards, and panel seams.
- **Soft Graphite Border** (`#21242e`): Quieter divider for internal, low-emphasis separations (e.g. between agenda rows).
- **Cool White** (`#e8eaf0`): Primary text. Never pure white — keeps the whole system in the same cool-neutral family as the backgrounds.
- **Slate Gray** (`#9095a8`): Secondary text — metadata, secondary labels, unselected nav items.
- **Dim Slate** (`#5c6070`): Tertiary text — placeholders, disabled states, the least important label on a row.
- **Alert Coral** (`#f87171`): Reserved for form validation errors only (e.g. login failure). Never used decoratively.

### Named Rules
**The One Signal Rule.** Signal Blue is the only saturated color the design system itself contributes. If a screen needs a second "important" color, that's a sign something should be de-emphasized instead, not a cue to add a second accent.

**The Calendar-Owns-Its-Color Rule.** Event and calendar-list colors come from the user's Nextcloud calendars, not from this palette. They render as a small dot next to the calendar name and as a left edge on event chips/cards (2–3px), mirroring how Google Calendar and Apple Calendar color-code events. This is functional data encoding, not a decorative accent border — don't "fix" it into a flat design or drop it for a solid tint; the color is information the owner relies on to tell calendars apart at a glance.

## 3. Typography

**Display/Body Font:** DM Sans (with system-ui, sans-serif fallback)
**Numeric/Label Font:** DM Mono (with Fira Code, monospace fallback)

**Character:** DM Sans carries every conversational surface — labels, buttons, event titles, body copy — with a geometric-humanist warmth that keeps the dark theme from reading as sterile. DM Mono is reserved for anything that is fundamentally a number: clock times, day numbers, durations. The pairing is one voice speaking two registers, not two competing typefaces.

### Hierarchy
- **Display** (600, 22px, 1.3): Popup and modal titles — the event name at the top of the event popup.
- **Title** (700, 18px, 1.3): Section-level headings inside modals (e.g. "New Event", "Search").
- **Body** (400, 15px, 1.5): Default UI text — the base size set on `html`/`body`. Most labels, descriptions, and form text sit at 13–15px around this baseline.
- **Label** (600, 10px, 0.06em letter-spacing, uppercase): Sidebar section headers ("CALENDARS", etc.) and other structural chrome labels.
- **Numeric** (400, 13px, DM Mono): Time labels on the day/week grid, durations, and any input where the user is typing a date/time.

### Named Rules
**The Numbers-Are-Mono Rule.** Anything that is a clock time, date, or duration renders in DM Mono, even inline in otherwise-Sans text. It gives scannable, tabular alignment to the one kind of content the owner scans fastest.

## 4. Elevation

Termina is flat at rest. Nothing on the calendar grid — day cells, event chips, sidebar rows — casts a shadow; depth there comes from the neutral surface ramp (ink-black → panel-charcoal → graphite-surface), not from lighting effects. Shadows appear only on things that are genuinely floating above the grid: popups, modals, and a dragged event mid-move. That's a deliberate signal — if you see a shadow, something has left the normal flow of the page.

### Shadow Vocabulary
- **Popup** (`box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)`): The event detail popup — a moderate lift, layered for a soft, close-contact shadow plus a tighter contact shadow underneath.
- **Modal** (`box-shadow: 0 24px 48px rgba(0,0,0,0.5)`): Full modals (event form, search) — a much higher lift befitting a surface that blocks the whole screen.
- **Dragging** (`box-shadow: 0 16px 48px rgba(0,0,0,0.6)`): An event card mid-drag — the darkest, most pronounced shadow in the system, so the item being moved is unambiguous.
- **Chrome** (`box-shadow: 0 1px 3px rgba(0,0,0,0.35)`): A hairline lift on small floating chrome (e.g. a raised nav button) — barely there, just enough to separate it from the bar behind it.

### Named Rules
**The Floating-Only Rule.** Shadows are prohibited on anything still part of the normal page flow (cells, chips, sidebar rows, static cards). They're reserved entirely for things temporarily above the grid: popups, modals, drag state.

## 5. Components

### Buttons
- **Shape:** 6px radius (`--radius`), matching inputs and cards — nothing in the system uses a sharper or rounder corner than this without reason.
- **Primary:** Solid Signal Blue background, white text, 600 weight, `9px 16px` padding. Used once per view at most (Save, Log in) — it's the "the one blue thing you should press" affordance.
- **Secondary/Ghost:** Transparent background, Slate Gray text, same 6px radius and padding as primary, no visible border at rest. Used for Cancel and other non-committal actions.
- **Hover/Disabled:** Hover softens via `opacity: 0.88`; disabled drops to `opacity: 0.45` with `cursor: not-allowed`. No color shift on hover — opacity is the only feedback channel, kept intentionally subtle.
- **Icon buttons:** Circular (50% radius), 28–32px square hit area, transparent at rest, Hover Graphite background on hover.

### Inputs / Fields
- **Style:** Graphite Surface background, 1px Graphite Border, 6px radius, `9px 12px` padding, DM Mono for date/time inputs and DM Sans for free text.
- **Focus:** Border color shifts to Signal Blue — no glow, no ring, just a clean color change. Consistent with the system's "opacity/color-shift, not glow" feedback language.
- **Placeholder:** Dim Slate — deliberately quieter than Slate Gray secondary text so a placeholder never gets mistaken for entered content.
- **Error:** Alert Coral text beneath the field; the field border does not change color on error, only the message does.

### Navigation
- **Sidebar:** Panel Charcoal background, 220px fixed width (`--sidebar-w`). Section labels are 10px uppercase Slate Gray/Dim Slate with 0.06em tracking. Nav rows are full-width, transparent at rest, Hover Graphite on hover, Signal Blue Wash + Signal Blue text when active/selected.
- **Calendar list rows:** A colored dot (the calendar's own CalDAV color, see the Calendar-Owns-Its-Color rule) plus a label, `10px` gap, hover reveals a subtle background shift only — the dot color never changes.
- **Topbar:** 52px fixed height (`--topbar-h`), Ink Black background continuing the root surface rather than stepping up a level.

### Event Chips / Cards
- **Corner style:** 6px radius, consistent with buttons and inputs.
- **Color:** A 2–3px colored left edge plus a low-opacity tint of the same calendar color as background — the one sanctioned use of a colored side border in the system, because it's functional (see Named Rules in Colors), not decorative.
- **Elevation:** Flat at rest per the Floating-Only Rule; only lifts (Dragging shadow) while actively being moved.

## 6. Do's and Don'ts

### Do:
- **Do** keep Signal Blue (`#4f7ef8`) as the only system-contributed accent — reserve it for today, focus, links, and the single primary action per view.
- **Do** let per-calendar CalDAV colors own event/calendar-list color; treat them as data, not palette.
- **Do** use DM Mono for any clock time, date, or duration, even inline in Sans text.
- **Do** keep the calendar grid, sidebar rows, and event chips flat — shadows are reserved for popups, modals, and drag state only.
- **Do** default to Google/Apple Calendar-familiar interaction patterns for the core scheduling grid, per PRODUCT.md's "familiar over novel" principle.
- **Do** push warmth through hover states, the accent, and motion — components can stay structurally precise and quiet ("precise and quiet, warmed at the edges") without needing softer shapes to feel human.

### Don't:
- **Don't** add a second saturated system accent alongside Signal Blue — that's what the One Signal Rule exists to prevent.
- **Don't** add decorative `border-left`/`border-right` accents anywhere except the functional per-calendar event-color edge already documented — no colored stripes on cards, alerts, or callouts otherwise.
- **Don't** reach for a generic SaaS admin dashboard look — identical card grids, hero-metric tiles, tiny uppercase eyebrow labels above every section — per PRODUCT.md's anti-references.
- **Don't** let the system drift toward cold "dev tool" starkness. If a new screen feels like an admin panel or a terminal rather than a calendar, that's a regression against "warm and personal."
- **Don't** invent new calendar-grid interaction patterns that require relearning; match Google/Apple Calendar conventions unless there's a concrete reason to diverge.
- **Don't** use glow/ring focus effects — focus and hover feedback in this system is color-shift and opacity only.
