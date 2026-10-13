# WLMAC Meet

Live scoring for WLMAC Fitness Club powerlifting meets: referee lights, attempts, totals, DOTS and IPF GL points. A separate system from the club PWA, sharing its look and its exec logins.

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

1. Run `supabase/schema.sql` in the club's Supabase project (SQL Editor). It only adds `pl_*` tables and functions.
2. Host this folder as a static site (GitHub Pages works: push the repo, enable Pages on the `main` branch).
3. Execs log in with their club app account (`profiles.role = 'exec'`).

`js/config.js` holds the Supabase URL and anon key. There is no build step.

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
