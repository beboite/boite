# Broad public-site evaluation: 38/84 valid trials passed

Measured on 2026-09-24 with the production loop unchanged. The frozen suite
ran 30 workflows on 23 public sites, three times each. It returned 38 verified
successes out of 90 attempts. Six attempts had defective test criteria;
excluding those gives 38/84, or 45.2%. The plugin is not a reliable replacement
for a general browser agent on this sample.

The [frozen protocol](2026-09-24-browser-wide-protocol.md),
[original task manifest](https://github.com/beboite/boite/blob/2fce81f/bench/browser-wide-tasks.ts)
and [per-attempt results](2026-09-24-browser-wide.json) retain the failures.
No production fix or site-specific action script was introduced between trials.
The earlier [9/9 rerun](2026-09-24-browser-fixed.md) measured three tasks that
guided fixes; it did not predict this broader result.

## Live recordings

These are separate live Jev runs, not action replays. They are excluded from
the timing sample. The recorder shows elapsed time and actual DOM events;
it adds overhead. The GIFs run at normal speed and the links open complete
original recordings. All four published recordings were decoded and their
frames inspected before upload.

Jev enters 7.25 metres and obtains 23.786089239 feet on UnitConverters.

![UnitConverters live conversion](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/64a458e8f31ca56592ecdc86c66a2d13/unitconverters-length-1-pr.gif)

[Complete UnitConverters recording](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/4d970bad018d56f9b6952d467b96c56a/unitconverters-length-1.mp4).

Jev searches ESA, submits Euclid and opens the mission overview.

![ESA live search](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/20742ffe745e697a74934bccba4cead0/esa-euclid-1-pr.gif)

[Complete ESA recording](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/c753fccd25eea3e9ba47a829b409f97e/esa-euclid-1.mp4).
[Complete MDN language-switch recording](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/c9c0a080314454b76b3a2d3e3373a47d/mdn-array-french-1.mp4).

Failure: Calculator.net receives 35, 180 and 75 in the same age field. The
weight stays at its default. The completion check rejects the incorrect result.

![Calculator.net field-selection failure](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/294898f4b0e3e5796de755a06226c607/calculatornet-bmi-1-pr.gif)

[Complete Calculator.net failure recording](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/feae7419aa4c630af0f7dbef49637129/calculatornet-bmi-1.mp4).

Two separate CalculatorSoup recording attempts failed during recorder shutdown
and produced incomplete MP4 files. Both tasks succeeded; both capture failures
remain in the result JSON. The published conversion video uses UnitConverters.

## All 30 workflows

Times are medians of successful attempts only, including browser startup and
initial navigation, excluding final evidence capture and cleanup. An n/a cell
is not a fast failure presented as a speed result.

| Site | Requested workflow | Original success | Successful total median |
| --- | --- | --- | --- |
| Wikipedia | Search Grace Hopper | 3/3 | 3.97 s |
| Wikipedia | Open article revision history | 2/3 | 3.01 s |
| MDN | Find toSorted reference | 3/3 | 4.59 s |
| MDN | Switch Array reference to French | 3/3 | 4.14 s |
| Python documentation | Find pathlib reference | 3/3 | 4.08 s |
| Python documentation | Switch JSON reference to French | 0/3 | n/a |
| The Rust Book | Open borrowing chapter | 3/3 | 2.11 s |
| Go documentation | Reach Effective Go Maps section | 0/3 | n/a |
| npm | Find zod package | 0/3 | n/a |
| crates.io | Find serde crate | 3/3 | 4.13 s |
| PyPI | Find httpx package | 0/3 | n/a |
| Project Gutenberg | Find Pride and Prejudice | 3/3 | 3.38 s |
| Project Gutenberg | Search Austen and open page two | 0/3 | n/a |
| Standard Ebooks | Search author and open Frankenstein | 3/3 | 3.10 s |
| Open Library | Search The Hobbit | 0/3 * | n/a |
| Internet Archive | Search Voynich manuscript | 0/3 | n/a |
| Wikimedia Commons | Search lunar eclipse images | 0/3 * | n/a |
| NASA | Search Euclid | 0/3 | n/a |
| European Space Agency | Search and open Euclid mission | 3/3 | 3.39 s |
| NHS | Find hay fever self-care information | 3/3 | 3.01 s |
| World Health Organization | Switch fact sheet to French | 0/3 | n/a |
| timeanddate | Calculate leap-year duration | 0/3 | n/a |
| timeanddate | Configure 2028 calendar with week numbers | 0/3 | n/a |
| Calculator.net | Fill age, units, height and weight | 0/3 | n/a |
| Calculator.net | Calculate 17% of 240 | 0/3 | n/a |
| CalculatorSoup | Calculate 17% of 240 | 3/3 | 3.79 s |
| UnitConverters.net | Convert 7.25 metres to feet | 3/3 | 2.54 s |
| W3Schools | Set hex colour and inspect RGB | 0/3 | n/a |
| W3Schools | Open startswith reference | 0/3 | n/a |
| W3C | Filter recommendations and open CSS Color 3 | 0/3 | n/a |

* Invalid test criteria, kept in the original 90-attempt record. Commons
renders "Search media" and appends type=image to its results URL; the request
expected a different heading and omitted that parameter. Open Library renders
"J.R.R. Tolkien", while both the request and grader expected spaces between
the initials. All six original attempts reached the intended results.
Correcting only these test criteria and running three fresh attempts per task
produced 6/6 successes. Those follow-ups are recorded separately, not substituted
into the frozen score. The production loop hash is identical across all runs.

## What failed

- Unnamed form fields receive identical action descriptions. Calculator.net
  repeatedly fills one field with values intended for different fields.
- Jev sometimes selects done before any required action: NASA search and the
  first Wikipedia history attempt did this. The plugin's completion gate rejects
  these claims; none of the 90 attempts returned a false verified success.
- W3C exposes 4,151 candidate actions. Jev spends its step budget paging through
  them without applying the requested filter. A bigger list alone does not
  give it enough context to choose the right control.
- Python's language option label does not exactly match either supplied
  string. WHO navigates on language selection before value readback completes.
  The adapter hands both tasks back instead of confirming completion.
- npm, PyPI and both timeanddate tasks expose challenge pages. These are
  access failures in this environment, not evidence about task reasoning.
- Gutenberg pagination, Go section navigation and W3Schools controls also
  fail. Archive and WHO have incomplete loading evidence; the traces cannot
  isolate model, extraction and loading causes in those cases.

## Timing and limits

The 38 successful valid attempts took 0.49-3.59 s
for execution, median 1.40 s. Including startup and initial
navigation, they took 2.03-5.43 s, median 3.38 s.
Failed valid attempts took 2.03-42.30 s including startup.
The original 90 made 391 Jev requests and used 1,751,748 input tokens.
All 102 task runs, including six corrected-criteria follow-ups and six recording
attempts, left zero owned browser processes. The tests validate rendered page
contents; section checks do not establish that the section was scrolled into view.

No GPT arm was rerun on these 30 tasks, so this report makes no comparative
speed or success-rate claim against GPT. The sites and tasks are a selected
sample, not a random sample of the Internet. Logged-in accounts, cross-origin
workflows, uploads, downloads, tabs, drag-and-drop and canvas controls remain
outside the demonstrated capability. The current plugin starts logged out and
hands back when navigation leaves its starting origin.

The practical role supported by these results is a fast helper for bounded,
well-labelled tasks with explicit outcome checks and a main-agent fallback.
Broader use needs richer field context, keyboard/widget support and recovery
from premature completion and navigation races.
