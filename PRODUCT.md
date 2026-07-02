# Product

## Register

product

## Users

Just the developer/owner — a self-hosted calendar built for one person's own daily workflow, syncing against their personal Nextcloud via CalDAV. Not designed for onboarding strangers or a household right now; optimize for the owner's taste and speed over broad legibility.

## Product Purpose

Termina is a self-hosted PWA calendar client. It polls Nextcloud via CalDAV in the background (through a FastAPI backend) and gives the owner a fast day/week/month/agenda view with natural-language event entry, search, and drag-and-drop rescheduling. The core job is a fast glance-and-plan loop: see what's coming up and rearrange it with minimal friction. Success looks like checking or adjusting a schedule faster than opening Google/Apple Calendar would, without giving up control of the underlying data.

## Brand Personality

Warm and personal, not clinical. The interface should feel like a trusted daily companion, not a technical admin panel — even though it's self-hosted infrastructure under the hood. Familiarity matters: lean on conventions from Google Calendar / Apple Calendar so the owner never has to relearn how a calendar works. Note: the current implementation (near-black background, DM Mono, cool blue accent) reads closer to a precise developer tool than "warm." That's a known tension to resolve in future visual passes (`colorize`, `typeset`), not something to silently override here.

## Anti-references

- Generic templated SaaS admin dashboard look (card grids, hero-metric tiles, tiny uppercase eyebrows).
- Overly cold/technical "dev tool" starkness — the existing dark theme should trend warmer and friendlier over time rather than staying purely utilitarian.
- Novel/unfamiliar calendar interaction patterns that require relearning — stay close to Google/Apple Calendar conventions for the core scheduling grid.

## Design Principles

- Fast glance-and-plan: every view should answer "what's next, and can I move it" with minimal steps — speed and low friction beat exhaustive feature surfacing.
- Familiar over novel: default to Google/Apple Calendar conventions for the primary calendar grid and event interactions so the owner's existing muscle memory transfers.
- Warm, not clinical: personality should read as an inviting daily companion, even while running on self-hosted infrastructure — actively counter any "admin panel" or "terminal" coldness in the visuals.
- Single-user optimization: since there is exactly one user, optimize for their speed and taste over generalized onboarding, multi-tenant affordances, or unfamiliar-user hand-holding.

## Accessibility & Inclusion

No specific accessibility accommodations required beyond standard good practice: sufficient color contrast, full keyboard navigation, and not relying on color alone to distinguish calendars/events.
