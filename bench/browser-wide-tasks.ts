/** Public, logged-out workflows. Freeze this manifest before running the model. */
export type WidePredicate =
  | { kind: 'url' | 'visited-url'; equals?: string; pathname?: string; query?: Record<string, string> }
  | { kind: 'text'; contains: string }
  | { kind: 'control'; selector: string; value?: string; checked?: boolean; expanded?: boolean };

export interface WideTask {
  id: string;
  site: string;
  category: string;
  goal: string;
  url: string;
  values: Record<string, string>;
  completion: { text: string; url?: string };
  grader: { all: WidePredicate[] };
}

// Grader selectors describe independently checked outcomes. They are never
// action selectors and must not be included in the model's task request.
export const wideTasks: WideTask[] = [
  {
    id: 'wikipedia-hopper', site: 'Wikipedia', category: 'search',
    goal: 'Search Wikipedia for Grace Hopper and open her biography. Stop on the article discussing her work on COBOL.',
    url: 'https://en.wikipedia.org/wiki/Main_Page', values: { search: 'Grace Hopper' },
    completion: { text: 'COBOL', url: 'https://en.wikipedia.org/wiki/Grace_Hopper' },
    grader: { all: [{ kind: 'url', pathname: '/wiki/Grace_Hopper' }, { kind: 'text', contains: 'COBOL' }] },
  },
  {
    id: 'wikipedia-history', site: 'Wikipedia', category: 'history-navigation',
    goal: 'Open the revision history of the Alan Turing article. Inspect the list of revisions without editing or comparing them.',
    url: 'https://en.wikipedia.org/wiki/Alan_Turing', values: {},
    completion: { text: 'Revision history', url: 'https://en.wikipedia.org/w/index.php?title=Alan_Turing&action=history' },
    grader: { all: [{ kind: 'url', pathname: '/w/index.php', query: { title: 'Alan_Turing', action: 'history' } }, { kind: 'text', contains: 'Revision history' }] },
  },
  {
    id: 'mdn-tosorted', site: 'MDN', category: 'documentation-search',
    goal: 'Find the Array.prototype.toSorted() reference using MDN navigation or search. Stop at its description and syntax.',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', values: { search: 'Array toSorted' },
    completion: { text: 'Syntax', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toSorted' },
    grader: { all: [{ kind: 'url', pathname: '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toSorted' }, { kind: 'text', contains: 'toSorted()' }] },
  },
  {
    id: 'mdn-array-french', site: 'MDN', category: 'language',
    goal: 'Switch the Array reference from English to French using the page language controls.',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array', values: { language: 'Français' },
    completion: { text: 'Description', url: 'https://developer.mozilla.org/fr/docs/Web/JavaScript/Reference/Global_Objects/Array' },
    grader: { all: [{ kind: 'url', pathname: '/fr/docs/Web/JavaScript/Reference/Global_Objects/Array' }, { kind: 'text', contains: 'Array' }] },
  },
  {
    id: 'python-pathlib', site: 'Python documentation', category: 'documentation-search',
    goal: 'Search the Python documentation for pathlib and open its library reference, including the Pure paths section.',
    url: 'https://docs.python.org/3/', values: { search: 'pathlib' },
    completion: { text: 'Pure paths', url: 'https://docs.python.org/3/library/pathlib.html' },
    grader: { all: [{ kind: 'url', pathname: '/3/library/pathlib.html' }, { kind: 'text', contains: 'Pure paths' }] },
  },
  {
    id: 'python-json-french', site: 'Python documentation', category: 'language',
    goal: 'Use the language selector to read the JSON module reference in French. Stop on the translated basic usage section.',
    url: 'https://docs.python.org/3/library/json.html', values: { language: 'French', languageName: 'Français' },
    completion: { text: 'Utilisation de base', url: 'https://docs.python.org/fr/3/library/json.html' },
    grader: { all: [{ kind: 'url', pathname: '/fr/3/library/json.html' }, { kind: 'text', contains: 'Utilisation de base' }] },
  },
  {
    id: 'rust-borrowing', site: 'The Rust Book', category: 'documentation-navigation',
    goal: 'Find References and Borrowing in the Rust book and open the chapter explaining mutable references.',
    url: 'https://doc.rust-lang.org/book/', values: { search: 'References and Borrowing' },
    completion: { text: 'Mutable References', url: 'https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html' },
    grader: { all: [{ kind: 'url', pathname: '/book/ch04-02-references-and-borrowing.html' }, { kind: 'text', contains: 'Mutable References' }] },
  },
  {
    id: 'go-effective-maps', site: 'Go documentation', category: 'section-navigation',
    goal: 'Find Effective Go in the documentation, then use its contents to open the Maps section.',
    url: 'https://go.dev/doc/', values: {},
    completion: { text: 'Maps', url: 'https://go.dev/doc/effective_go#maps' },
    grader: { all: [{ kind: 'url', equals: 'https://go.dev/doc/effective_go#maps' }, { kind: 'text', contains: 'Maps' }] },
  },
  {
    id: 'npm-zod', site: 'npm', category: 'package-search',
    goal: 'Search npm for zod and open the package overview. Do not install anything or sign in.',
    url: 'https://www.npmjs.com/', values: { search: 'zod' },
    completion: { text: 'TypeScript-first schema validation', url: 'https://www.npmjs.com/package/zod' },
    grader: { all: [{ kind: 'url', pathname: '/package/zod' }, { kind: 'text', contains: 'TypeScript-first schema validation' }] },
  },
  {
    id: 'crates-serde', site: 'crates.io', category: 'package-search',
    goal: 'Search crates.io for serde and open its crate overview. Do not download or install it.',
    url: 'https://crates.io/', values: { search: 'serde' },
    completion: { text: 'serialization', url: 'https://crates.io/crates/serde' },
    grader: { all: [{ kind: 'url', pathname: '/crates/serde' }, { kind: 'text', contains: 'serialization' }] },
  },
  {
    id: 'pypi-httpx', site: 'PyPI', category: 'package-search',
    goal: 'Search PyPI for httpx and open its project description. Do not install or download files.',
    url: 'https://pypi.org/', values: { search: 'httpx' },
    completion: { text: 'A next generation HTTP client for Python', url: 'https://pypi.org/project/httpx/' },
    grader: { all: [{ kind: 'url', pathname: '/project/httpx/' }, { kind: 'text', contains: 'A next generation HTTP client for Python' }] },
  },
  {
    id: 'gutenberg-pride', site: 'Project Gutenberg', category: 'catalog-search',
    goal: 'Find Pride and Prejudice by Jane Austen in Project Gutenberg and open its ebook information page. Do not download it.',
    url: 'https://www.gutenberg.org/', values: { search: 'Pride and Prejudice' },
    completion: { text: 'Jane Austen', url: 'https://www.gutenberg.org/ebooks/1342' },
    grader: { all: [{ kind: 'url', pathname: '/ebooks/1342' }, { kind: 'text', contains: 'Pride and Prejudice' }] },
  },
  {
    id: 'gutenberg-austen-page-two', site: 'Project Gutenberg', category: 'search-pagination',
    goal: 'Search Project Gutenberg for Jane Austen, then advance to the second page of results while preserving that search.',
    url: 'https://www.gutenberg.org/ebooks/', values: { search: 'Jane Austen' },
    completion: { text: 'Jane Austen', url: 'https://www.gutenberg.org/ebooks/search/?query=Jane+Austen&start_index=26' },
    grader: { all: [{ kind: 'url', pathname: '/ebooks/search/', query: { query: 'Jane Austen', start_index: '26' } }, { kind: 'visited-url', pathname: '/ebooks/search/', query: { query: 'Jane Austen' } }] },
  },
  {
    id: 'standardebooks-frankenstein', site: 'Standard Ebooks', category: 'catalog-search',
    goal: 'Find Mary Shelley in the Standard Ebooks catalog and open Frankenstein. Stop at the book description without downloading.',
    url: 'https://standardebooks.org/ebooks', values: { search: 'Mary Shelley' },
    completion: { text: 'Frankenstein', url: 'https://standardebooks.org/ebooks/mary-shelley/frankenstein' },
    grader: { all: [{ kind: 'url', pathname: '/ebooks/mary-shelley/frankenstein' }, { kind: 'text', contains: 'Mary Shelley' }] },
  },
  {
    id: 'openlibrary-hobbit', site: 'Open Library', category: 'catalog-search',
    goal: 'Search Open Library for The Hobbit and display the matching catalog entries by J. R. R. Tolkien. Do not borrow, log in, or add anything to a list.',
    url: 'https://openlibrary.org/', values: { search: 'The Hobbit' },
    completion: { text: 'J. R. R. Tolkien', url: 'https://openlibrary.org/search?q=The+Hobbit' },
    grader: { all: [{ kind: 'url', pathname: '/search', query: { q: 'The Hobbit' } }, { kind: 'text', contains: 'The Hobbit' }, { kind: 'text', contains: 'J. R. R. Tolkien' }] },
  },
  {
    id: 'archive-voynich', site: 'Internet Archive', category: 'media-search',
    goal: 'Search the Internet Archive for Voynich manuscript and display the matching items. Do not borrow, download, or play media.',
    url: 'https://archive.org/', values: { search: 'Voynich manuscript' },
    completion: { text: 'Voynich', url: 'https://archive.org/search?query=Voynich+manuscript' },
    grader: { all: [{ kind: 'url', pathname: '/search', query: { query: 'Voynich manuscript' } }, { kind: 'text', contains: 'Voynich' }] },
  },
  {
    id: 'commons-lunar-images', site: 'Wikimedia Commons', category: 'media-search',
    goal: 'Search Wikimedia Commons for Lunar eclipse using Media search and display the results. Do not download files.',
    url: 'https://commons.wikimedia.org/wiki/Main_Page', values: { search: 'Lunar eclipse' },
    completion: { text: 'Media search', url: 'https://commons.wikimedia.org/w/index.php?search=Lunar+eclipse&title=Special%3AMediaSearch' },
    grader: { all: [{ kind: 'url', pathname: '/w/index.php', query: { title: 'Special:MediaSearch', search: 'Lunar eclipse' } }, { kind: 'text', contains: 'Images' }] },
  },
  {
    id: 'nasa-euclid-search', site: 'NASA', category: 'site-search',
    goal: 'Search NASA for Euclid and display its search results. Stop without opening videos or downloads.',
    url: 'https://www.nasa.gov/', values: { search: 'Euclid' },
    completion: { text: 'Search Results for', url: 'https://www.nasa.gov/?search=Euclid' },
    grader: { all: [{ kind: 'url', query: { search: 'Euclid' } }, { kind: 'text', contains: 'Euclid' }] },
  },
  {
    id: 'esa-euclid', site: 'European Space Agency', category: 'site-search',
    goal: 'Find the Euclid mission using ESA navigation or search and open its mission overview.',
    url: 'https://www.esa.int/', values: { search: 'Euclid' },
    completion: { text: 'Euclid', url: 'https://www.esa.int/Science_Exploration/Space_Science/Euclid' },
    grader: { all: [{ kind: 'url', pathname: '/Science_Exploration/Space_Science/Euclid' }, { kind: 'text', contains: 'Euclid' }] },
  },
  {
    id: 'nhs-hay-fever', site: 'NHS', category: 'site-search',
    goal: 'Find the NHS hay fever information page and open its self-care section. This is a navigation task, not a request for personal medical advice.',
    url: 'https://www.nhs.uk/', values: { search: 'hay fever' },
    completion: { text: 'How to treat hay fever yourself', url: 'https://www.nhs.uk/conditions/hay-fever/' },
    grader: { all: [{ kind: 'url', pathname: '/conditions/hay-fever/' }, { kind: 'text', contains: 'How to treat hay fever yourself' }] },
  },
  {
    id: 'who-physical-activity-french', site: 'World Health Organization', category: 'language',
    goal: 'Switch the WHO physical activity fact sheet to French using the language controls.',
    url: 'https://www.who.int/news-room/fact-sheets/detail/physical-activity', values: { language: 'Français' },
    completion: { text: 'Activité physique', url: 'https://www.who.int/fr/news-room/fact-sheets/detail/physical-activity' },
    grader: { all: [{ kind: 'url', pathname: '/fr/news-room/fact-sheets/detail/physical-activity' }, { kind: 'text', contains: 'Activité physique' }] },
  },
  {
    id: 'timeanddate-leap-duration', site: 'timeanddate', category: 'date-calculator',
    goal: 'Calculate the number of days from January 1, 2024 to January 1, 2025. Leave the end date excluded. Stop at the 366-day result.',
    url: 'https://www.timeanddate.com/date/duration.html', values: { day: '1', month: 'January', startYear: '2024', endYear: '2025' },
    completion: { text: '366 days' },
    grader: { all: [{ kind: 'url', pathname: '/date/durationresult.html', query: { d1: '1', m1: '1', y1: '2024', d2: '1', m2: '1', y2: '2025' } }, { kind: 'text', contains: '366 days' }] },
  },
  {
    id: 'timeanddate-calendar', site: 'timeanddate', category: 'calendar-options',
    goal: 'Create a 2028 calendar for the United States with week numbers shown. Do not print, save, or add events.',
    url: 'https://www.timeanddate.com/calendar/', values: { year: '2028', country: 'United States' },
    completion: { text: 'Calendar for Year 2028 (United States)' },
    grader: { all: [{ kind: 'url', pathname: '/calendar/', query: { year: '2028', country: '1', wno: '1' } }, { kind: 'text', contains: 'Calendar for Year 2028 (United States)' }] },
  },
  {
    id: 'calculatornet-bmi', site: 'Calculator.net', category: 'calculator-tabs',
    goal: 'Use Metric Units to calculate BMI for a hypothetical 35-year-old male, 180 cm tall and 75 kg. Stop at the calculated result; do not save it.',
    url: 'https://www.calculator.net/bmi-calculator.html', values: { age: '35', heightCm: '180', weightKg: '75' },
    completion: { text: 'BMI = 23.1' },
    grader: { all: [{ kind: 'text', contains: 'BMI = 23.1' }, { kind: 'control', selector: '#cage', value: '35' }, { kind: 'control', selector: '#cheightmeter', value: '180' }, { kind: 'control', selector: '#ckg', value: '75' }, { kind: 'control', selector: '#csex1', checked: true }, { kind: 'control', selector: '#ctype', value: 'metric' }] },
  },
  {
    id: 'calculatornet-percent', site: 'Calculator.net', category: 'calculator',
    goal: 'Calculate 17 percent of 240 with the percentage calculator. Stop at the result 40.8.',
    url: 'https://www.calculator.net/percent-calculator.html', values: { percent: '17', whole: '240' },
    completion: { text: '40.8' },
    grader: { all: [{ kind: 'text', contains: '40.8' }, { kind: 'control', selector: '#cpar1', value: '17' }, { kind: 'control', selector: '#cpar2', value: '240' }] },
  },
  {
    id: 'calculatorsoup-percent', site: 'CalculatorSoup', category: 'calculator',
    goal: 'Use the What is P% of X calculation to find 17 percent of 240. Stop when the answer 40.8 is displayed.',
    url: 'https://www.calculatorsoup.com/calculators/math/percentage.php', values: { percent: '17', whole: '240' },
    completion: { text: '40.8' },
    grader: { all: [{ kind: 'text', contains: '40.8' }, { kind: 'control', selector: 'input[name="P1"]', value: '17' }, { kind: 'control', selector: 'input[name="X1"]', value: '240' }] },
  },
  {
    id: 'unitconverters-length', site: 'UnitConverters.net', category: 'client-calculator',
    goal: 'Convert 7.25 meters to feet and display the calculated result. Use the converter, not its reference table.',
    url: 'https://www.unitconverters.net/length/meters-to-feet.htm', values: { meters: '7.25' },
    completion: { text: '23.786' },
    grader: { all: [{ kind: 'control', selector: '#ucfrom', value: '7.25' }, { kind: 'text', contains: '23.786' }] },
  },
  {
    id: 'w3schools-color', site: 'W3Schools', category: 'client-state',
    goal: 'Use the HTML color picker to enter #336699 and display its RGB equivalent, rgb(51, 102, 153).',
    url: 'https://www.w3schools.com/colors/colors_picker.asp', values: { color: '#336699' },
    completion: { text: 'rgb(51, 102, 153)' },
    grader: { all: [{ kind: 'control', selector: '#html5colorpicker', value: '#336699' }, { kind: 'text', contains: 'rgb(51, 102, 153)' }] },
  },
  {
    id: 'w3schools-startswith', site: 'W3Schools', category: 'reference-navigation',
    goal: 'Find the Python startswith string method in the method reference and open its syntax and parameter documentation. Do not run example code.',
    url: 'https://www.w3schools.com/python/python_ref_string.asp', values: { search: 'startswith' },
    completion: { text: 'Parameter Values', url: 'https://www.w3schools.com/python/ref_string_startswith.asp' },
    grader: { all: [{ kind: 'url', pathname: '/python/ref_string_startswith.asp' }, { kind: 'text', contains: 'startswith()' }] },
  },
  {
    id: 'w3c-css-recommendation', site: 'W3C', category: 'filters-and-accordion',
    goal: 'Open the advanced filters in W3C standards and drafts. Search for CSS, restrict status to Recommendations, apply the filter, and open CSS Color Module Level 3.',
    url: 'https://www.w3.org/TR/', values: { search: 'CSS' },
    completion: { text: 'CSS Color Module Level 3', url: 'https://www.w3.org/TR/css-color-3/' },
    grader: { all: [{ kind: 'visited-url', pathname: '/TR/', query: { 'filter-tr-name': 'CSS', 'status[]': 'standard' } }, { kind: 'url', pathname: '/TR/css-color-3/' }, { kind: 'text', contains: 'CSS Color Module Level 3' }] },
  },
];
