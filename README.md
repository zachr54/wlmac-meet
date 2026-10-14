# WLMAC Meet

Live scoring for WLMAC Fitness Club powerlifting meets: referee lights, attempts, totals, DOTS and IPF GL points. A separate site from the club PWA, sharing its look, its exec logins and its powerlifting events (see *Club app link*).

## Pages

| Page | Who | What |
| --- | --- | --- |
| `director.html` | Exec at the scoring table (laptop) | Create meets, add lifters, enter attempts, call lifters, run the clock, override decisions, export results |
| `display.html?meet=CODE` | Projector / TV computer | Three views: **lights** (lifter, weight, clock, three lights, bar loading), **scoreboard**, **results**. Keys `1` `2` `3` switch views, `F` is full screen, `M` cycles the results ranking |
| `ref.html?meet=CODE` | Each referee's phone | White / red for the lifter on the platform |
| `index.html` | Anyone | Enter a meet code to watch or referee |

## How a meet runs

1. An exec logs in on `director.html`, creates the meet, and adds lifters (one at a time or by pasting a list).
2. **Screens & refs** tab: open a display link on the projector computer; each referee scans their QR code.
3. **Run** tab: enter openers in the sheet, pick lift / round / flight, press **Call next lifter**. Lifters are called lightest bar first, lot number breaking ties.
4. Referees tap white or red. The lights stay hidden until all three are in, then show together; two or more whites is a good lift and the attempt is recorded automatically.
5. The director enters next attempts as lifters hand them in. With auto-advance on, the next lifter is called a few seconds after the lights.

No referee phones? The director's **Good lift** / **No lift** buttons do the same job.

## Setup

1. Run `supabase/schema.sql` in the club's Supabase project (SQL Editor), after the club app's own schema. It adds `pl_*` tables and functions, plus the triggers that link meets to the club app's events.
2. Host this folder as a static site (GitHub Pages works: push the repo, enable Pages on the `main` branch).
3. Execs log in with their club app account (`profiles.role = 'exec'`).

`js/config.js` holds the Supabase URL and anon key. There is no build step.

## Club app link

Meets and the club app's **Powerlifting** events are kept in step by database triggers (the *Club app link* section of `supabase/schema.sql`):

- A Powerlifting event made in the club app gets a meet here; a meet made here goes on the club app's schedule. Renaming or moving the date on either side updates the other.
- Members who sign up for the event are added to the meet's lifters, with their name and grade. The director fills in sex, bodyweight and flight, and openers on the Run tab. If someone with the same name was already typed in, the sign-up is linked to them instead of adding a duplicate.
- Cancelling a sign-up removes that lifter, unless they have already lifted.
- Deleting a meet deletes its event. Deleting the event deletes the meet only if nobody has lifted yet; otherwise the meet and its results are kept.
- When the section is first run, upcoming Powerlifting events and upcoming meets are linked up. Past ones are left alone.

Demo mode doesn't touch the club app.

## Demo mode

Add `?demo=1` to any page (or click *Try the demo meet* on the landing page). Data lives in that browser's localStorage and syncs between its tabs, so you can open the director, a display and three referee pages side by side without touching the database.

## Access

- The meet tables are readable and writable by execs only.
- Displays read through `pl_get_meet(code)`: anyone who knows the meet code can watch, and sees lifter names and bodyweights.
- Referees write through `pl_ref_decide(code, pin, ...)`: they need the meet code and the 6-digit referee PIN. The QR codes contain the PIN.

## Rules built in

- Kilograms, three attempts per lift, formats: full power, bench only, push-pull.
- Weight classes are the IPF classes, worked out from bodyweight.
- Three failed attempts on a lift is a bomb-out (no total, shown as DQ).
- Places are per sex and weight class; ties go to the lighter lifter.
- DOTS and IPF GL use the same coefficients as OpenPowerlifting. GL is not defined for push-pull.
