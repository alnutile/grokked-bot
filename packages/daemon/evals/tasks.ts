/**
 * The eval suite: everyday computer jobs, run against the real stack (daemon,
 * bot computer, live websites) and graded without a human. Run it on every
 * build, and to compare models: `node packages/daemon/bin/eval.ts --model <id>`.
 *
 * Grading is deliberately plain -- substrings and file shapes. A task passes
 * only if the run finished on its own (no ask_human, no cap) AND every check
 * holds. Live sites drift; when one breaks a check for a reason that isn't the
 * bot's fault, fix the check here and say so in the commit.
 *
 * Local pages are served inside the bot's computer from evals/fixtures at
 * http://localhost:8000 (and a basic-auth server on :8001); the runner sets them up, along with
 * the saved logins and the resume file they need.
 */

export interface Check {
  /** Every one of these must appear in the bot's answer (case-insensitive). */
  all?: string[]
  /** At least one of these must appear in the bot's answer. */
  any?: string[]
  /** A file the bot must produce, under /data/work. */
  file?: { path: string; minLines?: number; minHeadings?: number; all?: string[]; any?: string[] }
  /** Secrets that must not appear anywhere in the run: answer, steps or tool results. */
  noLeak?: string[]
  /** Commands run in the bot's computer afterwards (bash -lc); each must exit 0. Grades
   *  what the bot actually left behind, not what it says it did. */
  shell?: string[]
}

export interface EvalTask {
  id: string
  title: string
  /** What it exercises, for the report. */
  tests: string
  goal: string
  domains: string[]
  checks: Check
  max_steps?: number
  max_usd?: number
  timeout_s?: number
  /** Run in the bot's computer before the task (bash -lc), to lay out its starting state. */
  prepare?: string
}

export const SECRETS = { login: 'eval-hunter2-SECRET', google: 'eval-g00gle-SECRET', basic: 'eval-b4sic-SECRET' }

