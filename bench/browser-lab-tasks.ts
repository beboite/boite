/** Frozen goals for the large-site experiment. Rubrics are evaluated from saved evidence, not model claims. */
export interface LabTask {
  id: string;
  url: string;
  hosts: string[];
  goal: string;
  rubric: string[];
}

export const labTasks: LabTask[] = [
  {
    id: 'github-issue-investigation', url: 'https://github.com/microsoft/playwright/issues', hosts: ['github.com'],
    goal: 'In microsoft/playwright issues, find CLOSED issues labelled browser-chromium, sort by most commented, and open the first matching issue. Report its title, issue number, author, and the total comment count displayed beside that issue in the sorted list, not a count of currently loaded comment nodes. Then inspect the linked author profile in a second tab and report their public display name. Keep both the issue and profile tabs available. Do not sign in, post, react, or change an account.',
    rubric: ['Observed issue search restricts closed issues and browser-chromium label, ordered by most comments.', 'Opened first matching issue and extracted title, number, author and the total comment count displayed in the sorted issue list.', 'Opened that author profile in another tab, extracted public display name, and retained both tabs.'],
  },
  {
    id: 'github-release-download', url: 'https://github.com/microsoft/playwright', hosts: ['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com'],
    goal: 'Starting from the repository, find the latest stable Playwright release, report its version and release date, expand its Assets if needed, and download the Source code (zip) archive. Stop once the file is saved. Do not execute or unpack the downloaded code.',
    rubric: ['Navigated from repository to latest stable release.', 'Reported visible release version and date.', 'Downloaded that release Source code (zip), with nonempty ZIP file saved and linked source URL recorded.'],
  },
  {
    id: 'google-maps-walking', url: 'https://www.google.com/maps', hosts: ['google.com', 'google.fr', 'gstatic.com'],
    goal: 'Find walking directions from Gare de Lyon, Paris, to Musee d Orsay, Paris. Select walking rather than driving or transit, inspect the route details, and report the duration and distance displayed. Keep the selected walking route visible. Decline optional cookies and location access; do not use current location.',
    rubric: ['Correct Paris origin and destination populated.', 'Walking mode selected with an actual route displayed.', 'Reported duration and distance match visible selected route, with route details inspected.'],
  },
  {
    id: 'amazon-product-comparison', url: 'https://www.amazon.fr/', hosts: ['amazon.fr'],
    goal: 'Compare Logitech MX Master 3S and Logitech Lift mice on Amazon France. Use search, open a matching product page for each in separate tabs, and report the exact displayed product name, selected colour, price or explicit unavailability, and seller for each. Keep both product pages available. Do not add to cart, buy, sign in, or change delivery address. Dismiss optional cookies.',
    rubric: ['Search used to locate the two requested mouse models.', 'Two matching product pages retained in separate tabs.', 'Each exact title, selected colour, price or explicit unavailable state, and seller are backed by visible product-page evidence.'],
  },
  {
    id: 'booking-hotel-filters', url: 'https://www.booking.com/', hosts: ['booking.com'],
    goal: 'Search Paris hotels for 12 October 2026 to 15 October 2026, one room for two adults and no children. Filter to 4-star hotels, sort lowest price first, and report the first three matching property names and their displayed total stay prices with currency. Keep the filtered results visible. Do not reserve, sign in, or enter contact/payment details. Dismiss optional cookies and sign-in offers.',
    rubric: ['Paris, exact dates, one room, two adults and zero children confirmed in results.', '4-star filter and lowest-price ordering visibly selected.', 'First three properties and total stay prices with currency match filtered result cards.'],
  },
  {
    id: 'youtube-search-filters', url: 'https://www.youtube.com/', hosts: ['youtube.com', 'google.com'],
    goal: 'Search YouTube for Blender geometry nodes tutorial. Apply the Video type and Over 20 minutes duration filters. Open the first matching video result, expand its description, and report its title, channel, duration, and one sentence from the expanded description. Keep the video page visible and muted. Do not sign in, like, subscribe, comment, or solve a CAPTCHA.',
    rubric: ['Search query and Video / Over 20 minutes filters observed.', 'First matching video opened with title, channel and duration read.', 'Description expanded and reported sentence present in visible description.'],
  },
  {
    id: 'wikipedia-language-history-source', url: 'https://en.wikipedia.org/wiki/Main_Page', hosts: ['wikipedia.org', 'nasa.gov'],
    goal: 'Search for Apollo 11. Open the article, switch it to French through the language interface, open its revision history in a second tab, then return to the French article and open one NASA reference from its references/external links in a third tab. Report the French article title, latest visible revision date, and NASA page title and URL. Keep the article, history and NASA page available. Do not edit anything.',
    rubric: ['Apollo 11 found through search and switched to French through language control.', 'French revision history retained separately and latest visible date reported.', 'A NASA reference opened from that article in a third tab and page title/URL observed; all three tabs retained.'],
  },
  {
    id: 'google-flights-roundtrip', url: 'https://www.google.com/travel/flights', hosts: ['google.com', 'google.fr'],
    goal: 'Find round-trip economy flights from Paris to Lisbon for 12 October 2026 outbound and 15 October 2026 return, for two adults. Restrict to nonstop flights. Select an outbound option and a return option, and report the selected airlines, departure times and displayed total price/currency. Stop at the itinerary or booking-options summary without opening a booking provider, signing in, or buying. Dismiss optional cookies.',
    rubric: ['Paris to Lisbon round trip, exact dates, economy and two adults confirmed.', 'Nonstop filter selected and outbound and return options chosen.', 'Selected itinerary summary supports both airlines, departure times and displayed total price/currency.'],
  },
];