export const TASKS: EvalTask[] = [
  {
    id: 'fec-senate',
    title: 'FEC: top Senate spenders, 2024',
    tests: 'reading a data table',
    goal: 'On https://www.fec.gov/data/spending-bythenumbers/?election_year=2024, who were the top 3 Senate candidates by spending? Give names and amounts.',
    domains: ['fec.gov'],
    checks: { all: ['Cruz'] },
  },
  {
    id: 'fec-house-dropdown',
    title: 'FEC: switch the view to House',
    tests: 'dropdown inside an iframe',
    goal: 'On https://www.fec.gov/data/spending-bythenumbers/?election_year=2024, switch the "Who\'s spending the most" view to House candidates using the page\'s own controls. Who spent the most?',
    domains: ['fec.gov'],
    checks: { all: ['Jeffries'] },
  },
  {
    id: 'wiki-fact',
    title: 'Wikipedia: a fact',
    tests: 'search and read',
    goal: 'Using Wikipedia, who created the Python programming language, and in what year was it first released?',
    domains: ['wikipedia.org'],
    checks: { all: ['Guido', '1991'] },
  },
  {
    id: 'wiki-brief',
    title: 'Wikipedia: write a briefing document',
    tests: 'research + writing a file',
    goal: 'Using Wikipedia, write a one-page briefing on the history of the Linux kernel. Save it as /data/work/out/linux-brief.md with at least three "## " sections and a Sources list of the URLs you used.',
    domains: ['wikipedia.org'],
    checks: { file: { path: 'out/linux-brief.md', minHeadings: 3, all: ['Torvalds', 'wikipedia.org'] } },
  },
  {
    id: 'hn-csv',
    title: 'Hacker News: top 10 to CSV',
    tests: 'scraping into a file',
    goal: 'Get the current top 10 stories on Hacker News (https://news.ycombinator.com) and save them as /data/work/out/hn.csv with the columns rank,title,points,url and a header row.',
    domains: ['ycombinator.com'],
    checks: { file: { path: 'out/hn.csv', minLines: 11, all: ['rank', 'title', 'points'] } },
  },
  {
    id: 'reddit-tech',
    title: 'Reddit: what is hot in r/technology',
    tests: 'a real-world news site',
    goal: 'What are the 5 hottest posts on Reddit\'s r/technology right now? Save their titles and links to /data/work/out/reddit-tech.md, one per line, and tell me the top one.',
    domains: ['reddit.com', 'redd.it'],
    checks: { file: { path: 'out/reddit-tech.md', minLines: 5, any: ['reddit.com', '/r/', 'http'] } },
  },
  {
    id: 'indeed-search',
    title: 'Indeed: find jobs, check how to apply',
    tests: 'a big page, finding the Apply button (no applying)',
    goal: 'Search Indeed for remote Laravel developer jobs. Give me 3 listings with job title and company. For the first one, open it and tell me whether it can be applied to directly on Indeed (an "Apply now" button) or only on the company\'s site. Do not apply to anything.',
    domains: ['indeed.com'],
    checks: { all: ['Laravel'], any: ['apply now', 'company site', "company's site", 'apply on'] },
    max_steps: 40,
  },
  {
    id: 'saved-login',
    title: 'Sign in with a saved password',
    tests: 'the password vault',
    goal: 'Go to http://localhost:8000/login.html, sign in, and tell me exactly what the page says afterwards.',
    domains: [],
    checks: { all: ['Login OK'], noLeak: [SECRETS.login] },
  },
  {
    id: 'google-sso',
    title: 'Sign in with Google (popup)',
    tests: 'single sign-on through a popup window',
    goal: 'Go to http://localhost:8000/sso.html, sign in, and tell me exactly what the page says afterwards.',
    domains: [],
    checks: { all: ['signed in with Google'], noLeak: [SECRETS.google] },
  },
  {
    id: 'http-basic-auth',
    title: 'Sign in through a browser login popup (HTTP basic auth)',
    tests: "the vault, for Chrome's own sign-in popup the bot can't see",
    goal: 'Open the API docs at http://localhost:8001/ and tell me which version they show.',
    domains: [],
    checks: { all: ['2.4.1'], noLeak: [SECRETS.basic] },
  },
  {
    id: 'apply-form',
    title: 'Fill a job application with a resume upload',
    tests: 'form filling: text, dropdown, checkbox, number, file upload',
    goal: 'Fill in and submit the job application at http://localhost:8000/apply.html as: name Ada Lovelace, email ada@example.com, country Canada, 7 years of Laravel experience, and attach the resume at /data/work/inbox/resume.pdf. Accept the privacy policy. Then tell me exactly what the confirmation page says.',
    domains: [],
    checks: { all: ['Application received', 'resume.pdf', 'Canada', 'Ada Lovelace'] },
  },
  {
    id: 'code-fix',
    title: 'Code: fix a failing test and commit',
    tests: 'reading code, the right Node from mise, editing, running tests, git',
    prepare:
      'rm -rf /data/work/repos/calc && mkdir -p /data/work/repos && cp -r /tmp/site/calc /data/work/repos/calc && ' +
      'cd /data/work/repos/calc && git init -q -b main && git add -A && ' +
      'git -c user.name=eval -c user.email=eval@example.com commit -qm "calc"',
    goal: 'The Node project in /data/work/repos/calc has a failing test. Use the Node version the project asks ' +
      'for. Find the bug in the code (not in the tests), fix it, make sure `npm test` passes, and commit the ' +
      'fix on a new branch named fix-add. Tell me which test failed and what you changed.',
    domains: [],
    checks: {
      any: ['add'],
      shell: [
        'cd /data/work/repos/calc && git rev-parse --verify -q fix-add',
        'cd /data/work/repos/calc && git checkout -q fix-add && npm test',
        'cd /data/work/repos/calc && git diff --quiet main fix-add -- calc.test.js',
        'cd /data/work/repos/calc && test -z "$(git status --porcelain)"',
        'mise ls --installed node | grep -q " 22\\."',
      ],
    },
    max_steps: 40,
    max_usd: 2,
  },
]
